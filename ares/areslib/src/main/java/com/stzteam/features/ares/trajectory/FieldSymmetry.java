package com.stzteam.features.ares.trajectory;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;

/**
 * How a path drawn for the blue alliance becomes the red alliance's.
 *
 * <p>Ares draws every path with blue at x = 0. On the red alliance the robot
 * drives the path's image under the field's symmetry: {@link #ROTATIONAL} for
 * a field that is the same after a half turn about its center (2022, 2024's
 * stage aside, 2026), {@link #MIRRORED} for one that is the same in a mirror
 * across its center line (2023, 2025).
 */
public enum FieldSymmetry {
  /** Half a turn about the field's center: x and y both flip. */
  ROTATIONAL,
  /** A mirror across x = length / 2: only x flips, and left becomes right. */
  MIRRORED;

  public Translation2d flip(Translation2d p, double lengthM, double widthM) {
    return switch (this) {
      case ROTATIONAL -> new Translation2d(lengthM - p.getX(), widthM - p.getY());
      case MIRRORED -> new Translation2d(lengthM - p.getX(), p.getY());
    };
  }

  public Rotation2d flip(Rotation2d r) {
    return switch (this) {
      case ROTATIONAL -> r.rotateBy(Rotation2d.kPi);
      case MIRRORED -> Rotation2d.kPi.minus(r);
    };
  }

  public Pose2d flip(Pose2d pose, double lengthM, double widthM) {
    return new Pose2d(flip(pose.getTranslation(), lengthM, widthM), flip(pose.getRotation()));
  }

  /**
   * Which module a mirrored robot's module {@code i} lands on: in a mirror the
   * robot's left and right trade places, so module i does the work its
   * mirror-image partner (same x, opposite y) did. A half turn moves no module.
   *
   * @param moduleX each module's x in the robot frame, in the trajectory's order
   * @param moduleY and its y
   */
  public int[] modulePartners(double[] moduleX, double[] moduleY) {
    int n = moduleY.length;
    var out = new int[n];
    for (int i = 0; i < n; i++) {
      out[i] = i;
      if (this != MIRRORED) continue;
      double best = Double.POSITIVE_INFINITY;
      for (int j = 0; j < n; j++) {
        double d = Math.hypot(moduleX[j] - moduleX[i], moduleY[j] + moduleY[i]);
        if (d < best) {
          best = d;
          out[i] = j;
        }
      }
    }
    return out;
  }

  /** The sample as the other alliance drives it. */
  public AresSample flip(AresSample s, double lengthM, double widthM, int[] partners) {
    int m = s.modules();
    var speed = new double[m];
    var angle = new double[m];
    var fx = new double[m];
    var fy = new double[m];
    for (int i = 0; i < m; i++) {
      int j = partners[i];
      speed[i] = s.moduleSpeedMps()[j];
      switch (this) {
        case ROTATIONAL -> {
          // The robot turns with the field: robot-frame angles stay.
          angle[i] = s.moduleAngleRad()[j];
          fx[i] = -s.moduleForceXN()[j];
          fy[i] = -s.moduleForceYN()[j];
        }
        case MIRRORED -> {
          angle[i] = -s.moduleAngleRad()[j];
          fx[i] = -s.moduleForceXN()[j];
          fy[i] = s.moduleForceYN()[j];
        }
      }
    }
    return switch (this) {
      case ROTATIONAL -> new AresSample(
          s.t(), lengthM - s.x(), widthM - s.y(), s.heading() + Math.PI,
          -s.vx(), -s.vy(), s.omega(), -s.ax(), -s.ay(), s.alpha(), speed, angle, fx, fy);
      case MIRRORED -> new AresSample(
          s.t(), lengthM - s.x(), s.y(), Math.PI - s.heading(),
          -s.vx(), s.vy(), -s.omega(), -s.ax(), s.ay(), -s.alpha(), speed, angle, fx, fy);
    };
  }
}
