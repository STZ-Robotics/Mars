package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import edu.wpi.first.hal.AllianceStationID;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.Subsystem;
import com.stzteam.features.ares.trajectory.FieldSymmetry;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The commands on the real scheduler, against a drivetrain that does exactly
 * what it is told: whatever goes wrong here is Ares's, not the robot's.
 */
class FollowPathTest {
  /** Integrates the commanded field speeds, one loop at a time. */
  static final class PerfectDrive implements AresDrive {
    Pose2d pose = new Pose2d();
    ChassisSpeeds field = new ChassisSpeeds();
    final List<AresSetpoint> setpoints = new ArrayList<>();
    final Subsystem subsystem = new Subsystem() {};
    Translation2d[] locations;

    @Override
    public Pose2d pose() {
      return pose;
    }

    @Override
    public ChassisSpeeds robotSpeeds() {
      return ChassisSpeeds.fromFieldRelativeSpeeds(field, pose.getRotation());
    }

    @Override
    public void resetPose(Pose2d p) {
      pose = p;
    }

    @Override
    public void drive(AresSetpoint s) {
      field = s.fieldSpeeds();
      setpoints.add(s);
    }

    @Override
    public void stop() {
      field = new ChassisSpeeds();
    }

    @Override
    public Translation2d[] moduleLocations() {
      return locations;
    }

    @Override
    public Subsystem subsystem() {
      return subsystem;
    }

    void step(double dt) {
      pose = new Pose2d(
          pose.getX() + field.vxMetersPerSecond * dt,
          pose.getY() + field.vyMetersPerSecond * dt,
          pose.getRotation().plus(new Rotation2d(field.omegaRadiansPerSecond * dt)));
    }
  }

  PerfectDrive drive;
  boolean red;
  Ares ares;

  @BeforeEach
  void setUp() {
    HAL.initialize(500, 0);
    SimHooks.pauseTiming();
    DriverStationSim.setEnabled(true);
    DriverStationSim.setAutonomous(true);
    DriverStationSim.notifyNewData();
    CommandScheduler.getInstance().cancelAll();
    drive = new PerfectDrive();
    red = false;
    ares = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> red));
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().cancelAll();
    CommandScheduler.getInstance().unregisterAllSubsystems();
    CommandScheduler.getInstance().getActiveButtonLoop().clear();
    SimHooks.resumeTiming();
  }

  /** Runs the scheduler until the command ends (or the time runs out); returns the seconds it took. */
  double run(Command c, double maxS) {
    CommandScheduler.getInstance().schedule(c);
    double t = 0;
    while (t < maxS) {
      CommandScheduler.getInstance().run();
      if (!CommandScheduler.getInstance().isScheduled(c)) break;
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
      t += 0.02;
    }
    return t;
  }

  @Test
  void drivesThePathAndEndsWhereItEnds() throws Exception {
    var traj = TrajectoryTest.main();
    drive.pose = traj.initial().pose();
    double took = run(ares.path("Main"), 10);
    assertEquals(traj.duration(), took, 0.06);
    assertEquals(traj.last().x(), drive.pose.getX(), 0.03);
    assertEquals(traj.last().y(), drive.pose.getY(), 0.03);
    assertEquals(traj.last().heading(), drive.pose.getRotation().getRadians(), 0.03);
    // It fed the forces forward all the way, and stopped at the end.
    assertTrue(drive.setpoints.stream().allMatch(s -> s.wheelForceXField().length == 4));
    assertEquals(0, Math.hypot(drive.field.vxMetersPerSecond, drive.field.vyMetersPerSecond), 1e-9);
  }

  @Test
  void theFeedbackPullsItBackOn() throws Exception {
    var traj = TrajectoryTest.main();
    drive.pose = new Pose2d(traj.initial().x() + 0.15, traj.initial().y() - 0.1, new Rotation2d(0.2));
    run(ares.path("Main"), 10);
    assertEquals(traj.last().x(), drive.pose.getX(), 0.05);
    assertEquals(traj.last().y(), drive.pose.getY(), 0.05);
  }

  @Test
  void onRedItDrivesTheFlippedPath() throws Exception {
    red = true;
    var traj = TrajectoryTest.main();
    var start = FieldSymmetry.ROTATIONAL.flip(traj.initial().pose(), 16.541, 8.0692);
    drive.pose = start;
    run(ares.path("Main"), 10);
    var end = FieldSymmetry.ROTATIONAL.flip(traj.last().pose(), 16.541, 8.0692);
    assertEquals(end.getX(), drive.pose.getX(), 0.03);
    assertEquals(end.getY(), drive.pose.getY(), 0.03);
  }

  @Test
  void runsTheMarkersCommandsAndEndsTheZones() throws Exception {
    var intake = new AtomicInteger();
    var spinStarted = new AtomicInteger();
    var spinEnded = new ArrayList<Boolean>();
    var spinEndT = new ArrayList<Double>();
    var clock = new double[1];
    ares.registerCommand("intake", Commands.runOnce(intake::incrementAndGet));
    ares.registerCommand("spin", Commands.startEnd(spinStarted::incrementAndGet, () -> {
      spinEnded.add(true);
      spinEndT.add(clock[0]);
    }));
    var triggered = new AtomicInteger();
    ares.event("intake").onTrue(Commands.runOnce(triggered::incrementAndGet));

    drive.pose = TrajectoryTest.main().initial().pose();
    var c = ares.path("Main");
    CommandScheduler.getInstance().schedule(c);
    for (double t = 0; t < 4 && CommandScheduler.getInstance().isScheduled(c); t += 0.02) {
      clock[0] = t;
      CommandScheduler.getInstance().run();
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
    }
    assertEquals(1, intake.get());
    assertEquals(1, triggered.get());
    assertEquals(1, spinStarted.get());
    // The zone is 0.1 s to 0.6 s: it was cut there, not at the end of the path.
    assertEquals(1, spinEnded.size());
    assertEquals(0.6, spinEndT.get(0), 0.05);
  }

  @Test
  void takesTheBranchWhenItsConditionHolds() throws Exception {
    var alt = ares.trajectory("Alt");
    ares.registerCondition("goAlt", () -> true);
    drive.pose = TrajectoryTest.main().initial().pose();
    run(ares.path("Main"), 10);
    assertEquals(alt.last().x(), drive.pose.getX(), 0.05);
    assertEquals(alt.last().y(), drive.pose.getY(), 0.05);
  }

  @Test
  void letsTheBranchGoByWhenItDoesNot() throws Exception {
    ares.registerCondition("goAlt", () -> false);
    var main = TrajectoryTest.main();
    drive.pose = main.initial().pose();
    run(ares.path("Main"), 10);
    assertEquals(main.last().x(), drive.pose.getX(), 0.03);
  }

  @Test
  void anAutoThatGoesOnToABranchLeavesAtTheBranchPoint() throws Exception {
    // Main then Alt: Main is driven only up to the waypoint Alt leaves from.
    var main = TrajectoryTest.main();
    var alt = ares.trajectory("Alt");
    drive.pose = new Pose2d(9, 9, new Rotation2d()); // reset by the auto
    double took = run(ares.auto("Branchy"), 10);
    assertEquals(main.waypointTimes().get(1) + alt.duration(), took, 0.1);
    assertEquals(alt.last().x(), drive.pose.getX(), 0.05);
    assertEquals(alt.last().y(), drive.pose.getY(), 0.05);
  }

  @Test
  void buildsEveryKindOfStep() {
    var shots = new AtomicInteger();
    var spinning = new AtomicInteger();
    ares.registerCommand("shoot", Commands.runOnce(shots::incrementAndGet));
    ares.registerCommand("spinUp", Commands.startEnd(spinning::incrementAndGet, spinning::decrementAndGet));
    ares.registerCondition("hasPiece", () -> true);
    drive.pose = new Pose2d(9, 9, new Rotation2d());
    var auto = ares.auto("Full");
    run(auto, 10);
    // shoot once after the path, once more in the nested auto.
    assertEquals(2, shots.get());
    // The alongside command ran through the auto and was stopped with it.
    assertEquals(0, spinning.get());
    // A step from a newer Ares is skipped, not a crash; a loop is refused.
    assertFalse(CommandScheduler.getInstance().isScheduled(auto));
    run(ares.auto("Loop"), 1);
  }

  /** The default pathfinder, counting how often it is asked. */
  Ares counting(AtomicInteger calls) {
    var straight = new StraightPathfinder(drive, new AresController.Gains(4, 0, 0), new AresController.Gains(4, 0, 0), 0.05, 0.05);
    return new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> false)
        .withPathfinder((goal, end, c) -> {
          calls.incrementAndGet();
          return straight.toPose(goal, end, c);
        }));
  }

  @Test
  void onAPathfindStretchItFollowsTheEstimateWhenItIsWhereAresExpected() {
    var calls = new AtomicInteger();
    ares = counting(calls);
    var traj = ares.trajectory("Find");
    drive.pose = traj.initial().pose();
    double took = run(ares.path("Find"), 10);
    assertEquals(0, calls.get());
    assertEquals(traj.duration(), took, 0.06);
    assertEquals(traj.last().x(), drive.pose.getX(), 0.03);
    assertEquals(traj.last().y(), drive.pose.getY(), 0.03);
  }

  @Test
  void onAPathfindStretchItFindsItsWayWhenItIsNot() {
    var calls = new AtomicInteger();
    ares = counting(calls);
    var traj = ares.trajectory("Find");
    var span = traj.pathfind().get(0);
    double spanStart = traj.samples().get(span.startSample()).t();
    drive.pose = traj.initial().pose();
    var c = ares.path("Find");
    CommandScheduler.getInstance().schedule(c);
    boolean bumped = false;
    for (double t = 0; t < 15 && CommandScheduler.getInstance().isScheduled(c); t += 0.02) {
      // Knocked half a meter sideways just before the stretch.
      if (!bumped && t > spanStart - 0.1) {
        drive.pose = new Pose2d(drive.pose.getX(), drive.pose.getY() + 0.5, drive.pose.getRotation());
        bumped = true;
      }
      CommandScheduler.getInstance().run();
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
    }
    assertEquals(1, calls.get());
    assertFalse(CommandScheduler.getInstance().isScheduled(c));
    assertEquals(traj.last().x(), drive.pose.getX(), 0.05);
    assertEquals(traj.last().y(), drive.pose.getY(), 0.05);
  }

  /** Drives Main, knocking the robot {@code byM} sideways at 0.6 s; returns the command. */
  FollowPath knocked(double byM) throws Exception {
    var c = (FollowPath) ares.path("Main");
    drive.pose = TrajectoryTest.main().initial().pose();
    CommandScheduler.getInstance().schedule(c);
    boolean hit = false;
    for (double t = 0; t < 10 && CommandScheduler.getInstance().isScheduled(c); t += 0.02) {
      if (!hit && t >= 0.6) {
        drive.pose = new Pose2d(drive.pose.getX(), drive.pose.getY() + byM, drive.pose.getRotation());
        hit = true;
      }
      CommandScheduler.getInstance().run();
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
    }
    return c;
  }

  @Test
  void knockedFarOffItFindsItsWayBackAndFinishesThePath() throws Exception {
    var calls = new AtomicInteger();
    ares = counting(calls);
    // A perfect drive pulls 0.9 m back by feedback in ~0.15 s; 1.6 m stays off long enough.
    var c = knocked(1.6);
    assertEquals(1, calls.get());
    assertEquals(1, c.replans());
    var main = TrajectoryTest.main();
    assertEquals(main.last().x(), drive.pose.getX(), 0.05);
    assertEquals(main.last().y(), drive.pose.getY(), 0.05);
  }

  /** Main, knocked 0.3 m sideways on its very last step. */
  FollowPath knockedAtTheEnd(Ares a) throws Exception {
    var c = (FollowPath) a.path("Main");
    var main = TrajectoryTest.main();
    drive.pose = main.initial().pose();
    CommandScheduler.getInstance().schedule(c);
    boolean hit = false;
    for (double t = 0; t < 10 && CommandScheduler.getInstance().isScheduled(c); t += 0.02) {
      if (!hit && t >= main.duration() - 0.03) {
        drive.pose = new Pose2d(drive.pose.getX(), drive.pose.getY() + 0.3, drive.pose.getRotation());
        hit = true;
      }
      CommandScheduler.getInstance().run();
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
    }
    return c;
  }

  @Test
  void shovedAtTheEndItStillArrives() throws Exception {
    var calls = new AtomicInteger();
    ares = counting(calls);
    var c = knockedAtTheEnd(ares);
    var main = TrajectoryTest.main();
    assertEquals(1, calls.get());
    assertEquals(1, c.replans());
    assertEquals(main.last().x(), drive.pose.getX(), 0.06);
    assertEquals(main.last().y(), drive.pose.getY(), 0.06);
  }

  @Test
  void withoutArrivalItEndsWhereTheShoveLeftIt() throws Exception {
    ares = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> false).withArrival(0));
    knockedAtTheEnd(ares);
    assertTrue(Math.abs(drive.pose.getY() - TrajectoryTest.main().last().y()) > 0.2);
  }

  @Test
  void aSmallKnockIsLeftToTheFeedback() throws Exception {
    var calls = new AtomicInteger();
    ares = counting(calls);
    var c = knocked(0.25);
    assertEquals(0, calls.get());
    assertEquals(0, c.replans());
  }

  @Test
  void anUngeneratedPathEndsAtOnce() {
    assertEquals(0, run(ares.path("Never"), 1), 0.03);
  }

  @Test
  void handsTheForcesOverInTheDrivetrainsOrder() throws Exception {
    // A drivetrain that lists its modules br, bl, fr, fl.
    double p = 0.276225;
    drive.locations = new Translation2d[] {
      new Translation2d(-p, -p), new Translation2d(-p, p), new Translation2d(p, -p), new Translation2d(p, p)
    };
    ares = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> false));
    var traj = TrajectoryTest.main();
    drive.pose = traj.initial().pose();
    CommandScheduler.getInstance().schedule(ares.path("Main"));
    CommandScheduler.getInstance().run();
    var sent = drive.setpoints.get(0);
    var s = traj.initial();
    assertEquals(s.moduleForceXN()[3], sent.wheelForceXField()[0], 1e-9);
    assertEquals(s.moduleForceXN()[0], sent.wheelForceXField()[3], 1e-9);
    assertEquals(s.moduleForceYN()[1], sent.wheelForceYField()[2], 1e-9);
  }
}
