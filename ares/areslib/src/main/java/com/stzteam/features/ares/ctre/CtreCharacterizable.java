package com.stzteam.features.ares.ctre;

import com.ctre.phoenix6.BaseStatusSignal;
import com.ctre.phoenix6.StatusSignal;
import com.ctre.phoenix6.swerve.SwerveDrivetrain;
import com.ctre.phoenix6.swerve.SwerveModuleConstants;
import com.ctre.phoenix6.swerve.SwerveRequest;
import com.stzteam.features.ares.characterize.AresCharacterizable;
import edu.wpi.first.units.measure.Angle;
import edu.wpi.first.units.measure.AngularVelocity;
import edu.wpi.first.wpilibj2.command.Subsystem;

/**
 * A CTRE swerve for the characterization routines: SysIdSwerveRotation to
 * spin the drives, SysIdSwerveSteerGains to turn the steers, the TalonFX
 * signals and the Pigeon 2.
 */
final class CtreCharacterizable implements AresCharacterizable {
  private final SwerveDrivetrain<?, ?, ?> dt;
  private final Subsystem subsystem;
  private final SwerveModuleConstants<?, ?, ?> constants;
  private final SwerveRequest.SysIdSwerveRotation spin = new SwerveRequest.SysIdSwerveRotation();
  private final SwerveRequest.SysIdSwerveSteerGains steer = new SwerveRequest.SysIdSwerveSteerGains();
  private final SwerveRequest.RobotCentric rotate = new SwerveRequest.RobotCentric();
  private final SwerveRequest.Idle idle = new SwerveRequest.Idle();
  private final StatusSignal<AngularVelocity>[] driveVel;
  private final StatusSignal<Angle>[] drivePos;
  private final StatusSignal<AngularVelocity>[] steerVel;
  private final StatusSignal<AngularVelocity> yawRate;
  private final StatusSignal<Angle> yaw;
  private final BaseStatusSignal[] all;
  private final double moduleRadius;

  @SuppressWarnings("unchecked")
  CtreCharacterizable(SwerveDrivetrain<?, ?, ?> dt, Subsystem subsystem, SwerveModuleConstants<?, ?, ?> constants) {
    this.dt = dt;
    this.subsystem = subsystem;
    this.constants = constants;
    int n = dt.getModuleLocations().length;
    driveVel = new StatusSignal[n];
    drivePos = new StatusSignal[n];
    steerVel = new StatusSignal[n];
    for (int i = 0; i < n; i++) {
      driveVel[i] = dt.getModule(i).getDriveMotor().getVelocity();
      drivePos[i] = dt.getModule(i).getDriveMotor().getPosition();
      steerVel[i] = dt.getModule(i).getSteerMotor().getVelocity();
    }
    yawRate = dt.getPigeon2().getAngularVelocityZWorld();
    yaw = dt.getPigeon2().getYaw();
    all = new BaseStatusSignal[3 * n + 2];
    for (int i = 0; i < n; i++) {
      all[3 * i] = driveVel[i];
      all[3 * i + 1] = drivePos[i];
      all[3 * i + 2] = steerVel[i];
    }
    all[3 * n] = yawRate;
    all[3 * n + 1] = yaw;
    moduleRadius = dt.getModuleLocations()[0].getNorm();
  }

  private void refresh() {
    BaseStatusSignal.refreshAll(all);
  }

  @Override
  public int modules() {
    return driveVel.length;
  }

  @Override
  public void spinDrives(double volts) {
    // SysIdSwerveRotation puts RotationalRate · r / speedAt12V · 12 volts on each drive.
    dt.setControl(spin.withRotationalRate(volts * constants.SpeedAt12Volts / (12.0 * moduleRadius)));
  }

  @Override
  public void spinSteers(double volts) {
    dt.setControl(steer.withVolts(volts));
  }

  @Override
  public void rotate(double radps) {
    dt.setControl(rotate.withVelocityX(0).withVelocityY(0).withRotationalRate(radps));
  }

  @Override
  public void stop() {
    dt.setControl(idle);
  }

  @Override
  public double[] driveRps() {
    refresh();
    var out = new double[driveVel.length];
    for (int i = 0; i < out.length; i++) out[i] = driveVel[i].getValueAsDouble();
    return out;
  }

  @Override
  public double[] driveRotations() {
    refresh();
    var out = new double[drivePos.length];
    for (int i = 0; i < out.length; i++) out[i] = drivePos[i].getValueAsDouble();
    return out;
  }

  @Override
  public double[] steerRps() {
    refresh();
    var out = new double[steerVel.length];
    for (int i = 0; i < out.length; i++) out[i] = steerVel[i].getValueAsDouble();
    return out;
  }

  @Override
  public double gyroRateRadps() {
    refresh();
    return Math.toRadians(yawRate.getValueAsDouble());
  }

  @Override
  public double gyroYawRad() {
    refresh();
    // The Pigeon 2's yaw is continuous: it does not wrap at ±180°.
    return Math.toRadians(yaw.getValueAsDouble());
  }

  @Override
  public double driveGearRatio() {
    return constants.DriveMotorGearRatio;
  }

  @Override
  public double wheelRadiusM() {
    return constants.WheelRadius;
  }

  @Override
  public double moduleRadiusM() {
    return moduleRadius;
  }

  @Override
  public double speedAt12vMps() {
    return constants.SpeedAt12Volts;
  }

  @Override
  public Subsystem subsystem() {
    return subsystem;
  }
}
