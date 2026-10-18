package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stzteam.features.ares.trajectory.FieldSymmetry;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.Pair;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Obstacles that come and go (PathPlanner's dynamic obstacles), set in code, avoided by the pathfinder. */
class DynamicObstaclesTest {
  FollowPathTest.PerfectDrive drive;
  boolean red;
  Ares ares;
  double closest;

  @BeforeEach
  void setUp() {
    HAL.initialize(500, 0);
    SimHooks.pauseTiming();
    DriverStationSim.setEnabled(true);
    DriverStationSim.setAutonomous(true);
    DriverStationSim.notifyNewData();
    CommandScheduler.getInstance().cancelAll();
    drive = new FollowPathTest.PerfectDrive();
    red = false;
    // The fixture project has no navgrid: the open grid Ares makes takes the obstacles.
    ares = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> red));
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().cancelAll();
    CommandScheduler.getInstance().unregisterAllSubsystems();
    CommandScheduler.getInstance().getActiveButtonLoop().clear();
    SimHooks.resumeTiming();
  }

  /** Runs until the command ends; {@code closest}: how near the robot's center came to {@code watch}. */
  void run(Command c, double maxS, Translation2d watch, Runnable at1s) {
    CommandScheduler.getInstance().schedule(c);
    closest = Double.MAX_VALUE;
    for (double t = 0; t < maxS && CommandScheduler.getInstance().isScheduled(c); t += 0.02) {
      if (at1s != null && Math.abs(t - 1.0) < 0.01) at1s.run();
      CommandScheduler.getInstance().run();
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
      closest = Math.min(closest, drive.pose.getTranslation().getDistance(watch));
    }
  }

  // A robot-sized box (0.9 m) right on the straight way from (2, 4) to (8, 4).
  static final Pair<Translation2d, Translation2d> BOX = Pair.of(new Translation2d(4.55, 3.55), new Translation2d(5.45, 4.45));
  static final Translation2d MIDDLE = new Translation2d(5, 4);

  @Test
  void itGoesAroundAnObstacleOnTheWay() {
    ares.setDynamicObstacles(List.of(BOX));
    drive.pose = new Pose2d(2, 4, Rotation2d.kZero);
    run(ares.pathfindTo(new Pose2d(8, 4, Rotation2d.kZero)), 15, MIDDLE, null);
    assertEquals(8, drive.pose.getX(), 0.06);
    assertEquals(4, drive.pose.getY(), 0.06);
    // Clear of the box by the robot's reach: never within 0.45 + reach of its middle.
    assertTrue(closest > 0.9, "came within " + closest + " m of the obstacle's middle");
  }

  @Test
  void anObstacleThatAppearsOnTheWayIsGoneAround() {
    drive.pose = new Pose2d(2, 4, Rotation2d.kZero);
    // Straight at first; at 1 s, something drives in ahead.
    run(ares.pathfindTo(new Pose2d(8, 4, Rotation2d.kZero)), 15, MIDDLE, () -> ares.setDynamicObstacles(List.of(BOX)));
    assertEquals(8, drive.pose.getX(), 0.06);
    assertTrue(closest > 0.9, "came within " + closest + " m of the obstacle's middle");
  }

  @Test
  void withNoObstaclesItStillDrivesStraight() {
    drive.pose = new Pose2d(2, 4, Rotation2d.kZero);
    run(ares.pathfindTo(new Pose2d(8, 4, Rotation2d.kZero)), 15, MIDDLE, null);
    assertTrue(closest < 0.05, "strayed " + closest + " m from the straight way");
  }

  @Test
  void onRedTheObstaclesAreWhereTheRobotSeesThem() {
    red = true;
    var flip = (java.util.function.UnaryOperator<Translation2d>) p -> FieldSymmetry.ROTATIONAL.flip(p, 16.541, 8.0692);
    // The same situation, mirrored: the robot reports the box where it is on the field.
    ares.setDynamicObstacles(List.of(Pair.of(flip.apply(BOX.getFirst()), flip.apply(BOX.getSecond()))));
    // pathfindTo takes blue's coordinates and flips them; the robot starts at the red start.
    drive.pose = new Pose2d(flip.apply(new Translation2d(2, 4)), Rotation2d.k180deg);
    run(ares.pathfindTo(new Pose2d(8, 4, Rotation2d.kZero)), 15, flip.apply(MIDDLE), null);
    var goal = flip.apply(new Translation2d(8, 4));
    assertEquals(goal.getX(), drive.pose.getX(), 0.06);
    assertTrue(closest > 0.9, "came within " + closest + " m of the obstacle's middle");
  }
}
