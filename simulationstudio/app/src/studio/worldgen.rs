//! The world generator: `WorldSpec` in, SDF out.
//!
//! # Field names on disk
//!
//! `WorldSpec` and `Prop` are what a managed world's `.studio.json` holds, so
//! their JSON is a file format and not just a message to the UI. The fields
//! used to be named in Spanish (`paso`, `cancha_largo`, ...); every one that
//! changed keeps its old name as a `serde(alias)`, so a world saved by an
//! older Studio still opens --- and is rewritten with the new names the next
//! time it is saved. `old_studio_json_still_reads` is the tripwire.

use serde::{Deserialize, Serialize};

/// A loose object in the world: box, cylinder, sphere or mesh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prop {
    #[serde(alias = "nombre")]
    pub name: String,
    /// `box` | `cylinder` | `sphere` | `mesh`
    #[serde(alias = "forma")]
    pub shape: String,
    /// box: x,y,z --- cylinder: radius,length,_ --- sphere: radius,_,_
    #[serde(alias = "tamano")]
    pub size: [f64; 3],
    #[serde(alias = "masa")]
    pub mass: f64,
    #[serde(rename = "static", alias = "estatico")]
    pub is_static: bool,
    /// x y z roll pitch yaw, in meters and radians (SI, like everything in gz).
    pub pose: [f64; 6],
    pub color: [f64; 4],
    /// Mesh URI when `shape == "mesh"`.
    #[serde(default, alias = "malla")]
    pub mesh: String,
}

/// Everything the World Editor's property tree can change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSpec {
    #[serde(alias = "archivo")]
    pub file: String,
    #[serde(default, alias = "descripcion")]
    pub description: String,

    // Physics
    #[serde(alias = "paso")]
    pub step: f64,
    pub rtf: f64,
    /// `dart` | `bullet-featherstone`
    #[serde(alias = "motor_fisica")]
    pub physics_engine: String,
    #[serde(alias = "gravedad")]
    pub gravity: f64,

    // Ground and field
    #[serde(alias = "suelo")]
    pub ground: bool,
    #[serde(alias = "friccion")]
    pub friction: f64,
    #[serde(alias = "friccion2")]
    pub friction2: f64,
    #[serde(alias = "cancha_largo")]
    pub field_length: f64,
    #[serde(alias = "cancha_ancho")]
    pub field_width: f64,
    #[serde(alias = "color_suelo")]
    pub ground_color: [f64; 4],

    /// The FRC field mesh, relative to `sim/`. Empty = no field.
    ///
    /// It goes in ONLY as a visual. The 2026 field is ~2.9 M triangles: using
    /// it as collision would wreck the real-time factor, which the validity of
    /// the whole loop depends on.
    #[serde(default, alias = "campo")]
    pub field_mesh: String,
    /// x y z roll pitch yaw. The default 90° roll is because the glTF comes
    /// Y-up and Gazebo is Z-up.
    #[serde(default = "default_field_pose", alias = "campo_pose")]
    pub field_pose: [f64; 6],
    #[serde(default = "one", alias = "campo_escala")]
    pub field_scale: f64,

    // --- FUEL (REBUILT's scoring element) ---
    //
    // How many physical balls are seeded. They are NOT the ones the field mesh
    // draws: that one carries 456 FUEL baked in as scenery, with no physics.
    /// Number of FUEL with physics. 0 = none.
    #[serde(default)]
    pub fuel: usize,
    /// Width and depth of the box they are seeded in, in meters. The default
    /// is the manual's NEUTRAL ZONE: 206.0 x 72.0 in.
    #[serde(default = "default_fuel_area")]
    pub fuel_area: [f64; 2],
    /// Center of that box. (0,0) is the center of the field, i.e. the center
    /// line, which is where the manual puts them.
    #[serde(default, alias = "fuel_centro")]
    pub fuel_center: [f64; 2],
    /// Drop height above the floor. 0 = resting on it.
    #[serde(default, alias = "fuel_altura")]
    pub fuel_height: f64,

    // Perimeter
    #[serde(alias = "muros")]
    pub walls: bool,
    #[serde(alias = "muro_alto")]
    pub wall_height: f64,
    #[serde(alias = "muro_grosor")]
    pub wall_thickness: f64,

    // Light and scene
    #[serde(alias = "sol")]
    pub sun: bool,
    #[serde(alias = "sombras")]
    pub shadows: bool,
    #[serde(alias = "sol_direccion")]
    pub sun_direction: [f64; 3],
    #[serde(alias = "sol_intensidad")]
    pub sun_intensity: f64,
    #[serde(alias = "ambiente")]
    pub ambient: f64,
    #[serde(alias = "fondo")]
    pub background: [f64; 3],

    // Optional world plugins
    #[serde(alias = "comandos_usuario")]
    pub user_commands: bool,
    #[serde(alias = "sensores")]
    pub sensors: bool,
    pub imu_system: bool,
    #[serde(default, alias = "plugins_extra")]
    pub extra_plugins: Vec<String>,

    // Robot
    /// URI of an `<include>`, or empty to include none.
    #[serde(default)]
    pub robot_uri: String,
    #[serde(default)]
    pub robot_pose: [f64; 6],

    #[serde(default)]
    pub props: Vec<Prop>,
}

pub(super) fn default_field_pose() -> [f64; 6] {
    [0.0, 0.0, 0.0, std::f64::consts::FRAC_PI_2, 0.0, 0.0]
}

fn one() -> f64 {
    1.0
}

/// The NEUTRAL ZONE: 206.0 in x 72.0 in (REBUILT manual, 6.3.4.1).
pub(super) fn default_fuel_area() -> [f64; 2] {
    [5.23, 1.83]
}

/// FUEL radius, from `models/fuel/model.sdf`. It is needed here to place
/// them without overlapping; it is duplicated on purpose and with this note,
/// because the generator does not parse the model.
const FUEL_RADIUS: f64 = 0.075;

/// 2 cm of air between ball and ball. Being born in exact contact already
/// counts as a collision for the solver, and a contact that exists from step
/// zero is energy the engine has to take from somewhere.
const FUEL_GAP: f64 = 0.02;

fn f(v: f64) -> String {
    // No scientific notation and no extra zeros: an SDF gets read by hand.
    let s = format!("{v:.6}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() || s == "-" || s == "-0" {
        "0".into()
    } else {
        s
    }
}

fn pose(p: &[f64; 6]) -> String {
    p.iter().map(|v| f(*v)).collect::<Vec<_>>().join(" ")
}

/// Writes the SDF. It is a template, not a full SDF serializer: it covers
/// what the property tree offers and nothing more.
pub fn generate_sdf(s: &WorldSpec) -> String {
    let mut o = String::new();
    o.push_str("<?xml version=\"1.0\" ?>\n");
    o.push_str("<!--\n");
    o.push_str("  Generated by MARS Simulation Studio. The .studio.json next to this\n");
    o.push_str("  file holds the properties that produced it; editing this SDF by hand\n");
    o.push_str("  is fine, but regenerating from the editor overwrites it.\n");
    if !s.description.trim().is_empty() {
        o.push_str(&format!("\n  {}\n", s.description.trim().replace("--", "- -")));
    }
    o.push_str("-->\n");
    // The world name is a contract: gz-sim's standard topics carry it embedded
    // (/world/mars/clock) and protocol/check.py verifies it.
    o.push_str("<sdf version=\"1.11\">\n  <world name=\"mars\">\n\n");

    o.push_str(&format!(
        "    <physics name=\"studio\" type=\"ignored\">\n      <max_step_size>{}</max_step_size>\n      <real_time_factor>{}</real_time_factor>\n    </physics>\n\n",
        f(s.step),
        f(s.rtf)
    ));

    o.push_str(
        "    <plugin filename=\"gz-sim-physics-system\" name=\"gz::sim::systems::Physics\">\n",
    );
    if s.physics_engine != "dart" {
        o.push_str(&format!(
            "      <engine><filename>gz-physics-{}-plugin</filename></engine>\n",
            s.physics_engine
        ));
    }
    o.push_str("    </plugin>\n");
    o.push_str("    <plugin filename=\"gz-sim-scene-broadcaster-system\" name=\"gz::sim::systems::SceneBroadcaster\"/>\n");
    if s.user_commands {
        o.push_str("    <plugin filename=\"gz-sim-user-commands-system\" name=\"gz::sim::systems::UserCommands\"/>\n");
    }
    if s.sensors {
        o.push_str("    <plugin filename=\"gz-sim-sensors-system\" name=\"gz::sim::systems::Sensors\">\n      <render_engine>ogre2</render_engine>\n    </plugin>\n");
    }
    if s.imu_system {
        o.push_str(
            "    <plugin filename=\"gz-sim-imu-system\" name=\"gz::sim::systems::Imu\"/>\n",
        );
    }
    for extra in &s.extra_plugins {
        let extra = extra.trim();
        if !extra.is_empty() {
            o.push_str(&format!(
                "    <plugin filename=\"{extra}\" name=\"{extra}\"/>\n"
            ));
        }
    }
    o.push('\n');

    o.push_str(&format!("    <gravity>0 0 {}</gravity>\n", f(s.gravity)));
    o.push_str(&format!(
        "    <scene>\n      <ambient>{a} {a} {a} 1</ambient>\n      <background>{r} {g} {b} 1</background>\n      <shadows>{sh}</shadows>\n    </scene>\n\n",
        a = f(s.ambient),
        r = f(s.background[0]),
        g = f(s.background[1]),
        b = f(s.background[2]),
        sh = s.shadows
    ));

    if s.sun {
        o.push_str(&format!(
            "    <light type=\"directional\" name=\"sun\">\n      <cast_shadows>{sh}</cast_shadows>\n      <pose>0 0 10 0 0 0</pose>\n      <diffuse>{i} {i} {i} 1</diffuse>\n      <specular>0.2 0.2 0.2 1</specular>\n      <direction>{dx} {dy} {dz}</direction>\n    </light>\n\n",
            sh = s.shadows,
            i = f(s.sun_intensity),
            dx = f(s.sun_direction[0]),
            dy = f(s.sun_direction[1]),
            dz = f(s.sun_direction[2]),
        ));
    }

    let has_field = !s.field_mesh.trim().is_empty();

    if s.ground {
        // With a field in place, the ground loses its VISUAL and keeps its
        // collision: the carpet is already drawn by the mesh, and two surfaces
        // at z = 0 produce z-fighting --- that striped flicker that looks like
        // a renderer bug and is duplicated geometry.
        let visual = if has_field {
            String::new()
        } else {
            format!(
                r#"        <visual name="visual">
          <geometry>
            <plane><normal>0 0 1</normal><size>{length} {width}</size></plane>
          </geometry>
          <material>
            <ambient>{r} {g} {b} 1</ambient>
            <diffuse>{r} {g} {b} 1</diffuse>
          </material>
        </visual>
"#,
                length = f(s.field_length),
                width = f(s.field_width),
                r = f(s.ground_color[0]),
                g = f(s.ground_color[1]),
                b = f(s.ground_color[2]),
            )
        };

        o.push_str(&format!(
            r#"    <model name="ground_plane">
      <static>true</static>
      <link name="link">
        <collision name="collision">
          <geometry><plane><normal>0 0 1</normal></plane></geometry>
          <surface>
            <friction>
              <ode><mu>{mu}</mu><mu2>{mu2}</mu2></ode>
            </friction>
          </surface>
        </collision>
{visual}      </link>
    </model>

"#,
            mu = f(s.friction),
            mu2 = f(s.friction2),
        ));
    }

    if has_field {
        // Visual only, and on purpose. The 2026 field is about 2.9 M
        // triangles; putting it in as collision would have the solver resolve
        // mesh-mesh contact, the most expensive thing a physics engine does,
        // and the real-time factor --- which decides whether gains tuned here
        // transfer to the real robot --- would hit the floor. The physics
        // still comes from the plane and the walls.
        o.push_str(&format!(
            r#"    <model name="frc_field">
      <static>true</static>
      <pose>{pose}</pose>
      <link name="link">
        <visual name="visual">
          <cast_shadows>false</cast_shadows>
          <geometry>
            <mesh>
              <uri>{uri}</uri>
              <scale>{e} {e} {e}</scale>
            </mesh>
          </geometry>
        </visual>
      </link>
    </model>

"#,
            pose = pose(&s.field_pose),
            uri = s.field_mesh.trim(),
            e = f(if s.field_scale > 0.0 { s.field_scale } else { 1.0 }),
        ));
    }

    if s.walls {
        // The ground's collision <plane> is infinite: without walls the robot
        // drives off the field and nothing stops it.
        o.push_str(
            "    <model name=\"field_walls\">\n      <static>true</static>\n      <link name=\"link\">\n",
        );
        let hx = s.field_length / 2.0;
        let hy = s.field_width / 2.0;
        let h = s.wall_height;
        let t = s.wall_thickness;
        let walls: [(&str, [f64; 6], [f64; 3]); 4] = [
            (
                "north",
                [0.0, hy + t / 2.0, h / 2.0, 0.0, 0.0, 0.0],
                [s.field_length + 2.0 * t, t, h],
            ),
            (
                "south",
                [0.0, -hy - t / 2.0, h / 2.0, 0.0, 0.0, 0.0],
                [s.field_length + 2.0 * t, t, h],
            ),
            (
                "east",
                [hx + t / 2.0, 0.0, h / 2.0, 0.0, 0.0, 0.0],
                [t, s.field_width, h],
            ),
            (
                "west",
                [-hx - t / 2.0, 0.0, h / 2.0, 0.0, 0.0, 0.0],
                [t, s.field_width, h],
            ),
        ];
        for (name, p, size) in walls {
            let size = format!("{} {} {}", f(size[0]), f(size[1]), f(size[2]));
            o.push_str(&format!(
                "        <collision name=\"{name}_collision\">\n          <pose>{pp}</pose>\n          <geometry><box><size>{size}</size></box></geometry>\n        </collision>\n        <visual name=\"{name}_visual\">\n          <pose>{pp}</pose>\n          <geometry><box><size>{size}</size></box></geometry>\n          <material>\n            <ambient>0.25 0.25 0.28 1</ambient>\n            <diffuse>0.35 0.35 0.4 1</diffuse>\n          </material>\n        </visual>\n",
                pp = pose(&p),
            ));
        }
        o.push_str("      </link>\n    </model>\n\n");
    }

    o.push_str(&generate_fuel(s));

    for p in &s.props {
        o.push_str(&generate_prop(p));
    }

    if !s.robot_uri.trim().is_empty() {
        o.push_str(&format!(
            "    <include>\n      <uri>{}</uri>\n      <pose>{}</pose>\n    </include>\n\n",
            s.robot_uri.trim(),
            pose(&s.robot_pose)
        ));
    }

    o.push_str("  </world>\n</sdf>\n");
    o
}

fn generate_prop(p: &Prop) -> String {
    let geometry = match p.shape.as_str() {
        "cylinder" => format!(
            "<cylinder><radius>{}</radius><length>{}</length></cylinder>",
            f(p.size[0]),
            f(p.size[1])
        ),
        "sphere" => format!("<sphere><radius>{}</radius></sphere>", f(p.size[0])),
        "mesh" => format!(
            "<mesh><uri>{}</uri><scale>{} {} {}</scale></mesh>",
            p.mesh.trim(),
            f(p.size[0]),
            f(p.size[1]),
            f(p.size[2])
        ),
        _ => format!(
            "<box><size>{} {} {}</size></box>",
            f(p.size[0]),
            f(p.size[1]),
            f(p.size[2])
        ),
    };

    // Inertia of the bounding box. It is a declared approximation: a prop is
    // an obstacle, not a mechanism, and an exact inertia would change nothing
    // about what is being tested.
    let (sx, sy, sz) = match p.shape.as_str() {
        "sphere" => (p.size[0] * 2.0, p.size[0] * 2.0, p.size[0] * 2.0),
        "cylinder" => (p.size[0] * 2.0, p.size[0] * 2.0, p.size[1]),
        _ => (p.size[0], p.size[1], p.size[2]),
    };
    let m = p.mass.max(0.001);
    let ixx = m * (sy * sy + sz * sz) / 12.0;
    let iyy = m * (sx * sx + sz * sz) / 12.0;
    let izz = m * (sx * sx + sy * sy) / 12.0;

    format!(
        r#"    <model name="{name}">
      <static>{is_static}</static>
      <pose>{pose}</pose>
      <link name="link">
        <inertial>
          <mass>{mass}</mass>
          <inertia>
            <ixx>{ixx}</ixx><ixy>0</ixy><ixz>0</ixz>
            <iyy>{iyy}</iyy><iyz>0</iyz><izz>{izz}</izz>
          </inertia>
        </inertial>
        <collision name="collision">
          <geometry>{geometry}</geometry>
        </collision>
        <visual name="visual">
          <geometry>{geometry}</geometry>
          <material>
            <ambient>{r} {g} {b} {a}</ambient>
            <diffuse>{r} {g} {b} {a}</diffuse>
          </material>
        </visual>
      </link>
    </model>

"#,
        name = p.name,
        is_static = p.is_static,
        pose = pose(&p.pose),
        mass = f(m),
        ixx = f(ixx),
        iyy = f(iyy),
        izz = f(izz),
        r = f(p.color[0]),
        g = f(p.color[1]),
        b = f(p.color[2]),
        a = f(p.color[3]),
    )
}

/// How many FUEL fit per layer and in what grid, given the seeding zone.
///
/// Returns `(columns, rows, layers)`. It is separate from the generator
/// because it is the only part of the seeding that can be tested without
/// reading XML, and because the editor shows the same count before saving ---
/// see `fuelGrid()` in `ui/js/worldspec.js`, which repeats this formula.
fn fuel_grid(n: usize, area: [f64; 2]) -> (usize, usize, usize) {
    if n == 0 {
        return (0, 0, 0);
    }

    let min_pitch = 2.0 * FUEL_RADIUS + FUEL_GAP;

    // The usable area is the box minus the radius on each side: that way the
    // ball's EDGE stays inside the declared zone and not half outside it.
    let usable_x = (area[0] - 2.0 * FUEL_RADIUS).max(0.0);
    let usable_y = (area[1] - 2.0 * FUEL_RADIUS).max(0.0);
    let max_cols = (usable_x / min_pitch).floor() as usize + 1;
    let max_rows = (usable_y / min_pitch).floor() as usize + 1;

    // The grid takes the zone's aspect ratio: in the NEUTRAL ZONE, which is
    // almost three times longer than wide, there are three times as many
    // columns as rows and the balls spread out, not in a square in the middle.
    let aspect = if area[1] > 0.0 { area[0] / area[1] } else { 1.0 };
    let cols = ((n as f64 * aspect).sqrt().round() as usize).clamp(1, max_cols);
    let rows = n.div_ceil(cols).clamp(1, max_rows);
    let per_layer = cols * rows;
    (cols, rows, n.div_ceil(per_layer))
}

/// Seeds the FUEL with physics inside `fuel_area`.
///
/// These are the real balls. The 456 visible in the field mesh are part of
/// the glTF: scenery with no collision or mass, which is why the number here
/// is independent of them.
///
/// They go in a grid and not at random for two reasons. A grid is
/// reproducible --- two runs of the same world start identical, which is what
/// makes an autonomous test comparable --- and it guarantees no ball is born
/// inside another: two bodies overlapping at step zero is the classic way for
/// a solver to invent energy and send them flying.
///
/// If they do not all fit in one layer they stack, with the same vertical
/// spacing as horizontal: the ones on top fall a few millimeters and settle
/// on their own.
fn generate_fuel(s: &WorldSpec) -> String {
    let (cols, rows, layers) = fuel_grid(s.fuel, s.fuel_area);
    if layers == 0 {
        return String::new();
    }

    let min_pitch = 2.0 * FUEL_RADIUS + FUEL_GAP;
    let usable_x = (s.fuel_area[0] - 2.0 * FUEL_RADIUS).max(0.0);
    let usable_y = (s.fuel_area[1] - 2.0 * FUEL_RADIUS).max(0.0);
    // With a single column the pitch is unused, and dividing by zero would put
    // NaN in the SDF --- which gz accepts when parsing and turns into an
    // impossible pose.
    let sx = if cols > 1 { usable_x / (cols - 1) as f64 } else { 0.0 };
    let sy = if rows > 1 { usable_y / (rows - 1) as f64 } else { 0.0 };
    let x0 = s.fuel_center[0] - usable_x / 2.0;
    let y0 = s.fuel_center[1] - usable_y / 2.0;
    let z0 = FUEL_RADIUS + s.fuel_height.max(0.0);

    let mut o = format!(
        "    <!-- {n} FUEL with physics, in a {cols} x {rows} grid{layer_note}\n         inside {ax} x {ay} m centered at ({cx}, {cy}). Each one is one more\n         dynamic body for the solver: if the real-time factor drops below 1.0,\n         this is the first thing to cut. -->\n",
        n = s.fuel,
        layer_note = if layers > 1 {
            format!(" and {layers} layers")
        } else {
            String::new()
        },
        ax = f(s.fuel_area[0]),
        ay = f(s.fuel_area[1]),
        cx = f(s.fuel_center[0]),
        cy = f(s.fuel_center[1]),
    );

    let per_layer = cols * rows;
    for k in 0..s.fuel {
        let layer = k / per_layer;
        let in_layer = k % per_layer;
        let x = x0 + (in_layer % cols) as f64 * sx;
        let y = y0 + (in_layer / cols) as f64 * sy;
        let z = z0 + layer as f64 * min_pitch;
        o.push_str(&format!(
            "    <include>\n      <uri>model://fuel</uri>\n      <name>fuel_{n:03}</name>\n      <pose>{x} {y} {z} 0 0 0</pose>\n    </include>\n",
            n = k + 1,
            x = f(x),
            y = f(y),
            z = f(z),
        ));
    }
    o.push('\n');
    o
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::library::between;
    use super::*;

    pub fn minimal_spec() -> WorldSpec {
        WorldSpec {
            file: "test".into(),
            description: String::new(),
            step: 0.004,
            rtf: 1.0,
            physics_engine: "dart".into(),
            gravity: -9.8,
            ground: true,
            friction: 0.9,
            friction2: 0.9,
            field_length: 16.54,
            field_width: 8.21,
            ground_color: [0.35, 0.35, 0.38, 1.0],
            field_mesh: String::new(),
            field_pose: default_field_pose(),
            field_scale: 1.0,
            fuel: 0,
            fuel_area: default_fuel_area(),
            fuel_center: [0.0, 0.0],
            fuel_height: 0.0,
            walls: true,
            wall_height: 0.5,
            wall_thickness: 0.1,
            sun: true,
            shadows: true,
            sun_direction: [-0.5, 0.1, -0.9],
            sun_intensity: 0.8,
            ambient: 0.4,
            background: [0.7, 0.75, 0.8],
            user_commands: true,
            sensors: false,
            imu_system: false,
            extra_plugins: vec![],
            robot_uri: String::new(),
            robot_pose: [0.0; 6],
            props: vec![],
        }
    }

    /// The world name is a contract: `protocol/check.py` rejects any SDF
    /// whose `<world name>` is not the manifest's.
    #[test]
    fn the_generated_world_is_named_mars() {
        let sdf = generate_sdf(&minimal_spec());
        assert!(sdf.contains("<world name=\"mars\">"), "{sdf}");
    }

    /// Without these two plugins the world opens, but there is no physics and
    /// no state to publish, and the bridge waits in silence.
    #[test]
    fn the_generated_world_has_physics_and_scene_broadcaster() {
        let sdf = generate_sdf(&minimal_spec());
        assert!(sdf.contains("gz-sim-physics-system"));
        assert!(sdf.contains("gz-sim-scene-broadcaster-system"));
    }

    #[test]
    fn props_come_out_with_inertia_and_geometry() {
        let mut s = minimal_spec();
        s.props.push(Prop {
            name: "crate".into(),
            shape: "box".into(),
            size: [0.3, 0.3, 0.3],
            mass: 2.0,
            is_static: false,
            pose: [1.0, 0.0, 0.15, 0.0, 0.0, 0.0],
            color: [0.8, 0.5, 0.2, 1.0],
            mesh: String::new(),
        });
        let sdf = generate_sdf(&s);
        assert!(sdf.contains("<model name=\"crate\">"));
        assert!(sdf.contains("<mass>2</mass>"));
        assert!(sdf.contains("<box><size>0.3 0.3 0.3</size></box>"));
    }

    /// Without FUEL not a single `<include>` is written: a mechanism world
    /// has no reason to pay for anything.
    #[test]
    fn no_fuel_means_no_includes() {
        let sdf = generate_sdf(&minimal_spec());
        assert!(!sdf.contains("model://fuel"), "{sdf}");
    }

    /// The poses of the seeded FUEL, and only those: the world has walls and
    /// a field, which also carry `<pose>`.
    fn fuel_poses(sdf: &str) -> Vec<[f64; 3]> {
        sdf.split("<uri>model://fuel</uri>")
            .skip(1)
            .filter_map(|block| between(block, "<pose>", "</pose>"))
            .filter_map(|p| {
                let v: Vec<f64> = p.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                (v.len() == 6).then(|| [v[0], v[1], v[2]])
            })
            .collect()
    }

    #[test]
    fn fuel_gets_unique_names_and_rests_on_the_floor() {
        let mut s = minimal_spec();
        s.fuel = 12;
        let sdf = generate_sdf(&s);
        assert_eq!(sdf.matches("<uri>model://fuel</uri>").count(), 12);
        assert!(sdf.contains("<name>fuel_001</name>"));
        assert!(sdf.contains("<name>fuel_012</name>"));

        let poses = fuel_poses(&sdf);
        assert_eq!(poses.len(), 12);
        for p in &poses {
            // z = radius: resting on the floor, neither sunk nor floating.
            assert!((p[2] - FUEL_RADIUS).abs() < 1e-9, "unexpected z: {}", p[2]);
            // And inside the declared zone, with the whole ball inside.
            assert!(p[0].abs() <= s.fuel_area[0] / 2.0 - FUEL_RADIUS + 1e-9);
            assert!(p[1].abs() <= s.fuel_area[1] / 2.0 - FUEL_RADIUS + 1e-9);
        }
    }

    /// Two balls born inside each other is the classic way for the solver to
    /// invent energy. The grid exists so that it does not happen, and this
    /// checks it with the worst case: the default zone, full.
    #[test]
    fn fuel_is_not_born_overlapping() {
        let mut s = minimal_spec();
        s.fuel = 60;
        let poses = fuel_poses(&generate_sdf(&s));
        assert_eq!(poses.len(), 60);
        for (i, a) in poses.iter().enumerate() {
            for b in &poses[i + 1..] {
                let d2 = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2);
                assert!(
                    d2 >= (2.0 * FUEL_RADIUS).powi(2),
                    "two FUEL {} m apart, less than a diameter",
                    d2.sqrt()
                );
            }
        }
    }

    /// The grid that comes out here is the one the editor promises before
    /// saving.
    ///
    /// `fuelGrid()` in `ui/js/worldspec.js` is a copy of this formula, and a
    /// copy without a tripwire drifts: the editor would say "8 × 3" and the
    /// SDF would carry something else. These numbers came from running both.
    #[test]
    fn the_grid_is_the_one_the_editor_shows() {
        let zone = default_fuel_area();
        assert_eq!(fuel_grid(9, zone), (5, 2, 1));
        assert_eq!(fuel_grid(24, zone), (8, 3, 1));
        assert_eq!(fuel_grid(60, zone), (13, 5, 1));
        assert_eq!(fuel_grid(456, zone), (30, 10, 2));
        assert_eq!(fuel_grid(40, [1.0, 1.0]), (6, 6, 2));
    }

    /// And when they do not fit on the floor they stack, instead of ending up
    /// outside the zone or on top of each other.
    #[test]
    fn fuel_that_does_not_fit_stacks() {
        let mut s = minimal_spec();
        s.fuel = 40;
        s.fuel_area = [1.0, 1.0];
        let (cols, rows, layers) = fuel_grid(s.fuel, s.fuel_area);
        assert!(layers > 1, "40 FUEL in 1 m² have to take several layers");
        assert!(cols * rows * layers >= s.fuel);
        let sdf = generate_sdf(&s);
        assert_eq!(sdf.matches("<uri>model://fuel</uri>").count(), 40);
    }

    /// The spec the editor saves has to read back the same: it is the only
    /// thing that makes a world editable the second time it is opened.
    #[test]
    fn the_spec_round_trips_through_json() {
        let s = minimal_spec();
        let text = serde_json::to_string(&s).unwrap();
        let back: WorldSpec = serde_json::from_str(&text).unwrap();
        assert_eq!(back.file, s.file);
        assert_eq!(back.field_length, s.field_length);
        assert_eq!(back.physics_engine, s.physics_engine);
    }

    /// The object the editor sends has to land in `WorldSpec` field by field.
    ///
    /// It is a literal copy of `defaultSpec()` in `ui/js/worldspec.js`. A name
    /// that does not match is not a compile error anywhere: serde fails at
    /// run time, with the editor open and the user pressing Save. The same
    /// risk `supervisor::tests::the_ui_and_config_speak_the_same_json` covers
    /// for starting.
    #[test]
    fn the_ui_and_worldspec_speak_the_same_json() {
        let from_editor = r#"{
            "file": "new-world",
            "description": "",
            "step": 0.004,
            "rtf": 1.0,
            "physics_engine": "dart",
            "gravity": -9.8,
            "ground": true,
            "friction": 0.9,
            "friction2": 0.9,
            "field_length": 16.54,
            "field_width": 8.21,
            "ground_color": [0.32, 0.33, 0.36, 1],
            "fuel": 0,
            "fuel_area": [5.23, 1.83],
            "fuel_center": [0, 0],
            "fuel_height": 0,
            "walls": true,
            "wall_height": 0.5,
            "wall_thickness": 0.1,
            "sun": true,
            "shadows": true,
            "sun_direction": [-0.5, 0.1, -0.9],
            "sun_intensity": 0.8,
            "ambient": 0.4,
            "background": [0.7, 0.75, 0.8],
            "user_commands": true,
            "sensors": false,
            "imu_system": false,
            "extra_plugins": [],
            "robot_uri": "",
            "robot_pose": [0, 0, 0.1, 0, 0, 0],
            "props": []
        }"#;
        let spec: WorldSpec =
            serde_json::from_str(from_editor).expect("the editor sends something WorldSpec cannot read");
        assert_eq!(spec.file, "new-world");
        assert_eq!(spec.field_length, 16.54);
        assert!(spec.walls);
    }

    /// And the prop, which goes nested inside the same object.
    #[test]
    fn the_ui_and_prop_speak_the_same_json() {
        let from_editor = r#"{
            "name": "box_1",
            "shape": "box",
            "size": [0.3, 0.3, 0.3],
            "mass": 2,
            "static": false,
            "pose": [1, 0, 0.15, 0, 0, 0],
            "color": [0.8, 0.5, 0.2, 1],
            "mesh": ""
        }"#;
        let p: Prop = serde_json::from_str(from_editor).expect("the editor sends a prop Prop cannot read");
        assert_eq!(p.name, "box_1");
        assert_eq!(p.size[0], 0.3);
    }

    /// A `.studio.json` written before the fields were renamed still opens.
    ///
    /// Those files live in people's `worlds/` folders, not in this
    /// repository; without the aliases, every managed world saved by an older
    /// Studio would silently turn read-only (it would fail to parse and be
    /// treated as external).
    #[test]
    fn old_studio_json_still_reads() {
        let old = r#"{
            "archivo": "legacy", "descripcion": "x", "paso": 0.004, "rtf": 1.0,
            "motor_fisica": "dart", "gravedad": -9.8, "suelo": true,
            "friccion": 0.9, "friccion2": 0.9, "cancha_largo": 16.54,
            "cancha_ancho": 8.21, "color_suelo": [0.32, 0.33, 0.36, 1],
            "campo": "fields/2026/model.glb", "campo_pose": [0, 0, 0, 1.57, 0, 0],
            "campo_escala": 1, "fuel": 3, "fuel_area": [5.23, 1.83],
            "fuel_centro": [1, 0], "fuel_altura": 0.1, "muros": true,
            "muro_alto": 0.5, "muro_grosor": 0.1, "sol": true, "sombras": false,
            "sol_direccion": [-0.5, 0.1, -0.9], "sol_intensidad": 0.8,
            "ambiente": 0.4, "fondo": [0.7, 0.75, 0.8], "comandos_usuario": true,
            "sensores": false, "imu_system": false, "plugins_extra": [],
            "robot_uri": "", "robot_pose": [0, 0, 0.1, 0, 0, 0],
            "props": [{"nombre": "b", "forma": "box", "tamano": [1, 1, 1],
                       "masa": 1, "estatico": true, "pose": [0, 0, 0, 0, 0, 0],
                       "color": [1, 1, 1, 1], "malla": ""}]
        }"#;
        let spec: WorldSpec = serde_json::from_str(old).expect("an old .studio.json no longer reads");
        assert_eq!(spec.file, "legacy");
        assert_eq!(spec.field_mesh, "fields/2026/model.glb");
        assert_eq!(spec.fuel_center, [1.0, 0.0]);
        assert!(!spec.shadows);
        assert!(spec.props[0].is_static);
    }
}
