package com.stzteam.features.ares;

import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.trajectory.TrapezoidProfile;
import java.util.ArrayList;
import java.util.List;

/**
 * A drive along a polyline (a pathfinder's corners), timed: a trapezoid
 * profile on each leg, with the speed through each corner capped by how sharp
 * it is (straight on: full speed; a right angle or worse: a stop), and the
 * legs' ends matched so the speed never jumps. Forward and backward passes
 * keep every leg within the acceleration limit.
 */
public final class ProfiledPolyline {
  /** Where to be at a time, and how fast to be going there (field frame). */
  public record State(Translation2d position, Translation2d velocity) {}

  private final List<Translation2d> points;
  private final List<TrapezoidProfile> legs = new ArrayList<>();
  private final double[] length;
  private final double[] speed; // at each point
  private final double[] startT; // when each leg starts
  private final double total;

  /**
   * @param points at least two: where the robot is, the corners, the goal
   * @param startSpeed how fast it is already going along the first leg (m/s, 0 or more)
   * @param endSpeed how fast it should arrive (0 to stop)
   */
  public ProfiledPolyline(List<Translation2d> points, double startSpeed, double endSpeed, double maxSpeed, double maxAccel) {
    if (points.size() < 2) throw new IllegalArgumentException("A polyline needs two points");
    this.points = List.copyOf(points);
    int n = points.size();
    length = new double[n - 1];
    for (int i = 0; i < n - 1; i++) length[i] = points.get(i + 1).getDistance(points.get(i));
    speed = new double[n];
    speed[0] = Math.min(Math.max(startSpeed, 0), maxSpeed);
    speed[n - 1] = Math.min(Math.max(endSpeed, 0), maxSpeed);
    for (int i = 1; i < n - 1; i++) {
      var in = points.get(i).minus(points.get(i - 1));
      var out = points.get(i + 1).minus(points.get(i));
      double cos = in.getNorm() < 1e-9 || out.getNorm() < 1e-9
          ? 1 : (in.getX() * out.getX() + in.getY() * out.getY()) / (in.getNorm() * out.getNorm());
      double f = Math.max(0, cos);
      speed[i] = maxSpeed * f * f;
    }
    // What the acceleration allows, both ways.
    for (int i = 0; i < n - 1; i++) speed[i + 1] = Math.min(speed[i + 1], Math.sqrt(speed[i] * speed[i] + 2 * maxAccel * length[i]));
    for (int i = n - 2; i >= 0; i--) speed[i] = Math.min(speed[i], Math.sqrt(speed[i + 1] * speed[i + 1] + 2 * maxAccel * length[i]));
    startT = new double[n - 1];
    double t = 0;
    for (int i = 0; i < n - 1; i++) {
      var p = new TrapezoidProfile(new TrapezoidProfile.Constraints(maxSpeed, maxAccel));
      p.calculate(0, new TrapezoidProfile.State(0, speed[i]), new TrapezoidProfile.State(length[i], speed[i + 1]));
      startT[i] = t;
      t += p.totalTime();
      legs.add(p);
    }
    total = t;
  }

  public double totalTime() {
    return total;
  }

  public List<Translation2d> points() {
    return points;
  }

  public State sample(double t) {
    int n = points.size();
    if (t >= total) {
      var dir = direction(n - 2);
      return new State(points.get(n - 1), dir.times(speed[n - 1]));
    }
    int i = 0;
    while (i + 1 < legs.size() && t >= startT[i + 1]) i++;
    var s = legs.get(i).calculate(
        Math.max(0, t - startT[i]),
        new TrapezoidProfile.State(0, speed[i]),
        new TrapezoidProfile.State(length[i], speed[i + 1]));
    var dir = direction(i);
    double along = Math.min(Math.max(s.position, 0), length[i]);
    return new State(points.get(i).plus(dir.times(along)), dir.times(s.velocity));
  }

  private Translation2d direction(int leg) {
    var d = points.get(leg + 1).minus(points.get(leg));
    return d.getNorm() < 1e-9 ? new Translation2d() : d.div(d.getNorm());
  }
}
