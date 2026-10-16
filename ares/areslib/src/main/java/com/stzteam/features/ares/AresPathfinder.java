package com.stzteam.features.ares;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj2.command.Command;

/**
 * How the robot gets to a pose by itself, for the stretches of a path Ares
 * marked "?" (the robot finds its own way) and for paths that start wherever
 * the robot happens to be.
 *
 * <p>When the robot is where Ares expected at the start of such a stretch, it
 * just follows Ares's estimate, which is a real trajectory. This is only for
 * when it is not. The default, {@link StraightPathfinder}, drives a straight
 * line with a trapezoid profile and knows nothing of obstacles; to route around
 * them, plug in another one, for instance PathPlanner's:
 *
 * <pre>{@code
 * config.withPathfinder((goal, endSpeeds, c) ->
 *     AutoBuilder.pathfindToPose(goal, new PathConstraints(
 *         c.maxVelocityMps(), c.maxAccelerationMps2(),
 *         c.maxAngularVelocityRadps(), c.maxAngularAccelerationRadps2()),
 *         Math.hypot(endSpeeds.vxMetersPerSecond, endSpeeds.vyMetersPerSecond)));
 * }</pre>
 */
@FunctionalInterface
public interface AresPathfinder {
  record Constraints(
      double maxVelocityMps,
      double maxAccelerationMps2,
      double maxAngularVelocityRadps,
      double maxAngularAccelerationRadps2) {}

  /**
   * A command that drives the robot to {@code goal} (field frame, already on
   * the right alliance), arriving with {@code endFieldSpeeds}: zero to stop
   * there, or the speed the rest of the path picks up from.
   *
   * <p>It is run from inside the path command, which already requires the
   * drivetrain; it must finish by itself.
   */
  Command toPose(Pose2d goal, ChassisSpeeds endFieldSpeeds, Constraints constraints);
}
