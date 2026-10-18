package com.stzteam.features.ares.characterize;

import edu.wpi.first.wpilibj.smartdashboard.SmartDashboard;
import edu.wpi.first.wpilibj2.command.Command;
import java.util.List;

/**
 * The swerve's characterization, with no logs and no SysId: three routines
 * that measure and publish as they run, for Ares's Characterize tab (which
 * starts them from the app) or any dashboard.
 *
 * <pre>{@code
 * AresCharacterization.publish(CtreSwerve.of(drivetrain).characterizable(TunerConstants.FrontLeft));
 * }</pre>
 *
 * <ul>
 *   <li><b>Drive</b>: spins in place stepping the drives' voltage both ways:
 *       kS and kV of the drive (rotor rps, Tuner X's units), and the wheel
 *       radius from the gyro on the side. About 1.5 m of room.
 *   <li><b>Steer</b>: the robot stays put; the modules turn stepping the
 *       steers' voltage: kS and kV of the steer (mechanism rps).
 *   <li><b>WheelRadius</b>: spins slowly for a while; the gyro's angle
 *       against how far the wheels rolled gives their true radius.
 * </ul>
 *
 * <p>Each one needs the robot enabled (teleop). The buttons are on
 * SmartDashboard under {@code Ares Characterize/}.
 */
public final class AresCharacterization {
  private AresCharacterization() {}

  /** The drive sweep: kS, kV, and the wheel radius from the gyro. */
  public static VoltageSweep drive(AresCharacterizable hw) {
    return new VoltageSweep("Drive", new double[] {1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0}, 1.5, 0.5, 80,
        hw::spinDrives, () -> mean(hw.driveRps()), hw::gyroRateRadps, hw::stop, hw.subsystem()) {
      @Override
      protected void finish(List<Point> moved) {
        // The wheel radius from the gyro: robot rate × module radius is how
        // fast the treads move; over how fast the wheels turn.
        double sum = 0;
        int k = 0;
        for (var p : moved) {
          double wheelRps = p.speed() / hw.driveGearRatio();
          if (p.extra() > 1.0 && wheelRps > 0) {
            sum += p.extra() * hw.moduleRadiusM() / (2 * Math.PI * wheelRps);
            k++;
          }
        }
        if (k > 0) CharacterizationTelemetry.result("Drive", "WheelRadiusM", sum / k);
        CharacterizationTelemetry.result("Drive", "kVTheory",
            12.0 / (hw.speedAt12vMps() / (2 * Math.PI * hw.wheelRadiusM()) * hw.driveGearRatio()));
      }
    };
  }

  /** The steer sweep: kS and kV of the steer motors. */
  public static VoltageSweep steer(AresCharacterizable hw) {
    return new VoltageSweep("Steer", new double[] {0.3, 0.5, 0.75, 1.0, 1.5, 2.0}, 0.75, 0.5, 6,
        hw::spinSteers, () -> mean(hw.steerRps()), null, hw::stop, hw.subsystem());
  }

  public static WheelRadiusCharacterization wheelRadius(AresCharacterizable hw) {
    return new WheelRadiusCharacterization(hw, 1.0, 6.0);
  }

  /** The three as SmartDashboard buttons; Ares's Characterize tab presses them. */
  public static void publish(AresCharacterizable hw) {
    put("Drive", drive(hw));
    put("Steer", steer(hw));
    put("WheelRadius", wheelRadius(hw));
    for (var name : List.of("Drive", "Steer", "WheelRadius")) CharacterizationTelemetry.state(name, "idle");
  }

  private static void put(String name, Command c) {
    SmartDashboard.putData("Ares Characterize/" + name, c);
  }

  static double mean(double[] v) {
    double s = 0;
    for (double x : v) s += Math.abs(x);
    return v.length == 0 ? 0 : s / v.length;
  }
}
