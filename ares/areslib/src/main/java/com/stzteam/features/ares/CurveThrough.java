package com.stzteam.features.ares;

import com.stzteam.features.ares.trajectory.AresSample;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.math.trajectory.Trajectory;
import edu.wpi.first.math.trajectory.TrajectoryConfig;
import edu.wpi.first.math.trajectory.TrajectoryGenerator;
import edu.wpi.first.math.trajectory.TrapezoidProfile;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.Command;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

/**
 * A path made on the robot, when it starts (PathPlanner's paths from poses):
 * a smooth curve through the waypoints (WPILib's splines), its speed planned
 * within the limits, the heading turned to the end heading with a profile of
 * its own, and the trajectory follower's feedback on top. Unlike Ares's
 * paths it knows no wheel forces and no obstacles: for short moves decided
 * in the moment.
 */
final class CurveThrough extends Command {
  private final AresDrive drive;
  private final Supplier<List<Pose2d>> waypoints;
  private final Supplier<Rotation2d> endHeading;
  private final AresPathfinder.Constraints limits;
  private final double toleranceM;
  private final double toleranceRad;
  private final AresController controller;
  private final TrapezoidProfile turn;
  private final Timer timer = new Timer();
  private Trajectory curve;
  private double heading0;
  private double turnBy;
  private TrapezoidProfile.State turnStart;
  private double turnTime;
  private Pose2d goal;

  /**
   * {@code waypoints}: where it passes, field frame, each pose's rotation the
   * direction of travel there; the first is where it starts.
   */
  CurveThrough(
      AresDrive drive, Supplier<List<Pose2d>> waypoints, Supplier<Rotation2d> endHeading, AresPathfinder.Constraints limits,
      AresController.Gains translation, AresController.Gains rotation, double toleranceM, double toleranceRad) {
    this.drive = drive;
    this.waypoints = waypoints;
    this.endHeading = endHeading;
    this.limits = limits;
    this.toleranceM = toleranceM;
    this.toleranceRad = toleranceRad;
    this.controller = new AresController(translation, rotation, 0.02);
    this.turn = new TrapezoidProfile(new TrapezoidProfile.Constraints(limits.maxAngularVelocityRadps(), limits.maxAngularAccelerationRadps2()));
    addRequirements(drive.subsystem());
  }

  @Override
  public void initialize() {
    var pose = drive.pose();
    var points = waypoints.get();
    var speeds = ChassisSpeeds.fromRobotRelativeSpeeds(drive.robotSpeeds(), pose.getRotation());
    var first = points.get(0).getRotation();
    // Already moving along the way it sets off: start at that speed.
    double along = Math.max(0, speeds.vxMetersPerSecond * first.getCos() + speeds.vyMetersPerSecond * first.getSin());
    var config = new TrajectoryConfig(limits.maxVelocityMps(), limits.maxAccelerationMps2())
        .setStartVelocity(Math.min(along, limits.maxVelocityMps()))
        .setEndVelocity(0);
    curve = TrajectoryGenerator.generateTrajectory(points, config);
    var end = curve.getStates().get(curve.getStates().size() - 1).poseMeters;
    goal = new Pose2d(end.getTranslation(), endHeading.get());
    heading0 = pose.getRotation().getRadians();
    turnBy = Math.IEEEremainder(goal.getRotation().getRadians() - heading0, 2 * Math.PI);
    turnStart = new TrapezoidProfile.State(0, speeds.omegaRadiansPerSecond);
    turn.calculate(0, turnStart, new TrapezoidProfile.State(turnBy, 0));
    turnTime = turn.totalTime();
    controller.reset();
    timer.restart();
    AresTelemetry.path("on the fly", curve.getStates().stream().map(s -> s.poseMeters).toArray(Pose2d[]::new));
  }

  @Override
  public void execute() {
    double t = timer.get();
    var s = curve.sample(Math.min(t, curve.getTotalTimeSeconds()));
    var r = t >= turnTime ? new TrapezoidProfile.State(turnBy, 0) : turn.calculate(t, turnStart, new TrapezoidProfile.State(turnBy, 0));
    var travel = s.poseMeters.getRotation();
    var target = new AresSample(
        t, s.poseMeters.getX(), s.poseMeters.getY(), heading0 + r.position,
        s.velocityMetersPerSecond * travel.getCos(), s.velocityMetersPerSecond * travel.getSin(), r.velocity,
        0, 0, 0, new double[0], new double[0], new double[0], new double[0]);
    var pose = drive.pose();
    var speeds = controller.calculate(pose, target);
    drive.drive(AresSetpoint.speeds(target.pose(), speeds, pose.getRotation(), 0));
    AresTelemetry.speeds(speeds, ChassisSpeeds.fromRobotRelativeSpeeds(drive.robotSpeeds(), pose.getRotation()));
    AresTelemetry.target(target.pose(), pose, controller.errorM());
  }

  @Override
  public boolean isFinished() {
    double t = timer.get();
    double done = Math.max(curve.getTotalTimeSeconds(), turnTime);
    if (t < done) return false;
    var pose = drive.pose();
    boolean there = pose.getTranslation().getDistance(goal.getTranslation()) < toleranceM
        && Math.abs(pose.getRotation().minus(goal.getRotation()).getRadians()) < toleranceRad;
    // Not forever: half a second past the plan, take what there is.
    return there || t > done + 0.5;
  }

  /** From where the robot is, setting off toward the first waypoint, then through the rest. */
  static List<Pose2d> fromHere(Pose2d robot, List<Pose2d> through) {
    var out = new ArrayList<Pose2d>();
    var first = through.get(0).getTranslation().minus(robot.getTranslation());
    out.add(new Pose2d(robot.getTranslation(), first.getNorm() < 1e-6 ? through.get(0).getRotation() : first.getAngle()));
    out.addAll(through);
    return out;
  }
}
