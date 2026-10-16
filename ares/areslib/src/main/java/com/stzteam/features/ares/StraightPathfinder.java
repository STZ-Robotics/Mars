package com.stzteam.features.ares;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.math.trajectory.TrapezoidProfile;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.Command;

/**
 * The default {@link AresPathfinder}: a straight line to the goal with a
 * trapezoid profile on the distance and another on the heading, plus the same
 * feedback the trajectories use. It does not avoid anything; it is meant for
 * the short corrections between where the robot is and where the path expected
 * it.
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
    return new Drive(goal, endFieldSpeeds, c);
  }

  private final class Drive extends Command {
    private final Pose2d goal;
    private final double endSpeed;
    private final TrapezoidProfile line;
    private final TrapezoidProfile turn;
    private final AresController controller = new AresController(translation, rotation, 0.02);
    private final Timer timer = new Timer();
    private Translation2d from;
    private Translation2d dir;
    private double distance;
    private double heading0;
    private double turnBy;
    private TrapezoidProfile.State lineStart;
    private TrapezoidProfile.State turnStart;
    private double lineTime;
    private double turnTime;

    Drive(Pose2d goal, ChassisSpeeds endFieldSpeeds, Constraints c) {
      this.goal = goal;
      this.endSpeed = Math.hypot(endFieldSpeeds.vxMetersPerSecond, endFieldSpeeds.vyMetersPerSecond);
      line = new TrapezoidProfile(new TrapezoidProfile.Constraints(c.maxVelocityMps(), c.maxAccelerationMps2()));
      turn = new TrapezoidProfile(new TrapezoidProfile.Constraints(c.maxAngularVelocityRadps(), c.maxAngularAccelerationRadps2()));
      addRequirements(drive.subsystem());
    }

    @Override
    public void initialize() {
      var pose = drive.pose();
      from = pose.getTranslation();
      var delta = goal.getTranslation().minus(from);
      distance = delta.getNorm();
      dir = distance > 1e-6 ? delta.div(distance) : new Translation2d(1, 0);
      var speeds = ChassisSpeeds.fromRobotRelativeSpeeds(drive.robotSpeeds(), pose.getRotation());
      double along = speeds.vxMetersPerSecond * dir.getX() + speeds.vyMetersPerSecond * dir.getY();
      heading0 = pose.getRotation().getRadians();
      turnBy = Math.IEEEremainder(goal.getRotation().getRadians() - heading0, 2 * Math.PI);
      lineStart = new TrapezoidProfile.State(0, Math.max(0, along));
      turnStart = new TrapezoidProfile.State(0, speeds.omegaRadiansPerSecond);
      line.calculate(0, lineStart, new TrapezoidProfile.State(distance, endSpeed));
      lineTime = line.totalTime();
      turn.calculate(0, turnStart, new TrapezoidProfile.State(turnBy, 0));
      turnTime = turn.totalTime();
      controller.reset();
      timer.restart();
    }

    @Override
    public void execute() {
      double t = timer.get();
      var l = line.calculate(t, lineStart, new TrapezoidProfile.State(distance, endSpeed));
      var r = turn.calculate(t, turnStart, new TrapezoidProfile.State(turnBy, 0));
      if (t >= lineTime) l = new TrapezoidProfile.State(distance, endSpeed);
      if (t >= turnTime) r = new TrapezoidProfile.State(turnBy, 0);
      var p = from.plus(dir.times(l.position));
      double h = heading0 + r.position;
      var target = new com.stzteam.features.ares.trajectory.AresSample(
          t, p.getX(), p.getY(), h, dir.getX() * l.velocity, dir.getY() * l.velocity, r.velocity,
          0, 0, 0, new double[0], new double[0], new double[0], new double[0]);
      var pose = drive.pose();
      var speeds = controller.calculate(pose, target);
      drive.drive(AresSetpoint.speeds(new Pose2d(p, new Rotation2d(h)), speeds, pose.getRotation(), 0));
      AresTelemetry.target(target.pose(), pose, controller.errorM());
    }

    @Override
    public boolean isFinished() {
      double t = timer.get();
      if (t < Math.max(lineTime, turnTime)) return false;
      // Passing through at speed: the path takes over where the profile ends.
      if (endSpeed > 0.05) return true;
      var pose = drive.pose();
      boolean there = pose.getTranslation().getDistance(goal.getTranslation()) < toleranceM
          && Math.abs(pose.getRotation().minus(goal.getRotation()).getRadians()) < toleranceRad;
      // Not forever: half a second past the profile, take what there is.
      return there || t > Math.max(lineTime, turnTime) + 0.5;
    }
  }
}
