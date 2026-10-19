package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Subsystem;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** A .robot.json whose drive is not the drivetrain's is an alert: the paths were planned for another robot. */
class MechanicsCheckTest {

  /** A drivetrain that only reports its mechanics. */
  static AresDrive withMechanics(AresDrive.Mechanics mechanics) {
    var subsystem = new Subsystem() {};
    return new AresDrive() {
      @Override public Pose2d pose() { return Pose2d.kZero; }
      @Override public ChassisSpeeds robotSpeeds() { return new ChassisSpeeds(); }
      @Override public void resetPose(Pose2d pose) {}
      @Override public void drive(AresSetpoint setpoint) {}
      @Override public Subsystem subsystem() { return subsystem; }
      @Override public Mechanics mechanics() { return mechanics; }
    };
  }

  static Ares aresFor(AresDrive.Mechanics mechanics) {
    return new Ares(withMechanics(mechanics), new Ares.Config().withFolder(TrajectoryTest.PROJECT).withHotReload(false));
  }

  @BeforeEach
  void setUp() {
    HAL.initialize(500, 0);
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().unregisterAllSubsystems();
    CommandScheduler.getInstance().getActiveButtonLoop().clear();
  }

  @Test
  void theSameRobotSaysNothing() {
    // The fixture's .robot.json: 2 in wheels, 5.27:1, 120 A. A wheel a little worn is still the same robot.
    var ares = aresFor(new AresDrive.Mechanics(0.0500, 5.2734375, 120));
    assertTrue(ares.warnings().isEmpty(), ares.warnings().toString());
  }

  @Test
  void anotherGearRatioIsAnAlertThatSaysBoth() {
    var ares = aresFor(new AresDrive.Mechanics(0.0508, 6.75, 120));
    assertEquals(1, ares.warnings().size());
    var w = ares.warnings().iterator().next();
    assertTrue(w.contains("gear ratio 5.2734 in the .robot.json, 6.7500 on the robot"), w);
    assertTrue(!w.contains("wheel radius") && !w.contains("current limit"), w);
  }

  @Test
  void everyMismatchIsListed() {
    var w = aresFor(new AresDrive.Mechanics(0.0381, 6.75, 60)).warnings().iterator().next();
    assertTrue(w.contains("gear ratio") && w.contains("wheel radius") && w.contains("current limit"), w);
  }

  @Test
  void aDrivetrainThatDoesNotSayIsNotChecked() {
    assertTrue(aresFor(null).warnings().isEmpty());
    assertTrue(aresFor(new AresDrive.Mechanics(Double.NaN, Double.NaN, Double.NaN)).warnings().isEmpty());
  }

  @Test
  void aPathFasterThanTheDrivetrainIsAnAlert() {
    // The fixture's paths were planned near the motor's free speed (~6 m/s); a drivetrain that
    // only reaches 3 m/s at 12 V cannot follow them.
    var w = String.join("; ", aresFor(new AresDrive.Mechanics(0.0508, 5.2734375, 120, 3.0)).warnings());
    assertTrue(w.contains("asks for up to") && w.contains("3.00 m/s at 12 V") && w.contains("maxSpeedFraction"), w);
    assertTrue(aresFor(new AresDrive.Mechanics(0.0508, 5.2734375, 120, 10.0)).warnings().isEmpty());
  }
}
