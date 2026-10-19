package com.stzteam.features.ares;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import edu.wpi.first.math.geometry.Translation2d;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/**
 * The navigation grid the Field tab draws: square cells over the field, each
 * open or closed to the robot's center. PathPlanner's {@code navgrid.json}
 * layout ({@code grid[row][col]}, the row along y and the column along x), so a
 * PathPlanner navgrid reads as well.
 *
 * <p>{@link #route} is the same search the app's "Test route" previews: A* over
 * the open cells with eight neighbors (never cutting a blocked corner),
 * straightened by line of sight.
 */
public final class NavGrid {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int[][] AROUND = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {1, -1}, {-1, 1}, {-1, -1}};

  private final double node;
  private final boolean[][] grid;
  /** Cells blocked by what moves (other robots seen by vision): set in code, over the drawn grid. */
  private volatile boolean[][] dynamic;
  private long version;

  public NavGrid(double nodeSizeMeters, boolean[][] grid) {
    if (nodeSizeMeters <= 0) throw new IllegalArgumentException("nodeSizeMeters must be positive");
    this.node = nodeSizeMeters;
    this.grid = grid;
  }

  /** A grid with nothing blocked, the field's size: for obstacles that come and go when no navgrid was drawn. */
  public static NavGrid open(double nodeSizeMeters, double lengthM, double widthM) {
    return new NavGrid(nodeSizeMeters, new boolean[(int) Math.ceil(widthM / nodeSizeMeters)][(int) Math.ceil(lengthM / nodeSizeMeters)]);
  }

  /**
   * Blocks the cells under these boxes (each by two opposite corners, this
   * grid's frame), grown by {@code marginM} all around (the robot's reach
   * from its center), replacing the last ones; an empty list clears them.
   */
  public void setObstacles(List<Translation2d[]> boxes, double marginM) {
    if (boxes.isEmpty()) {
      dynamic = null;
    } else {
      var d = new boolean[rows()][cols()];
      for (var b : boxes) {
        double x0 = Math.min(b[0].getX(), b[1].getX()) - marginM, x1 = Math.max(b[0].getX(), b[1].getX()) + marginM;
        double y0 = Math.min(b[0].getY(), b[1].getY()) - marginM, y1 = Math.max(b[0].getY(), b[1].getY()) + marginM;
        for (int r = Math.max(0, (int) Math.floor(y0 / node)); r <= Math.min(rows() - 1, (int) Math.floor(y1 / node)); r++) {
          for (int c = Math.max(0, (int) Math.floor(x0 / node)); c <= Math.min(cols() - 1, (int) Math.floor(x1 / node)); c++) d[r][c] = true;
        }
      }
      dynamic = d;
    }
    version++;
  }

  /** Changes every time the obstacles do. */
  public long obstaclesVersion() {
    return version;
  }

  public static NavGrid load(File file) throws IOException {
    return parse(JSON.readTree(file));
  }

  public static NavGrid parse(String json) throws IOException {
    return parse(JSON.readTree(json));
  }

  static NavGrid parse(JsonNode n) throws IOException {
    if (!n.has("nodeSizeMeters") || !n.path("grid").isArray()) {
      throw new IOException("not a navgrid: it needs nodeSizeMeters and grid");
    }
    var rows = n.path("grid");
    var grid = new boolean[rows.size()][];
    for (int r = 0; r < rows.size(); r++) {
      var row = rows.get(r);
      grid[r] = new boolean[row.size()];
      for (int c = 0; c < row.size(); c++) grid[r][c] = row.get(c).asBoolean();
    }
    return new NavGrid(n.path("nodeSizeMeters").asDouble(), grid);
  }

  public double nodeSizeMeters() {
    return node;
  }

  public int rows() {
    return grid.length;
  }

  public int cols() {
    return grid.length == 0 ? 0 : grid[0].length;
  }

  private boolean cell(int c, int r) {
    if (r < 0 || r >= grid.length || c < 0 || c >= grid[r].length) return false;
    var d = dynamic;
    return grid[r][c] || d != null && d[r][c];
  }

  /** Whether the robot's center may not be at (x, y). Off the grid is open. */
  public boolean blocked(double x, double y) {
    if (x < 0 || y < 0) return false;
    return cell((int) Math.floor(x / node), (int) Math.floor(y / node));
  }

  public boolean blocked(Translation2d p) {
    return blocked(p.getX(), p.getY());
  }

  /** Whether the straight line from a to b stays out of blocked cells (its ends may be in one). */
  public boolean sees(Translation2d a, Translation2d b) {
    double step = Math.max(0.01, node / 4);
    int n = (int) Math.ceil(a.getDistance(b) / step);
    for (int i = 1; i < n; i++) {
      double f = (double) i / n;
      if (blocked(a.getX() + (b.getX() - a.getX()) * f, a.getY() + (b.getY() - a.getY()) * f)) return false;
    }
    return true;
  }

  private Translation2d center(int c, int r) {
    return new Translation2d((c + 0.5) * node, (r + 0.5) * node);
  }

  /** The way from a to b, both included, or null if the grid walls it off. */
  public List<Translation2d> route(Translation2d a, Translation2d b) {
    if (sees(a, b)) return List.of(a, b);
    int cols = cols(), rows = rows();
    int sc = (int) Math.floor(a.getX() / node), sr = (int) Math.floor(a.getY() / node);
    int gc = (int) Math.floor(b.getX() / node), gr = (int) Math.floor(b.getY() / node);
    if (sc < 0 || sr < 0 || sc >= cols || sr >= rows || gc < 0 || gr < 0 || gc >= cols || gr >= rows) return null;
    // A start or goal in a blocked cell (a pose against a wall, or in a zone the navgrid closes, as
    // a shooting spot by the tower): route from and to the nearest open cell and drive that last
    // stretch straight, as PathPlanner does, instead of giving up on the whole way.
    int start = nearestOpen(sc, sr), goal = nearestOpen(gc, gr);
    if (start < 0 || goal < 0) return null;
    Map<Integer, Double> g = new HashMap<>();
    Map<Integer, Integer> came = new HashMap<>();
    Set<Integer> closed = new HashSet<>();
    var open = new PriorityQueue<double[]>((p, q) -> Double.compare(p[0], q[0]));
    g.put(start, 0.0);
    open.add(new double[] {Math.hypot(sc - gc, sr - gr), start});
    boolean found = false;
    while (!open.isEmpty()) {
      int k = (int) open.poll()[1];
      if (!closed.add(k)) continue;
      if (k == goal) {
        found = true;
        break;
      }
      int c = k % cols, r = k / cols;
      double gk = g.get(k);
      for (var d : AROUND) {
        int nc = c + d[0], nr = r + d[1];
        if (!passable(nc, nr, start, goal)) continue;
        // No cutting a blocked corner diagonally.
        if (d[0] != 0 && d[1] != 0 && (!passable(c + d[0], r, start, goal) || !passable(c, r + d[1], start, goal))) continue;
        int nk = nr * cols + nc;
        double gn = gk + (d[0] != 0 && d[1] != 0 ? Math.sqrt(2) : 1);
        if (gn < g.getOrDefault(nk, Double.POSITIVE_INFINITY)) {
          g.put(nk, gn);
          came.put(nk, k);
          open.add(new double[] {gn + Math.hypot(nc - gc, nr - gr), nk});
        }
      }
    }
    if (!found) return null;
    var cells = new ArrayList<Integer>();
    for (Integer k = goal; k != null; k = came.get(k)) cells.add(0, k);
    var pts = new ArrayList<Translation2d>();
    pts.add(a);
    // The ends' own cells stand for a and b, unless they were moved out of a blocked one.
    boolean startMoved = start != sr * cols + sc, goalMoved = goal != gr * cols + gc;
    for (int i = startMoved ? 0 : 1; i < cells.size() - (goalMoved ? 0 : 1); i++) {
      pts.add(center(cells.get(i) % cols, cells.get(i) / cols));
    }
    pts.add(b);
    // Line of sight: keep only the corners the straight line cannot skip.
    var out = new ArrayList<Translation2d>();
    out.add(a);
    int i = 0;
    while (i < pts.size() - 1) {
      int j = pts.size() - 1;
      while (j > i + 1 && !sees(pts.get(i), pts.get(j))) j--;
      out.add(pts.get(j));
      i = j;
    }
    return out;
  }

  /** The cell itself if it is open, else the nearest open one (ring by ring), or -1 if none. */
  private int nearestOpen(int c, int r) {
    if (!cell(c, r)) return r * cols() + c;
    int cols = cols(), rows = rows();
    for (int ring = 1; ring < Math.max(cols, rows); ring++) {
      int best = -1;
      double bestD = Double.POSITIVE_INFINITY;
      for (int dr = -ring; dr <= ring; dr++) {
        for (int dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) != ring) continue;
          int nc = c + dc, nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || cell(nc, nr)) continue;
          double d = Math.hypot(dc, dr);
          if (d < bestD) {
            bestD = d;
            best = nr * cols + nc;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  private boolean passable(int c, int r, int start, int goal) {
    if (c < 0 || r < 0 || c >= cols() || r >= rows()) return false;
    int k = r * cols() + c;
    return !cell(c, r) || k == start || k == goal;
  }
}
