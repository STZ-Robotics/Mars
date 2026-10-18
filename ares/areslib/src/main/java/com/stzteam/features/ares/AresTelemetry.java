package com.stzteam.features.ares;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.networktables.DoublePublisher;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StringArrayPublisher;
import edu.wpi.first.networktables.StringPublisher;
import edu.wpi.first.networktables.StructArrayPublisher;
import edu.wpi.first.networktables.StructPublisher;
import java.util.Set;

/**
 * What Ares is doing, on NetworkTables under {@code /Ares}: the path being
 * driven, where the trajectory is and where the robot is, so a dashboard (or
 * AdvantageScope) can draw the planned path against the real one.
 */
public final class AresTelemetry {
  private static final String TABLE = "Ares";
  private static StructArrayPublisher<Pose2d> path;
  private static StructPublisher<Pose2d> target;
  private static StructPublisher<Pose2d> robot;
  private static DoublePublisher error;
  private static StringPublisher active;
  private static DoublePublisher time;
  private static StringArrayPublisher events;
  private static edu.wpi.first.networktables.IntegerPublisher replans;
  private static edu.wpi.first.networktables.DoubleArrayPublisher commandedSpeeds;
  private static edu.wpi.first.networktables.DoubleArrayPublisher measuredSpeeds;
  private static StringPublisher selectedAuto;
  private static StructPublisher<Pose2d> autoStart;

  private AresTelemetry() {}

  private static synchronized void open() {
    if (path != null) return;
    var t = NetworkTableInstance.getDefault().getTable(TABLE);
    path = t.getStructArrayTopic("Path", Pose2d.struct).publish();
    target = t.getStructTopic("Target", Pose2d.struct).publish();
    robot = t.getStructTopic("Robot", Pose2d.struct).publish();
    error = t.getDoubleTopic("ErrorM").publish();
    active = t.getStringTopic("Active").publish();
    time = t.getDoubleTopic("TimeS").publish();
    events = t.getStringArrayTopic("Events").publish();
    replans = t.getIntegerTopic("Replans").publish();
    commandedSpeeds = t.getDoubleArrayTopic("CommandedSpeeds").publish();
    measuredSpeeds = t.getDoubleArrayTopic("MeasuredSpeeds").publish();
    selectedAuto = t.getSubTable("Auto").getStringTopic("Selected").publish();
    autoStart = t.getSubTable("Auto").getStructTopic("StartPose", Pose2d.struct).publish();
  }

  /** The auto picked in the chooser, and where to put the robot for it (none: it can start anywhere). */
  static void selectedAuto(String name, Pose2d start) {
    open();
    selectedAuto.set(name);
    if (start != null) autoStart.set(start);
  }

  static void path(String name, Pose2d[] poses) {
    open();
    active.set(name);
    path.set(poses);
  }

  static void target(Pose2d trajectory, Pose2d actual, double errorM) {
    open();
    target.set(trajectory);
    robot.set(actual);
    error.set(errorM);
  }

  static void time(double t, Set<String> activeEvents) {
    open();
    time.set(t);
    events.set(activeEvents.toArray(String[]::new));
  }

  static void replanned(int count, double offM) {
    open();
    replans.set(count);
    edu.wpi.first.wpilibj.DriverStation.reportWarning(
        String.format("Ares: %.2f m off the trajectory, finding the way back (%d)", offM, count), false);
  }

  /** Which gains the robot runs with, and from where: /Ares/Gains. */
  static void gains(String source, AresController.Gains t, AresController.Gains r) {
    var table = NetworkTableInstance.getDefault().getTable(TABLE).getSubTable("Gains");
    table.getEntry("Source").setString(source);
    table.getEntry("Translation").setDoubleArray(new double[] {t.kP(), t.kI(), t.kD()});
    table.getEntry("Rotation").setDoubleArray(new double[] {r.kP(), r.kI(), r.kD()});
  }

  /**
   * What the follower asks for and what the robot does, field frame
   * {vx, vy, omega}: /Ares/CommandedSpeeds and /Ares/MeasuredSpeeds, for
   * Ares's Live tab (PathPlanner's telemetry graphs).
   */
  static void speeds(edu.wpi.first.math.kinematics.ChassisSpeeds commanded, edu.wpi.first.math.kinematics.ChassisSpeeds measured) {
    open();
    commandedSpeeds.set(new double[] {commanded.vxMetersPerSecond, commanded.vyMetersPerSecond, commanded.omegaRadiansPerSecond});
    measuredSpeeds.set(new double[] {measured.vxMetersPerSecond, measured.vyMetersPerSecond, measured.omegaRadiansPerSecond});
  }

  /** Where the robot is, every loop, path or not. */
  static void robot(Pose2d pose) {
    open();
    robot.set(pose);
  }

  static void idle() {
    open();
    active.set("");
    path.set(new Pose2d[0]);
    events.set(new String[0]);
  }
}
