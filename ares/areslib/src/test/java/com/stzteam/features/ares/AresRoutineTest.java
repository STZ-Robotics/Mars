package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stzteam.features.ares.trajectory.FieldSymmetry;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;
import java.util.ArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Routines with triggers (Choreo's way) and driving to a pose by itself (PathPlanner's pathfindToPose). */
class AresRoutineTest {
  FollowPathTest.PerfectDrive drive;
  boolean red;
  Ares ares;
  double clock;

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
    clock = 0;
    ares = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> red));
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().cancelAll();
    CommandScheduler.getInstance().unregisterAllSubsystems();
    CommandScheduler.getInstance().getActiveButtonLoop().clear();
    SimHooks.resumeTiming();
  }

  /** Runs the scheduler for {@code seconds}, or until the command ends. */
  void run(Command c, double seconds) {
    CommandScheduler.getInstance().schedule(c);
    for (; clock < seconds; clock += 0.02) {
      CommandScheduler.getInstance().run();
      if (!CommandScheduler.getInstance().isScheduled(c)) break;
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
    }
  }

  @Test
  void aRoutineBindsToItsPathsTimesMarkersAndEnd() throws Exception {
    var main = TrajectoryTest.main();
    var r = ares.routine("Test");
    var p = r.path("Main");
    var intakeAt = new ArrayList<Double>();
    var halfAt = new ArrayList<Double>();
    var doneAt = new ArrayList<Double>();
    drive.pose = new Pose2d(9, 7, Rotation2d.kZero); // reset by the routine
    r.active().onTrue(p.resetOdometry().andThen(p.cmd()));
    p.atTime("intake").onTrue(Commands.runOnce(() -> intakeAt.add(clock)));
    p.atTime(0.5).onTrue(Commands.runOnce(() -> halfAt.add(clock)));
    p.done().onTrue(Commands.runOnce(() -> doneAt.add(clock)));
    run(r.cmd(), main.duration() + 1.5);

    assertEquals(1, intakeAt.size());
    assertEquals(main.events().stream().filter(e -> e.name().equals("intake")).findFirst().get().t(), intakeAt.get(0), 0.08);
    assertEquals(1, halfAt.size());
    assertEquals(0.5, halfAt.get(0), 0.08);
    assertEquals(1, doneAt.size());
    assertEquals(main.duration(), doneAt.get(0), 0.3);
    assertEquals(main.last().x(), drive.pose.getX(), 0.03);
    assertEquals(main.last().y(), drive.pose.getY(), 0.03);
  }

  @Test
  void aPathCutShortIsNotDone() throws Exception {
    var r = ares.routine("Cut");
    var p = r.path("Main");
    var done = new ArrayList<Double>();
    drive.pose = TrajectoryTest.main().initial().pose();
    r.active().onTrue(Commands.race(p.cmd(), Commands.waitSeconds(0.5)));
    p.done().onTrue(Commands.runOnce(() -> done.add(clock)));
    run(r.cmd(), 3);
    assertTrue(done.isEmpty());
  }

  @Test
  void itDrivesToAPoseByItselfAndFlipsItOnRed() {
    var goal = new Pose2d(5, 3, Rotation2d.fromDegrees(90));
    drive.pose = new Pose2d(2, 2, Rotation2d.kZero);
    run(ares.pathfindTo(goal), 10);
    assertEquals(5, drive.pose.getX(), 0.06);
    assertEquals(3, drive.pose.getY(), 0.06);
    assertEquals(90, drive.pose.getRotation().getDegrees(), 3);

    setUp();
    red = true;
    var redGoal = FieldSymmetry.ROTATIONAL.flip(goal, 16.541, 8.0692);
    drive.pose = FieldSymmetry.ROTATIONAL.flip(new Pose2d(2, 2, Rotation2d.kZero), 16.541, 8.0692);
    run(ares.pathfindTo(goal), 10);
    assertEquals(redGoal.getX(), drive.pose.getX(), 0.06);
    assertEquals(redGoal.getY(), drive.pose.getY(), 0.06);
  }

  @Test
  void itGoesToWhereAPathStartsThenFollowsIt() throws Exception {
    var main = TrajectoryTest.main();
    drive.pose = new Pose2d(main.initial().x() + 1.5, main.initial().y() + 1, Rotation2d.kZero);
    run(ares.pathfindThenFollow("Main"), 15);
    assertEquals(main.last().x(), drive.pose.getX(), 0.05);
    assertEquals(main.last().y(), drive.pose.getY(), 0.05);
  }
}
