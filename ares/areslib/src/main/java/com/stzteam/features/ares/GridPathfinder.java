package com.stzteam.features.ares;

import com.stzteam.features.ares.trajectory.FieldSymmetry;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj2.command.Command;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * The pathfinder when the project has a navgrid ({@code navgrid.json}, drawn
 * in the Field tab): A* around its blocked cells from wherever the robot is,
 * then the corners driven with a profile. The route is searched when the
 * command starts, from the robot's actual position.
 *
 * <p>The grid is drawn for blue. On red the search runs in blue's frame (the
 * robot and the goal flipped into it) and the corners are flipped back.
 */
public final class GridPathfinder implements AresPathfinder {
  private final AresDrive drive;
  private final NavGrid grid;
  private final AresController.Gains translation;
  private final AresController.Gains rotation;
  private final double toleranceM;
  private final double toleranceRad;
  private final BooleanSupplier flip;
  private final FieldSymmetry symmetry;
  private final double lengthM;
  private final double widthM;

  public GridPathfinder(
      AresDrive drive, NavGrid grid, AresController.Gains translation, AresController.Gains rotation,
      double toleranceM, double toleranceRad, BooleanSupplier flip, FieldSymmetry symmetry,
      double lengthM, double widthM) {
    this.drive = drive;
    this.grid = grid;
    this.translation = translation;
    this.rotation = rotation;
    this.toleranceM = toleranceM;
    this.toleranceRad = toleranceRad;
    this.flip = flip;
    this.symmetry = symmetry;
    this.lengthM = lengthM;
    this.widthM = widthM;
  }

  public NavGrid grid() {
    return grid;
  }

  @Override
  public Command toPose(Pose2d goal, ChassisSpeeds endFieldSpeeds, Constraints c) {
    return new DriveAlong(drive, goal, endFieldSpeeds, c, start -> route(start, goal.getTranslation()),
        translation, rotation, toleranceM, toleranceRad);
  }

  /** The corners from {@code start} to {@code goal} (field frame, this alliance), both included. */
  public List<Translation2d> route(Translation2d start, Translation2d goal) {
    boolean red = flip.getAsBoolean();
    // Both symmetries undo themselves, so the same flip goes in and out.
    var a = red ? symmetry.flip(start, lengthM, widthM) : start;
    var b = red ? symmetry.flip(goal, lengthM, widthM) : goal;
    var blue = grid.route(a, b);
    if (blue == null) {
      DriverStation.reportWarning("Ares: the navgrid walls the goal off; driving straight to it", false);
      return List.of(start, goal);
    }
    return red ? blue.stream().map(p -> symmetry.flip(p, lengthM, widthM)).toList() : blue;
  }
}
