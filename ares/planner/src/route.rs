//! Routing the initial guess around keep-outs.
//!
//! The spline through the user's waypoints knows nothing about obstacles. An
//! interior-point method started from a guess that runs through one has no
//! good side to go around it, and can settle in an absurd local optimum (a
//! robot looping the field for 25 s instead of skirting a circle). Choreo
//! leaves this to the user, who drops empty waypoints by hand; Ares does it
//! itself: every segment whose spline enters a keep-out (grown by the bumper's
//! reach) is replaced by the shortest way around, found with A* on a grid and
//! straightened by line of sight, and the corners become hidden empty
//! waypoints that only shape the guess.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use ares_core::geometry::Vec2;
use ares_core::path::{GeometricPath, Waypoint, WaypointKind};
use ares_core::PathSpec;

/// A circle the guess must stay out of, already grown by the robot's reach.
#[derive(Clone, Copy, Debug)]
pub struct Obstacle {
    pub center: Vec2,
    pub radius: f64,
}

impl Obstacle {
    fn contains(&self, p: Vec2) -> bool {
        (p - self.center).norm() < self.radius
    }

    fn hits_segment(&self, a: Vec2, b: Vec2) -> bool {
        let d = b - a;
        let l2 = d.norm2();
        let t = if l2 > 0.0 { ((self.center - a).dot(d) / l2).clamp(0.0, 1.0) } else { 0.0 };
        (a + d * t - self.center).norm() < self.radius
    }
}

/// Where the guess may go: the field (if walls), minus the obstacles, minus
/// the navgrid's blocked cells when there is one.
pub struct Free {
    pub obstacles: Vec<Obstacle>,
    /// [x0, y0, x1, y1] the robot's center must stay in.
    pub bounds: [f64; 4],
    pub grid: Option<crate::NavGrid>,
}

impl Free {
    fn ok(&self, p: Vec2) -> bool {
        p.x >= self.bounds[0] && p.y >= self.bounds[1] && p.x <= self.bounds[2] && p.y <= self.bounds[3]
            && !self.obstacles.iter().any(|o| o.contains(p))
            && !self.grid.as_ref().is_some_and(|g| g.blocked(p.x, p.y))
    }

    fn sees(&self, a: Vec2, b: Vec2) -> bool {
        if self.obstacles.iter().any(|o| o.hits_segment(a, b)) {
            return false;
        }
        let Some(g) = &self.grid else { return true };
        // Walk the segment finer than a cell, so it cannot step over a
        // corner of one; its ends may sit in a blocked cell (A* lets them).
        let step = (g.node_size_meters / 4.0).max(0.01);
        let n = ((b - a).norm() / step).ceil() as usize;
        (1..n).all(|i| {
            let p = a + (b - a) * (i as f64 / n as f64);
            !g.blocked(p.x, p.y)
        })
    }
}

/// The routed spec, and where each original waypoint ended up in it.
pub struct Routed {
    pub spec: PathSpec,
    pub index_of: Vec<usize>,
}

/// Inserts hidden empty waypoints so the spline clears every obstacle.
/// Segments it cannot route (an end inside an obstacle, no way around) are
/// left alone: the optimizer will say what is wrong.
pub fn route(spec: &PathSpec, free: &Free, rho: f64) -> Routed {
    let mut out = spec.clone();
    out.waypoints.clear();
    let mut index_of = Vec::with_capacity(spec.waypoints.len());
    let colliding = colliding_segments(spec, free, rho);
    for (j, w) in spec.waypoints.iter().enumerate() {
        index_of.push(out.waypoints.len());
        out.waypoints.push(w.clone());
        let Some(next) = spec.waypoints.get(j + 1) else { break };
        // A manual segment is the user's curve: never rerouted.
        if !colliding.contains(&j) || w.manual_next {
            continue;
        }
        let (a, b) = (Vec2::new(w.x, w.y), Vec2::new(next.x, next.y));
        if let Some(corners) = shortest_way(free, a, b) {
            for c in corners {
                out.waypoints.push(Waypoint { x: c.x, y: c.y, kind: Some(WaypointKind::Empty), ..Default::default() });
            }
        }
    }
    // Scoped constraints and events point at original waypoints by index.
    let remap = |t: &mut ares_core::path::Target| {
        if let ares_core::path::Target::Index(i) = t {
            *i = index_of[(*i).min(index_of.len() - 1)];
        }
    };
    for c in &mut out.scoped {
        remap(&mut c.from);
        if let Some(t) = c.to.as_mut() {
            remap(t);
        }
    }
    for e in &mut out.events {
        remap(&mut e.target);
    }
    Routed { spec: out, index_of }
}

/// Segments whose spline enters an obstacle.
fn colliding_segments(spec: &PathSpec, free: &Free, rho: f64) -> Vec<usize> {
    if free.obstacles.is_empty() {
        return vec![];
    }
    let Ok(path) = GeometricPath::build(spec, rho, 0.05) else { return vec![] };
    let mut out = Vec::new();
    for j in 0..path.waypoint_s.len() - 1 {
        let (s0, s1) = (path.waypoint_s[j], path.waypoint_s[j + 1]);
        let hit = path
            .points
            .iter()
            .filter(|p| p.s >= s0 && p.s <= s1)
            .any(|p| free.obstacles.iter().any(|o| o.contains(p.pos)));
        if hit {
            out.push(j);
        }
    }
    out
}

const CELL: f64 = 0.05;

#[derive(PartialEq)]
struct Open {
    f: f64,
    cell: (i32, i32),
}
impl Eq for Open {}
impl Ord for Open {
    fn cmp(&self, o: &Self) -> Ordering {
        o.f.total_cmp(&self.f)
    }
}
impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// The corners of the shortest way from `a` to `b` around the obstacles
/// (endpoints excluded), or None if there is none.
pub fn shortest_way(free: &Free, a: Vec2, b: Vec2) -> Option<Vec<Vec2>> {
    if free.sees(a, b) {
        return Some(vec![]);
    }
    let [x0, y0, x1, y1] = free.bounds;
    let (nx, ny) = (((x1 - x0) / CELL).ceil() as i32 + 1, ((y1 - y0) / CELL).ceil() as i32 + 1);
    let to_cell = |p: Vec2| (((p.x - x0) / CELL).round() as i32, ((p.y - y0) / CELL).round() as i32);
    let to_point = |c: (i32, i32)| Vec2::new(x0 + c.0 as f64 * CELL, y0 + c.1 as f64 * CELL);
    let idx = |c: (i32, i32)| (c.1 * nx + c.0) as usize;
    // Ends right against a wall sit outside the grid (the center is kept a
    // bumper's reach in): start and finish on the nearest cell inside.
    let clamp = |c: (i32, i32)| (c.0.clamp(0, nx - 1), c.1.clamp(0, ny - 1));
    let (start, goal) = (clamp(to_cell(a)), clamp(to_cell(b)));
    let inside = |c: (i32, i32)| c.0 >= 0 && c.1 >= 0 && c.0 < nx && c.1 < ny;
    // The ends may sit on a cell inside an obstacle's grown edge: let A* leave
    // and reach them anyway.
    let passable = |c: (i32, i32)| inside(c) && (c == start || c == goal || free.ok(to_point(c)));

    let mut g = vec![f64::INFINITY; (nx * ny) as usize];
    let mut came = vec![u32::MAX; (nx * ny) as usize];
    let mut open = BinaryHeap::new();
    if !inside(start) || !inside(goal) {
        return None;
    }
    g[idx(start)] = 0.0;
    open.push(Open { f: 0.0, cell: start });
    let h = |c: (i32, i32)| (((c.0 - goal.0) as f64).hypot((c.1 - goal.1) as f64)) * CELL;
    let mut found = false;
    while let Some(Open { cell, .. }) = open.pop() {
        if cell == goal {
            found = true;
            break;
        }
        let gc = g[idx(cell)];
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            let n = (cell.0 + dx, cell.1 + dy);
            if !passable(n) {
                continue;
            }
            let step = if dx != 0 && dy != 0 { CELL * std::f64::consts::SQRT_2 } else { CELL };
            if gc + step < g[idx(n)] {
                g[idx(n)] = gc + step;
                came[idx(n)] = idx(cell) as u32;
                open.push(Open { f: gc + step + h(n), cell: n });
            }
        }
    }
    if !found {
        return None;
    }
    let mut cells = vec![goal];
    let mut c = idx(goal);
    while c != idx(start) {
        c = came[c] as usize;
        cells.push(((c as i32) % nx, (c as i32) / nx));
    }
    cells.reverse();

    // Line of sight: keep only the corners the straight line cannot skip.
    let pts: Vec<Vec2> = std::iter::once(a)
        .chain(cells[1..cells.len() - 1].iter().map(|&c| to_point(c)))
        .chain(std::iter::once(b))
        .collect();
    let mut corners = Vec::new();
    let mut i = 0;
    while i < pts.len() - 1 {
        let mut j = pts.len() - 1;
        while j > i + 1 && !free.sees(pts[i], pts[j]) {
            j -= 1;
        }
        if j < pts.len() - 1 {
            corners.push(pts[j]);
        }
        i = j;
    }
    Some(corners)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> [f64; 4] {
        [0.4, 0.4, 16.1, 7.6]
    }

    #[test]
    fn a_clear_line_needs_no_corners() {
        let free = Free { grid: None, obstacles: vec![], bounds: field() };
        assert_eq!(shortest_way(&free, Vec2::new(1.0, 1.0), Vec2::new(5.0, 5.0)).unwrap().len(), 0);
    }

    #[test]
    fn goes_around_a_circle_and_every_leg_is_clear() {
        let o = Obstacle { center: Vec2::new(5.0, 4.0), radius: 1.5 };
        let free = Free { grid: None, obstacles: vec![o], bounds: field() };
        let (a, b) = (Vec2::new(1.0, 4.0), Vec2::new(9.0, 4.0));
        let corners = shortest_way(&free, a, b).unwrap();
        assert!(!corners.is_empty());
        let pts: Vec<Vec2> = std::iter::once(a).chain(corners.iter().copied()).chain(std::iter::once(b)).collect();
        for w in pts.windows(2) {
            assert!(free.sees(w[0], w[1]), "{:?} -> {:?}", w[0], w[1]);
        }
        // Not absurdly long: the way around a circle is a bit more than the
        // straight line, not a lap of the field.
        let len: f64 = pts.windows(2).map(|w| (w[1] - w[0]).norm()).sum();
        assert!(len < 8.0 * 1.4, "{len}");
    }

    #[test]
    fn routing_inserts_hidden_waypoints_and_remaps_targets() {
        use ares_core::path::{ConstraintKind, ScopedConstraint, Target};
        let mut spec = PathSpec::new(
            "r",
            vec![
                Waypoint { x: 1.0, y: 4.0, heading_deg: Some(0.0), ..Default::default() },
                Waypoint { x: 9.0, y: 4.0, ..Default::default() },
                Waypoint { x: 9.0, y: 7.0, heading_deg: Some(0.0), ..Default::default() },
            ],
        );
        spec.scoped.push(ScopedConstraint { from: Target::Index(1), to: None, enabled: true, kind: ConstraintKind::StopPoint { wait_s: 0.0 }, exprs: Default::default() });
        let free = Free { grid: None, obstacles: vec![Obstacle { center: Vec2::new(5.0, 4.0), radius: 1.0 }], bounds: field() };
        let r = route(&spec, &free, 0.39);
        assert!(r.spec.waypoints.len() > 3);
        assert_eq!(r.index_of[0], 0);
        assert!(r.index_of[1] > 1);
        assert_eq!(r.spec.scoped.last().unwrap().from, Target::Index(r.index_of[1]));
        assert!(r.spec.waypoints[1].kind() == WaypointKind::Empty);
    }
}
