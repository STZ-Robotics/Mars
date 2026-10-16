package com.stzteam.features.ares;

import com.stzteam.features.ares.trajectory.AresSample;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;

/**
 * One control loop's worth of command: the speeds to drive (the trajectory's,
 * plus the feedback that pulls the robot back onto it) and the force each wheel
 * should be putting on the carpet, which is what the trajectory was solved for.
 *
 * <p>Feeding the forces forward is what makes the robot track an aggressive
 * trajectory without the feedback chasing it: CTRE takes them as {@code
 * withWheelForceFeedforwardsX/Y}; anything else can turn them into a current or
 * a voltage per module.
 *
 * @param target where the trajectory is now (the reference the feedback pulls toward)
 * @param fieldSpeeds the speeds to drive, field frame, feedback included
 * @param robotSpeeds the same, robot frame
 * @param wheelForceXField per module, field frame, newtons
 * @param wheelForceYField per module, field frame, newtons
 * @param wheelForceXRobot per module, robot frame, newtons
 * @param wheelForceYRobot per module, robot frame, newtons
 * @param sample the trajectory state itself; null while pathfinding or stopping
 */
public record AresSetpoint(
    Pose2d target,
    ChassisSpeeds fieldSpeeds,
    ChassisSpeeds robotSpeeds,
    double[] wheelForceXField,
    double[] wheelForceYField,
    double[] wheelForceXRobot,
    double[] wheelForceYRobot,
    AresSample sample) {

  static AresSetpoint of(AresSample s, ChassisSpeeds fieldSpeeds, Rotation2d robotHeading) {
    return new AresSetpoint(
        s.pose(),
        fieldSpeeds,
        ChassisSpeeds.fromFieldRelativeSpeeds(fieldSpeeds, robotHeading),
        s.moduleForceXN(),
        s.moduleForceYN(),
        rotate(s.moduleForceXN(), s.moduleForceYN(), robotHeading, true),
        rotate(s.moduleForceXN(), s.moduleForceYN(), robotHeading, false),
        s);
  }

  /** The same, with the modules in another order: {@code order[k]} is the module that goes k-th. */
  public AresSetpoint reordered(int[] order) {
    if (order == null || wheelForceXField.length != order.length) return this;
    return new AresSetpoint(
        target, fieldSpeeds, robotSpeeds, pick(wheelForceXField, order), pick(wheelForceYField, order),
        pick(wheelForceXRobot, order), pick(wheelForceYRobot, order), sample);
  }

  private static double[] pick(double[] a, int[] order) {
    var out = new double[order.length];
    for (int k = 0; k < order.length; k++) out[k] = a[order[k]];
    return out;
  }

  /** Speeds only, no forces: what a pathfinding stretch drives. */
  public static AresSetpoint speeds(Pose2d target, ChassisSpeeds fieldSpeeds, Rotation2d robotHeading, int modules) {
    var zero = new double[modules];
    return new AresSetpoint(
        target, fieldSpeeds, ChassisSpeeds.fromFieldRelativeSpeeds(fieldSpeeds, robotHeading),
        zero, zero, zero, zero, null);
  }

  public static AresSetpoint stopped(Pose2d at) {
    return speeds(at, new ChassisSpeeds(), at.getRotation(), 0);
  }

  // The forces were solved against the trajectory's heading, but the wheels
  // push in the robot's frame: turn them with the robot's actual heading.
  private static double[] rotate(double[] fx, double[] fy, Rotation2d heading, boolean x) {
    double c = heading.getCos(), s = heading.getSin();
    var out = new double[fx.length];
    for (int i = 0; i < out.length; i++) out[i] = x ? c * fx[i] + s * fy[i] : -s * fx[i] + c * fy[i];
    return out;
  }
}
