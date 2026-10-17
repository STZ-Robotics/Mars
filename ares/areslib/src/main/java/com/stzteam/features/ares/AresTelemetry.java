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

  static void idle() {
    open();
    active.set("");
    path.set(new Pose2d[0]);
    events.set(new String[0]);
  }
}
