package com.stzteam.features.ares.ctre;

import com.ctre.phoenix6.swerve.SwerveDrivetrain;
import com.ctre.phoenix6.swerve.SwerveModule.DriveRequestType;
import com.ctre.phoenix6.swerve.SwerveRequest;
import com.stzteam.features.ares.AresDrive;
import com.stzteam.features.ares.AresSetpoint;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj2.command.Subsystem;

/**
 * A CTRE Phoenix 6 swerve (the {@code CommandSwerveDrivetrain} Tuner X
 * generates) as an {@link AresDrive}.
 *
 * <pre>{@code
 * Ares ares = new Ares(CtreSwerve.of(drivetrain), new Ares.Config());
 * }</pre>
 *
 * <p>It drives with {@code ApplyFieldSpeeds} in closed-loop velocity, with the
 * wheel forces Ares solved as {@code WheelForceFeedforwardsX/Y}: CTRE turns
 * them into torque current (or voltage) per module through the drive motor's
 * constants, which is the feedforward a trajectory with forces is for.
 *
 * <p>Needs the Phoenix 6 vendordep in the robot project (it has it if it has a
 * CTRE swerve); AresLib itself does not ship it.
 */
public final class CtreSwerve implements AresDrive {
  private final SwerveDrivetrain<?, ?, ?> drivetrain;
  private final Subsystem subsystem;
  private final SwerveRequest.ApplyFieldSpeeds follow = new SwerveRequest.ApplyFieldSpeeds()
      .withDriveRequestType(DriveRequestType.Velocity)
      // The trajectory is in the field's frame, blue origin: not the
      // operator's perspective, which is the default and flips on red.
      .withForwardPerspective(SwerveRequest.ForwardPerspectiveValue.BlueAlliance);
  private final SwerveRequest.ApplyRobotSpeeds stop = new SwerveRequest.ApplyRobotSpeeds();

  public CtreSwerve(SwerveDrivetrain<?, ?, ?> drivetrain, Subsystem subsystem) {
    this.drivetrain = drivetrain;
    this.subsystem = subsystem;
  }

  /** For the usual case, a drivetrain that is its own subsystem. */
  public static <T extends SwerveDrivetrain<?, ?, ?> & Subsystem> CtreSwerve of(T drivetrain) {
    return new CtreSwerve(drivetrain, drivetrain);
  }

  /** Open-loop voltage instead of closed-loop velocity, for a drive without velocity gains. */
  public CtreSwerve openLoop() {
    follow.withDriveRequestType(DriveRequestType.OpenLoopVoltage);
    return this;
  }

  @Override
  public Pose2d pose() {
    return drivetrain.getState().Pose;
  }

  @Override
  public ChassisSpeeds robotSpeeds() {
    return drivetrain.getState().Speeds;
  }

  @Override
  public void resetPose(Pose2d pose) {
    drivetrain.resetPose(pose);
  }

  @Override
  public void drive(AresSetpoint setpoint) {
    drivetrain.setControl(follow
        .withSpeeds(setpoint.fieldSpeeds())
        .withWheelForceFeedforwardsX(setpoint.wheelForceXField())
        .withWheelForceFeedforwardsY(setpoint.wheelForceYField()));
  }

  @Override
  public void stop() {
    drivetrain.setControl(stop.withSpeeds(new ChassisSpeeds()));
  }

  @Override
  public Translation2d[] moduleLocations() {
    return drivetrain.getModuleLocations();
  }

  @Override
  public Subsystem subsystem() {
    return subsystem;
  }

  /**
   * The same drivetrain for the characterization routines, with one module's
   * constants from TunerConstants (the gear ratio, wheel radius and speed at
   * 12 V are the same for all):
   * {@code AresCharacterization.publish(CtreSwerve.of(drivetrain).characterizable(TunerConstants.FrontLeft))}.
   */
  public com.stzteam.features.ares.characterize.AresCharacterizable characterizable(com.ctre.phoenix6.swerve.SwerveModuleConstants<?, ?, ?> module) {
    return new CtreCharacterizable(drivetrain, subsystem, module);
  }
}
