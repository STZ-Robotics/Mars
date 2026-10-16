package com.stzteam.features.ares;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj2.command.Command;
import java.util.List;

/**
 * The pathfinder when the project has no navgrid: a straight line to the
 * goal, profiled, with the trajectories' feedback. It avoids nothing; with a
 * navgrid, {@link GridPathfinder} is the default instead.
 */
public final class StraightPathfinder implements AresPathfinder {
  private final AresDrive drive;
  private final AresController.Gains translation;
  private final AresController.Gains rotation;
  private final double toleranceM;
  private final double toleranceRad;

  public StraightPathfinder(
      AresDrive drive, AresController.Gains translation, AresController.Gains rotation,
      double toleranceM, double toleranceRad) {
    this.drive = drive;
    this.translation = translation;
    this.rotation = rotation;
    this.toleranceM = toleranceM;
    this.toleranceRad = toleranceRad;
  }

  @Override
  public Command toPose(Pose2d goal, ChassisSpeeds endFieldSpeeds, Constraints c) {
    return new DriveAlong(
        drive, goal, endFieldSpeeds, c, start -> List.of(start, goal.getTranslation()),
        translation, rotation, toleranceM, toleranceRad);
  }
}
