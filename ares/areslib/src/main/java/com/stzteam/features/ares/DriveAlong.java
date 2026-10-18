package com.stzteam.features.ares;

import com.stzteam.features.ares.trajectory.AresSample;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.math.trajectory.TrapezoidProfile;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.Command;
import java.util.List;
import java.util.function.Function;

/**
 * Drives from wherever the robot is to a goal pose along a polyline found when
 * it starts (straight, or around the navgrid), with a profile on the distance
 * and another on the heading, and the trajectory follower's feedback on top.
 */
final class DriveAlong extends Command {
  private final AresDrive drive;
  private final Pose2d goal;
  private final double endSpeed;
  private final AresPathfinder.Constraints limits;
  private final Function<Translation2d, List<Translation2d>> route;
  private final double toleranceM;
  private final double toleranceRad;
  private final AresController controller;
  private final TrapezoidProfile turn;
  private final Timer timer = new Timer();
  private ProfiledPolyline line;
  private double heading0;
  private double turnBy;
  private TrapezoidProfile.State turnStart;
  private double turnTime;
  private final GridPathfinder replan;
  private long seen;
  private int replans;

  DriveAlong(
      AresDrive drive, Pose2d goal, ChassisSpeeds endFieldSpeeds, AresPathfinder.Constraints limits,
      Function<Translation2d, List<Translation2d>> route, AresController.Gains translation,
      AresController.Gains rotation, double toleranceM, double toleranceRad) {
    this(drive, goal, endFieldSpeeds, limits, route, translation, rotation, toleranceM, toleranceRad, null);
  }

  /** With {@code replan}: when its obstacles change across the way ahead, the route is searched again from where the robot is. */
  DriveAlong(
      AresDrive drive, Pose2d goal, ChassisSpeeds endFieldSpeeds, AresPathfinder.Constraints limits,
      Function<Translation2d, List<Translation2d>> route, AresController.Gains translation,
      AresController.Gains rotation, double toleranceM, double toleranceRad, GridPathfinder replan) {
    this.replan = replan;
    this.drive = drive;
    this.goal = goal;
    this.endSpeed = Math.hypot(endFieldSpeeds.vxMetersPerSecond, endFieldSpeeds.vyMetersPerSecond);
    this.limits = limits;
    this.route = route;
    this.toleranceM = toleranceM;
    this.toleranceRad = toleranceRad;
    this.controller = new AresController(translation, rotation, 0.02);
    this.turn = new TrapezoidProfile(new TrapezoidProfile.Constraints(limits.maxAngularVelocityRadps(), limits.maxAngularAccelerationRadps2()));
    addRequirements(drive.subsystem());
  }

  @Override
  public void initialize() {
    var pose = drive.pose();
    var points = route.apply(pose.getTranslation());
    var first = points.get(1).minus(points.get(0));
    var speeds = ChassisSpeeds.fromRobotRelativeSpeeds(drive.robotSpeeds(), pose.getRotation());
    double along = first.getNorm() < 1e-9 ? 0
        : (speeds.vxMetersPerSecond * first.getX() + speeds.vyMetersPerSecond * first.getY()) / first.getNorm();
    line = new ProfiledPolyline(points, along, endSpeed, limits.maxVelocityMps(), limits.maxAccelerationMps2());
    heading0 = pose.getRotation().getRadians();
    turnBy = Math.IEEEremainder(goal.getRotation().getRadians() - heading0, 2 * Math.PI);
    turnStart = new TrapezoidProfile.State(0, speeds.omegaRadiansPerSecond);
    turn.calculate(0, turnStart, new TrapezoidProfile.State(turnBy, 0));
    turnTime = turn.totalTime();
    controller.reset();
    timer.restart();
    if (replan != null) seen = replan.grid().obstaclesVersion();
    AresTelemetry.path("pathfinding", points.stream().map(p -> new Pose2d(p, new Rotation2d())).toArray(Pose2d[]::new));
  }

  @Override
  public void execute() {
    if (replan != null && replan.grid().obstaclesVersion() != seen) {
      seen = replan.grid().obstaclesVersion();
      // Something moved into the way ahead: a new way from here.
      if (!replan.clear(line.remaining(timer.get()))) {
        AresTelemetry.replanned(++replans, 0);
        initialize();
      }
    }
    double t = timer.get();
    var s = line.sample(t);
    var r = t >= turnTime ? new TrapezoidProfile.State(turnBy, 0) : turn.calculate(t, turnStart, new TrapezoidProfile.State(turnBy, 0));
    double h = heading0 + r.position;
    var target = new AresSample(
        t, s.position().getX(), s.position().getY(), h, s.velocity().getX(), s.velocity().getY(), r.velocity,
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
    double done = Math.max(line.totalTime(), turnTime);
    if (t < done) return false;
    // Passing through at speed: the path takes over where the profile ends.
    if (endSpeed > 0.05) return true;
    var pose = drive.pose();
    boolean there = pose.getTranslation().getDistance(goal.getTranslation()) < toleranceM
        && Math.abs(pose.getRotation().minus(goal.getRotation()).getRadians()) < toleranceRad;
    // Not forever: half a second past the profile, take what there is.
    return there || t > done + 0.5;
  }

  /** The polyline it is driving, once it has started. */
  List<Translation2d> points() {
    return line == null ? List.of() : line.points();
  }
}
