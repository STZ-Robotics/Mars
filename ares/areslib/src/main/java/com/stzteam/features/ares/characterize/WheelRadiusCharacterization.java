package com.stzteam.features.ares.characterize;

import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.Command;

/**
 * The wheels' true radius: the robot spins slowly in place, and the gyro's
 * angle times the modules' distance from the center is how far each wheel
 * rolled; divided by how many times it turned, that is its radius. Worn
 * treads read smaller, and odometry built on the nominal radius overshoots.
 */
public class WheelRadiusCharacterization extends Command {
  static final String NAME = "WheelRadius";
  private final AresCharacterizable hw;
  private final double rateRadps;
  private final double seconds;
  private final Timer timer = new Timer();
  private double yaw0;
  private double[] rot0;
  private double radius = Double.NaN;

  public WheelRadiusCharacterization(AresCharacterizable hw, double rateRadps, double seconds) {
    this.hw = hw;
    this.rateRadps = rateRadps;
    this.seconds = seconds;
    addRequirements(hw.subsystem());
    setName("Characterize wheel radius");
  }

  @Override
  public void initialize() {
    radius = Double.NaN;
    timer.restart();
    yaw0 = Double.NaN;
    CharacterizationTelemetry.start(NAME, "running", 1);
  }

  @Override
  public void execute() {
    hw.rotate(rateRadps);
    // A moment to get turning before the start is taken.
    if (Double.isNaN(yaw0) && timer.get() > 1.0) {
      yaw0 = hw.gyroYawRad();
      rot0 = hw.driveRotations();
    }
    if (!Double.isNaN(yaw0)) {
      double r = estimate();
      CharacterizationTelemetry.progress(NAME, Math.min(1, (timer.get() - 1.0) / seconds));
      if (Double.isFinite(r)) CharacterizationTelemetry.table(NAME).getEntry("LiveRadiusM").setDouble(r);
    }
  }

  private double estimate() {
    double turned = Math.abs(hw.gyroYawRad() - yaw0);
    var rot = hw.driveRotations();
    double wheelRad = 0;
    for (int i = 0; i < rot.length; i++) wheelRad += Math.abs(rot[i] - rot0[i]) / hw.driveGearRatio() * 2 * Math.PI / rot.length;
    return wheelRad > 1e-6 ? turned * hw.moduleRadiusM() / wheelRad : Double.NaN;
  }

  @Override
  public boolean isFinished() {
    return timer.get() > 1.0 + seconds;
  }

  @Override
  public void end(boolean interrupted) {
    hw.stop();
    if (interrupted || Double.isNaN(yaw0)) {
      CharacterizationTelemetry.state(NAME, "stopped");
      return;
    }
    radius = estimate();
    CharacterizationTelemetry.result(NAME, "WheelRadiusM", radius);
    CharacterizationTelemetry.result(NAME, "TurnedRad", Math.abs(hw.gyroYawRad() - yaw0));
    CharacterizationTelemetry.state(NAME, "done");
  }

  public double radius() {
    return radius;
  }
}
