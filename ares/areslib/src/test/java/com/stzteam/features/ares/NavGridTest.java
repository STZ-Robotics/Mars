package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stzteam.features.ares.trajectory.FieldSymmetry;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import java.io.File;
import java.nio.file.Files;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class NavGridTest {
  static final double L = 16.541, W = 8.0692, NODE = 0.3;

  /** The field in 0.3 m cells, with a wall at x in [7.8, 8.4) from the floor up to y = 6.3. */
  static NavGrid wall() {
    int cols = (int) Math.ceil(L / NODE), rows = (int) Math.ceil(W / NODE);
    var g = new boolean[rows][cols];
    for (int r = 0; r < 21; r++) {
      g[r][26] = true;
      g[r][27] = true;
    }
    return new NavGrid(NODE, g);
  }

  @BeforeEach
  void setUp() {
    HAL.initialize(500, 0);
    SimHooks.pauseTiming();
    // Enabled here, not left so by whichever test ran before.
    DriverStationSim.setEnabled(true);
    DriverStationSim.notifyNewData();
    CommandScheduler.getInstance().cancelAll();
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().cancelAll();
    SimHooks.resumeTiming();
  }

  @Test
  void readsPathPlannersLayout() throws Exception {
    // Rows along y, columns along x: cell (col 1, row 0) is blocked.
    var g = NavGrid.parse("{\"field_size\":{\"x\":1.2,\"y\":0.6},\"nodeSizeMeters\":0.3,\"grid\":[[false,true,false,false],[false,false,false,false]]}");
    assertEquals(2, g.rows());
    assertEquals(4, g.cols());
    assertTrue(g.blocked(0.45, 0.1));
    assertFalse(g.blocked(0.1, 0.45));
    assertFalse(g.blocked(-1, 0.1)); // off the grid is open
  }

  @Test
  void readsPathPlannersOwnExample() throws Exception {
    var file = new File("../reference/pathplanner/examples/java/src/main/deploy/pathplanner/navgrid.json");
    if (!file.isFile()) return; // the reference clone is not in every checkout
    var g = NavGrid.load(file);
    assertEquals(0.3, g.nodeSizeMeters(), 0);
    assertEquals(56, g.cols());
  }

  @Test
  void routesAroundTheWallAndEveryLegIsClear() {
    var g = wall();
    var a = new Translation2d(4, 2);
    var b = new Translation2d(12, 2);
    assertFalse(g.sees(a, b));
    var r = g.route(a, b);
    assertEquals(a, r.get(0));
    assertEquals(b, r.get(r.size() - 1));
    assertTrue(r.size() > 2);
    for (int i = 1; i < r.size(); i++) assertTrue(g.sees(r.get(i - 1), r.get(i)));
    assertTrue(r.stream().anyMatch(p -> p.getY() > 6.3), "over the top of the wall");
    assertEquals(List.of(new Translation2d(1, 1), new Translation2d(3, 1)), g.route(new Translation2d(1, 1), new Translation2d(3, 1)));
  }

  @Test
  void saysWhenThereIsNoWay() {
    int cols = (int) Math.ceil(L / NODE), rows = (int) Math.ceil(W / NODE);
    var cells = new boolean[rows][cols];
    for (int r = 0; r < rows; r++) cells[r][26] = true;
    assertNull(new NavGrid(NODE, cells).route(new Translation2d(4, 2), new Translation2d(12, 2)));
  }

  @Test
  void aPolylineProfileSlowsForCornersAndArrives() {
    var pts = List.of(new Translation2d(0, 0), new Translation2d(3, 0), new Translation2d(3, 3));
    var p = new ProfiledPolyline(pts, 0, 0, 4, 3);
    var corner = p.sample(timeAt(p, new Translation2d(3, 0)));
    assertTrue(corner.velocity().getNorm() < 0.2, "a right angle is taken stopped: " + corner.velocity().getNorm());
    var end = p.sample(p.totalTime() + 1);
    assertEquals(3, end.position().getX(), 1e-9);
    assertEquals(3, end.position().getY(), 1e-9);
    // Never faster than allowed, and the position moves continuously.
    var last = p.sample(0).position();
    for (double t = 0; t < p.totalTime(); t += 0.01) {
      var s = p.sample(t);
      assertTrue(s.velocity().getNorm() <= 4 + 1e-9);
      assertTrue(s.position().getDistance(last) < 4 * 0.01 + 1e-6);
      last = s.position();
    }
  }

  private static double timeAt(ProfiledPolyline p, Translation2d q) {
    double best = 0, d = Double.POSITIVE_INFINITY;
    for (double t = 0; t < p.totalTime(); t += 0.005) {
      double e = p.sample(t).position().getDistance(q);
      if (e < d) {
        d = e;
        best = t;
      }
    }
    return best;
  }

  void drivesAroundTheWall(boolean red, FieldSymmetry symmetry) {
    var drive = new FollowPathTest.PerfectDrive();
    var g = wall();
    var gains = new AresController.Gains(4, 0, 0);
    var finder = new GridPathfinder(drive, g, gains, gains, 0.05, 0.05, () -> red, symmetry, L, W);
    var startBlue = new Pose2d(4, 2, new Rotation2d());
    var goalBlue = new Pose2d(12, 2, Rotation2d.fromDegrees(90));
    drive.pose = red ? symmetry.flip(startBlue, L, W) : startBlue;
    var goal = red ? symmetry.flip(goalBlue, L, W) : goalBlue;
    var c = finder.toPose(goal, new ChassisSpeeds(), new AresPathfinder.Constraints(3, 3, 6, 12));
    CommandScheduler.getInstance().schedule(c);
    for (double t = 0; t < 20 && CommandScheduler.getInstance().isScheduled(c); t += 0.02) {
      CommandScheduler.getInstance().run();
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
      // Seen from blue, the robot's center never enters the wall's cells.
      var blue = red ? symmetry.flip(drive.pose.getTranslation(), L, W) : drive.pose.getTranslation();
      assertFalse(g.blocked(blue), "inside the wall at " + blue);
    }
    assertFalse(CommandScheduler.getInstance().isScheduled(c));
    assertEquals(goal.getX(), drive.pose.getX(), 0.06);
    assertEquals(goal.getY(), drive.pose.getY(), 0.06);
  }

  @Test
  void theRobotDrivesAroundTheWallOnBlue() {
    drivesAroundTheWall(false, FieldSymmetry.ROTATIONAL);
  }

  @Test
  void andOnRedWithTheGridFlipped() {
    drivesAroundTheWall(true, FieldSymmetry.ROTATIONAL);
    drivesAroundTheWall(true, FieldSymmetry.MIRRORED);
  }

  @Test
  void aProjectWithANavgridPathfindsAroundIt() throws Exception {
    var dir = Files.createTempDirectory("ares-navgrid").toFile();
    for (var f : List.of("ares-index.json", "trajectories/Main.traj.json", "trajectories/Alt.traj.json", "trajectories/Find.traj.json")) {
      var to = new File(dir, f);
      to.getParentFile().mkdirs();
      Files.copy(new File(TrajectoryTest.PROJECT, f).toPath(), to.toPath());
    }
    var drive = new FollowPathTest.PerfectDrive();
    // Without a navgrid: an open grid the field's size, so obstacles set in code have somewhere to go.
    var open = assertInstanceOf(GridPathfinder.class, new Ares(drive, new Ares.Config().withFolder(dir)).pathfinder());
    assertEquals(0, open.grid().rows() == 0 ? -1 : blockedCells(open.grid()));
    Files.writeString(new File(dir, "navgrid.json").toPath(),
        "{\"field_size\":{\"x\":16.54,\"y\":8.07},\"nodeSizeMeters\":0.3,\"grid\":[[false,true]],\"generatedBy\":\"Ares\"}");
    var drawn = assertInstanceOf(GridPathfinder.class, new Ares(drive, new Ares.Config().withFolder(dir)).pathfinder());
    assertEquals(1, blockedCells(drawn.grid()));
  }

  static int blockedCells(NavGrid g) {
    int n = 0;
    for (int r = 0; r < g.rows(); r++) {
      for (int c = 0; c < g.cols(); c++) if (g.blocked((c + 0.5) * g.nodeSizeMeters(), (r + 0.5) * g.nodeSizeMeters())) n++;
    }
    return n;
  }
}
