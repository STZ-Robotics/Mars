package com.stzteam.features.ares.characterize;

import edu.wpi.first.networktables.NetworkTable;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.wpilibj.Preferences;
import java.util.List;

/**
 * The routines as they go, under {@code /Ares/Characterize/<routine>}: State,
 * Progress (0–1), the measured points (Volts and Speed, or the radius
 * routine's samples) and the results (kS, kV, R2, WheelRadiusM…). Ares's
 * Characterize tab reads them live; the results are also kept in
 * Preferences ({@code Ares/<routine>/<result>}).
 */
public final class CharacterizationTelemetry {
  private CharacterizationTelemetry() {}

  private static NetworkTableInstance instance = NetworkTableInstance.getDefault();

  /** Where to publish (the default instance unless told otherwise, as SmartDashboard). */
  public static void setInstance(NetworkTableInstance nt) {
    instance = nt;
  }

  static NetworkTable table(String name) {
    return instance.getTable("Ares").getSubTable("Characterize").getSubTable(name);
  }

  static void start(String name, String state, int steps) {
    var t = table(name);
    t.getEntry("State").setString(state);
    t.getEntry("Progress").setDouble(0);
    t.getEntry("Volts").setDoubleArray(new double[0]);
    t.getEntry("Speed").setDoubleArray(new double[0]);
    t.getEntry("Steps").setDouble(steps);
    for (var k : List.of("kS", "kV", "R2", "WheelRadiusM")) t.getEntry(k).unpublish();
  }

  static void points(String name, List<VoltageSweep.Point> points, int done, int of) {
    var t = table(name);
    t.getEntry("Volts").setDoubleArray(points.stream().mapToDouble(VoltageSweep.Point::volts).toArray());
    t.getEntry("Speed").setDoubleArray(points.stream().mapToDouble(VoltageSweep.Point::speed).toArray());
    t.getEntry("Progress").setDouble((double) done / of);
  }

  static void progress(String name, double fraction) {
    table(name).getEntry("Progress").setDouble(fraction);
  }

  static void state(String name, String state) {
    table(name).getEntry("State").setString(state);
  }

  static void result(String name, String key, double value) {
    table(name).getEntry(key).setDouble(value);
    Preferences.setDouble("Ares/" + name + "/" + key, value);
  }
}
