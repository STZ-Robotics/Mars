package com.stzteam.features.ares;

import com.stzteam.features.ares.trajectory.AresSample;
import edu.wpi.first.math.controller.PIDController;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;

/**
 * The feedback that keeps the robot on the trajectory: the trajectory's own
 * speeds, plus a PID on each of x, y and heading pulling toward where the
 * trajectory is now. The same law PathPlanner's holonomic controller uses; the
 * difference is what goes with it, the wheel forces, so these gains only have
 * to correct what the forces did not already get right, and can stay low.
 */
public final class AresController {
  /** PID gains; iZone bounds the integrator. */
  public record Gains(double kP, double kI, double kD, double iZone) {
    public Gains(double kP, double kI, double kD) {
      this(kP, kI, kD, 1.0);
    }
  }

  private final PIDController x;
  private final PIDController y;
  private final PIDController heading;
  private double errorM;
  private double headingErrorRad;

  public AresController(Gains translation, Gains rotation, double periodS) {
    x = pid(translation, periodS);
    y = pid(translation, periodS);
    heading = pid(rotation, periodS);
    heading.enableContinuousInput(-Math.PI, Math.PI);
  }

  private static PIDController pid(Gains g, double periodS) {
    var c = new PIDController(g.kP(), g.kI(), g.kD(), periodS);
    c.setIntegratorRange(-g.iZone(), g.iZone());
    return c;
  }

  public void reset() {
    x.reset();
    y.reset();
    heading.reset();
  }

  /** The field-frame speeds that follow {@code target} from {@code current}. */
  public ChassisSpeeds calculate(Pose2d current, AresSample target) {
    errorM = Math.hypot(target.x() - current.getX(), target.y() - current.getY());
    headingErrorRad = Math.IEEEremainder(target.heading() - current.getRotation().getRadians(), 2 * Math.PI);
    return new ChassisSpeeds(
        target.vx() + x.calculate(current.getX(), target.x()),
        target.vy() + y.calculate(current.getY(), target.y()),
        target.omega() + heading.calculate(current.getRotation().getRadians(), target.heading()));
  }

  /** How far the robot was from the trajectory at the last {@link #calculate}. */
  public double errorM() {
    return errorM;
  }

  public double headingErrorRad() {
    return headingErrorRad;
  }
}
