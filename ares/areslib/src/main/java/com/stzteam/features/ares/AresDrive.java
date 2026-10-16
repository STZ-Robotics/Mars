package com.stzteam.features.ares;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj2.command.Subsystem;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * What Ares needs from a drivetrain. Any swerve works: {@link
 * com.stzteam.features.ares.ctre.CtreSwerve} adapts a CTRE one, and {@link
 * #of} builds one from four lambdas.
 */
public interface AresDrive {
  /** Where the robot is, field frame, blue origin. */
  Pose2d pose();

  /** How fast it is moving, robot frame. */
  ChassisSpeeds robotSpeeds();

  /** Odometry reset, at the start of an auto that starts at a known pose. */
  void resetPose(Pose2d pose);

  /** Drives one control loop toward the setpoint. */
  void drive(AresSetpoint setpoint);

  /** The subsystem every Ares command requires. */
  Subsystem subsystem();

  /** Stops, when a path is interrupted. Defaults to driving at zero speed. */
  default void stop() {
    drive(AresSetpoint.stopped(pose()));
  }

  /**
   * Where the drivetrain's modules are, robot frame, in the order it takes them.
   * Ares matches them by position with the {@code .robot.json}'s and hands the
   * wheel forces over in this order, so the two need not list the modules alike;
   * it warns when they do not describe the same robot. Null (the default): the
   * forces go in the {@code .robot.json}'s order.
   */
  default Translation2d[] moduleLocations() {
    return null;
  }

  static AresDrive of(
      Supplier<Pose2d> pose,
      Supplier<ChassisSpeeds> robotSpeeds,
      Consumer<Pose2d> resetPose,
      Consumer<AresSetpoint> drive,
      Subsystem subsystem) {
    return new AresDrive() {
      @Override
      public Pose2d pose() {
        return pose.get();
      }

      @Override
      public ChassisSpeeds robotSpeeds() {
        return robotSpeeds.get();
      }

      @Override
      public void resetPose(Pose2d p) {
        resetPose.accept(p);
      }

      @Override
      public void drive(AresSetpoint setpoint) {
        drive.accept(setpoint);
      }

      @Override
      public Subsystem subsystem() {
        return subsystem;
      }
    };
  }
}
