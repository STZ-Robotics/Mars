package com.stzteam.features.ares.trajectory;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.math.kinematics.SwerveModuleState;

/**
 * One instant of an Ares trajectory, in the field frame (blue origin, unless it
 * has been flipped).
 *
 * <p>The module arrays follow the order of the modules in the robot's {@code
 * .robot.json}, which is the order the drivetrain was configured with.
 */
public record AresSample(
    double t,
    double x,
    double y,
    double heading,
    double vx,
    double vy,
    double omega,
    double ax,
    double ay,
    double alpha,
    /* Per module. */
    double[] moduleSpeedMps,
    /* Robot frame. */
    double[] moduleAngleRad,
    /* The force each wheel puts on the carpet, field frame, newtons. */
    double[] moduleForceXN,
    double[] moduleForceYN) {

  public Pose2d pose() {
    return new Pose2d(x, y, new Rotation2d(heading));
  }

  public ChassisSpeeds fieldSpeeds() {
    return new ChassisSpeeds(vx, vy, omega);
  }

  public ChassisSpeeds robotSpeeds() {
    return ChassisSpeeds.fromFieldRelativeSpeeds(vx, vy, omega, new Rotation2d(heading));
  }

  public int modules() {
    return moduleForceXN.length;
  }

  /** The wheels as the drivetrain would be told: speed and robot-frame angle. */
  public SwerveModuleState[] moduleStates() {
    var out = new SwerveModuleState[modules()];
    for (int i = 0; i < out.length; i++) {
      out[i] = new SwerveModuleState(moduleSpeedMps[i], new Rotation2d(moduleAngleRad[i]));
    }
    return out;
  }

  /** The wheel forces turned into the robot frame: x of each module. */
  public double[] moduleForceXRobotN() {
    double c = Math.cos(heading), s = Math.sin(heading);
    var out = new double[modules()];
    for (int i = 0; i < out.length; i++) out[i] = c * moduleForceXN[i] + s * moduleForceYN[i];
    return out;
  }

  /** The wheel forces turned into the robot frame: y of each module. */
  public double[] moduleForceYRobotN() {
    double c = Math.cos(heading), s = Math.sin(heading);
    var out = new double[modules()];
    for (int i = 0; i < out.length; i++) out[i] = -s * moduleForceXN[i] + c * moduleForceYN[i];
    return out;
  }

  /**
   * The state {@code tau} seconds after this one, integrating this sample's
   * acceleration (between two samples the solver holds it constant, so this is
   * exact for the pose and the speeds; the forces are blended toward {@code next}).
   */
  public AresSample advance(double tau, AresSample next) {
    double span = next.t - t;
    double f = span > 1e-9 ? Math.min(Math.max(tau / span, 0), 1) : 0;
    int m = modules();
    var speed = new double[m];
    var angle = new double[m];
    var fx = new double[m];
    var fy = new double[m];
    for (int i = 0; i < m; i++) {
      speed[i] = lerp(moduleSpeedMps[i], next.moduleSpeedMps[i], f);
      angle[i] = lerpAngle(moduleAngleRad[i], next.moduleAngleRad[i], f);
      fx[i] = lerp(moduleForceXN[i], next.moduleForceXN[i], f);
      fy[i] = lerp(moduleForceYN[i], next.moduleForceYN[i], f);
    }
    double tau2 = tau * tau;
    return new AresSample(
        t + tau,
        x + vx * tau + 0.5 * ax * tau2,
        y + vy * tau + 0.5 * ay * tau2,
        heading + omega * tau + 0.5 * alpha * tau2,
        vx + ax * tau,
        vy + ay * tau,
        omega + alpha * tau,
        ax,
        ay,
        alpha,
        speed,
        angle,
        fx,
        fy);
  }

  /** The same state, {@code dt} seconds later on the clock. */
  public AresSample shifted(double dt) {
    return new AresSample(
        t + dt, x, y, heading, vx, vy, omega, ax, ay, alpha, moduleSpeedMps, moduleAngleRad,
        moduleForceXN, moduleForceYN);
  }

  private static double lerp(double a, double b, double f) {
    return a + (b - a) * f;
  }

  private static double lerpAngle(double a, double b, double f) {
    return a + Math.IEEEremainder(b - a, 2 * Math.PI) * f;
  }
}
