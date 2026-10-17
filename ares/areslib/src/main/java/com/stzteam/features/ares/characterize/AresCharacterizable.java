package com.stzteam.features.ares.characterize;

import edu.wpi.first.wpilibj2.command.Subsystem;

/**
 * What the characterization routines need from a swerve: to put a voltage on
 * the drives (wheels tangent, so the robot spins in place) or on the steers
 * (the robot stays put), and to read back how fast and how far they turned
 * and what the gyro says. {@link com.stzteam.features.ares.ctre.CtreSwerve}
 * provides one for a CTRE swerve.
 *
 * <p>Speeds are in the units the motor controller's gains use: for a Tuner X
 * swerve, the drive's ROTOR rotations per second, and the steer's MECHANISM
 * rotations per second (it closes the loop on the CANcoder).
 */
public interface AresCharacterizable {
  int modules();

  /** Every drive at {@code volts}, the wheels tangent to the circle: the robot spins in place. */
  void spinDrives(double volts);

  /** Every steer motor at {@code volts}; the drives do nothing. */
  void spinSteers(double volts);

  /** Spins the robot in place at {@code radps} with the drivetrain's own closed loop. */
  void rotate(double radps);

  void stop();

  double[] driveRps();

  /** Drive rotor rotations, for distance. */
  double[] driveRotations();

  double[] steerRps();

  double gyroRateRadps();

  /** Continuous (not wrapped) yaw, radians. */
  double gyroYawRad();

  /** Rotor rotations per wheel rotation. */
  double driveGearRatio();

  /** The wheel radius the code is configured with. */
  double wheelRadiusM();

  /** Robot center to a module. */
  double moduleRadiusM();

  /** {@code kSpeedAt12Volts}, for the theoretical kV. */
  double speedAt12vMps();

  Subsystem subsystem();
}
