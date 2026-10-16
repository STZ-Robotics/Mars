package com.stzteam.features.ares.trajectory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import edu.wpi.first.math.geometry.Pose2d;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

/**
 * A trajectory as Ares wrote it ({@code trajectories/<name>.traj.json}): the
 * samples the planner solved, plus what happens along them.
 *
 * <p>Immutable: {@link #flipped} and {@link #slice} make new ones.
 */
public final class AresTrajectory {
  /** Where the path begins: a pose Ares knows, anywhere, or where the last path ended. */
  public enum Start {
    KNOWN,
    UNKNOWN,
    PREVIOUS
  }

  /** An event marker resolved to a time; {@code endT} is NaN for one that happens once. */
  public record Event(String name, double t, double endT) {
    public boolean isZone() {
      return !Double.isNaN(endT);
    }
  }

  /** A named stretch of the path. */
  public record Section(String name, int startSample, int endSample, double startT, double endT) {}

  /**
   * A stretch Ares could only estimate because the robot finds its own way
   * there: the samples in it are a guess, the goal is not.
   */
  public record PathfindSpan(
      int startSample,
      int endSample,
      double goalX,
      double goalY,
      double goalHeading,
      double maxVelocityMps,
      double maxAngularVelocityRadps,
      double estimatedS,
      boolean fromUnknown) {
    public Pose2d goal() {
      return new Pose2d(goalX, goalY, new edu.wpi.first.math.geometry.Rotation2d(goalHeading));
    }
  }

  private static final ObjectMapper JSON = new ObjectMapper();

  private final String name;
  private final List<AresSample> samples;
  private final List<Double> waypointTimes;
  private final List<Integer> splits;
  private final List<Event> events;
  private final List<Section> sections;
  private final List<PathfindSpan> pathfind;
  private final Start start;
  private final String continuesFrom;

  public AresTrajectory(
      String name,
      List<AresSample> samples,
      List<Double> waypointTimes,
      List<Integer> splits,
      List<Event> events,
      List<Section> sections,
      List<PathfindSpan> pathfind,
      Start start,
      String continuesFrom) {
    if (samples.isEmpty()) throw new IllegalArgumentException("A trajectory needs samples: " + name);
    this.name = name;
    this.samples = List.copyOf(samples);
    this.waypointTimes = List.copyOf(waypointTimes);
    this.splits = List.copyOf(splits);
    this.events = List.copyOf(events);
    this.sections = List.copyOf(sections);
    this.pathfind = List.copyOf(pathfind);
    this.start = start;
    this.continuesFrom = continuesFrom;
  }

  public static AresTrajectory load(File file) throws IOException {
    return parse(JSON.readTree(file));
  }

  public static AresTrajectory parse(String json) throws IOException {
    return parse(JSON.readTree(json));
  }

  public static AresTrajectory parse(JsonNode n) {
    var samples = new ArrayList<AresSample>();
    for (var s : n.path("samples")) {
      var modules = s.path("modules");
      int m = modules.size();
      var speed = new double[m];
      var angle = new double[m];
      var fx = new double[m];
      var fy = new double[m];
      for (int i = 0; i < m; i++) {
        var mod = modules.get(i);
        speed[i] = mod.path("speedMps").asDouble();
        angle[i] = mod.path("angleRad").asDouble();
        // Trajectories from before the forces were written have none: the
        // follower then runs on speeds and feedback alone.
        fx[i] = mod.path("fxN").asDouble(0);
        fy[i] = mod.path("fyN").asDouble(0);
      }
      samples.add(new AresSample(
          s.path("t").asDouble(), s.path("x").asDouble(), s.path("y").asDouble(),
          s.path("heading").asDouble(), s.path("vx").asDouble(), s.path("vy").asDouble(),
          s.path("omega").asDouble(), s.path("ax").asDouble(), s.path("ay").asDouble(),
          s.path("alpha").asDouble(), speed, angle, fx, fy));
    }
    var times = new ArrayList<Double>();
    for (var t : n.path("waypointTimes")) times.add(t.asDouble());
    var splits = new ArrayList<Integer>();
    for (var s : n.path("splits")) splits.add(s.asInt());
    var events = new ArrayList<Event>();
    for (var e : n.path("events")) {
      events.add(new Event(
          e.path("name").asText(), e.path("t").asDouble(),
          e.hasNonNull("endT") ? e.path("endT").asDouble() : Double.NaN));
    }
    events.sort((a, b) -> Double.compare(a.t(), b.t()));
    var sections = new ArrayList<Section>();
    for (var s : n.path("sections")) {
      sections.add(new Section(
          s.path("name").asText(), s.path("startSample").asInt(), s.path("endSample").asInt(),
          s.path("startT").asDouble(), s.path("endT").asDouble()));
    }
    var spans = new ArrayList<PathfindSpan>();
    for (var p : n.path("pathfind")) {
      spans.add(new PathfindSpan(
          p.path("startSample").asInt(), p.path("endSample").asInt(),
          p.path("goalX").asDouble(), p.path("goalY").asDouble(), p.path("goalHeading").asDouble(),
          p.hasNonNull("maxVelocityMps") ? p.path("maxVelocityMps").asDouble() : Double.NaN,
          p.hasNonNull("maxAngularVelocityDps")
              ? Math.toRadians(p.path("maxAngularVelocityDps").asDouble())
              : Double.NaN,
          p.path("estimatedS").asDouble(), p.path("fromUnknown").asBoolean(false)));
    }
    var start = switch (n.path("start").asText("known")) {
      case "unknown" -> Start.UNKNOWN;
      case "previous" -> Start.PREVIOUS;
      default -> Start.KNOWN;
    };
    String name = n.path("name").asText();
    if (n.hasNonNull("variant")) name = name + "@" + n.path("variant").asText();
    return new AresTrajectory(
        name, samples, times, splits, events, sections, spans, start,
        n.hasNonNull("continuesFrom") ? n.path("continuesFrom").asText() : null);
  }

  public String name() {
    return name;
  }

  public List<AresSample> samples() {
    return samples;
  }

  public double duration() {
    return samples.get(samples.size() - 1).t() - samples.get(0).t();
  }

  public double startTime() {
    return samples.get(0).t();
  }

  public double endTime() {
    return samples.get(samples.size() - 1).t();
  }

  public AresSample initial() {
    return samples.get(0);
  }

  public AresSample last() {
    return samples.get(samples.size() - 1);
  }

  public List<Double> waypointTimes() {
    return waypointTimes;
  }

  public List<Integer> splits() {
    return splits;
  }

  public List<Event> events() {
    return events;
  }

  public List<Section> sections() {
    return sections;
  }

  public Optional<Section> section(String name) {
    return sections.stream().filter(s -> s.name().equals(name)).findFirst();
  }

  public List<PathfindSpan> pathfind() {
    return pathfind;
  }

  public Start start() {
    return start;
  }

  public Optional<String> continuesFrom() {
    return Optional.ofNullable(continuesFrom);
  }

  /** The state at time {@code t} (clamped to the trajectory). */
  public AresSample sample(double t) {
    if (t <= startTime()) return initial();
    if (t >= endTime()) return last();
    // The last sample at or before t.
    int lo = 0, hi = samples.size() - 1;
    while (hi - lo > 1) {
      int mid = (lo + hi) >>> 1;
      if (samples.get(mid).t() <= t) lo = mid;
      else hi = mid;
    }
    var a = samples.get(lo);
    return a.advance(t - a.t(), samples.get(hi));
  }

  /** The index of the sample that starts the segment holding {@code t}. */
  public int indexAt(double t) {
    int i = Collections.binarySearch(samples.stream().map(AresSample::t).toList(), t);
    return i >= 0 ? i : Math.max(0, -i - 2);
  }

  /** The trajectory the other alliance drives. */
  public AresTrajectory flipped(FieldSymmetry symmetry, double lengthM, double widthM, int[] partners) {
    var flipped = samples.stream().map(s -> symmetry.flip(s, lengthM, widthM, partners)).toList();
    var spans = pathfind.stream()
        .map(p -> {
          var g = symmetry.flip(p.goal(), lengthM, widthM);
          return new PathfindSpan(
              p.startSample(), p.endSample(), g.getX(), g.getY(), g.getRotation().getRadians(),
              p.maxVelocityMps(), p.maxAngularVelocityRadps(), p.estimatedS(), p.fromUnknown());
        })
        .toList();
    return new AresTrajectory(
        name, flipped, waypointTimes, splits, events, sections, spans, start, continuesFrom);
  }

  /**
   * Samples {@code [from, to]}, on a clock that starts at 0, with the events,
   * sections and estimated stretches that fall inside them.
   */
  public AresTrajectory slice(int from, int to) {
    from = Math.max(0, from);
    to = Math.min(samples.size() - 1, to);
    if (from == 0 && to == samples.size() - 1 && startTime() == 0) return this;
    double t0 = samples.get(from).t(), t1 = samples.get(to).t();
    final int f = from, l = to;
    var part = samples.subList(from, to + 1).stream().map(s -> s.shifted(-t0)).toList();
    var times = waypointTimes.stream().filter(t -> t >= t0 && t <= t1).map(t -> t - t0).toList();
    var cut = splits.stream().filter(s -> s > f && s < l).map(s -> s - f).toList();
    var ev = events.stream()
        .filter(e -> e.t() >= t0 && e.t() <= t1 || e.isZone() && e.t() < t0 && e.endT() > t0)
        .map(e -> new Event(e.name(), Math.max(e.t(), t0) - t0, e.isZone() ? Math.min(e.endT(), t1) - t0 : Double.NaN))
        .toList();
    var sec = sections.stream()
        .filter(s -> s.endSample() > f && s.startSample() < l)
        .map(s -> new Section(
            s.name(), Math.max(s.startSample(), f) - f, Math.min(s.endSample(), l) - f,
            Math.max(s.startT(), t0) - t0, Math.min(s.endT(), t1) - t0))
        .toList();
    var spans = pathfind.stream()
        .filter(p -> p.startSample() >= f && p.endSample() <= l)
        .map(p -> new PathfindSpan(
            p.startSample() - f, p.endSample() - f, p.goalX(), p.goalY(), p.goalHeading(),
            p.maxVelocityMps(), p.maxAngularVelocityRadps(), p.estimatedS(), p.fromUnknown()))
        .toList();
    return new AresTrajectory(
        name, part, times, cut, ev, sec, spans, from == 0 ? start : Start.PREVIOUS, continuesFrom);
  }

  /** The pieces between the splits: {@code split(0)} runs up to the first split waypoint. */
  public AresTrajectory split(int i) {
    var bounds = new ArrayList<Integer>();
    bounds.add(0);
    bounds.addAll(splits);
    bounds.add(samples.size() - 1);
    if (i < 0 || i >= bounds.size() - 1) {
      throw new IndexOutOfBoundsException(name + " has " + (bounds.size() - 1) + " splits, not " + (i + 1));
    }
    return slice(bounds.get(i), bounds.get(i + 1));
  }

  public int splitCount() {
    return splits.size() + 1;
  }

  /** The poses, for drawing the path on a field. */
  public Pose2d[] poses() {
    return samples.stream().map(AresSample::pose).toArray(Pose2d[]::new);
  }
}
