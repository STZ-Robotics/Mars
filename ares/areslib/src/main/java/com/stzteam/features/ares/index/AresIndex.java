package com.stzteam.features.ares.index;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * {@code ares-index.json}: what the Ares project holds, written by the app every
 * time a path or an auto is saved. The robot reads it instead of listing
 * folders, so it knows the branches, variants and autos without guessing.
 */
public final class AresIndex {
  /** Where a path branches off another: at a waypoint, when a condition holds. */
  public record Branch(int atWaypoint, double atTime, String condition, String path) {}

  public record Variant(String name, String trajectory) {}

  public record PathEntry(
      String name,
      /* Relative to the index's folder; null until it is generated. */
      String trajectory,
      boolean generated,
      List<Variant> variants,
      String continuesFrom,
      Integer continuesAt,
      String condition,
      List<Branch> branches) {
    public Optional<String> trajectoryFor(String variant) {
      if (variant == null) return Optional.ofNullable(generated ? trajectory : null);
      return variants.stream().filter(v -> v.name().equals(variant)).map(Variant::trajectory).findFirst();
    }
  }

  public record Module(String name, double xM, double yM) {}

  /**
   * The drive's mechanics as the {@code .robot.json} has them, to check them against the
   * drivetrain's: the trajectories were planned with these. NaN where the index does not say.
   */
  public record Drive(double wheelRadiusM, double driveGearRatio, double driveCurrentLimitA) {}

  /**
   * An auto. {@code resetOdometry} is the Autos tab's choice for this one
   * (PathPlanner's "Reset Odometry"): whether it sets the robot's pose to its
   * first path's start; null leaves it to {@code Config.withResetPoseAtAutoStart}.
   */
  public record Auto(String name, double budgetS, List<Step> steps, Boolean resetOdometry, String folder) {
    public Auto(String name, double budgetS, List<Step> steps) {
      this(name, budgetS, steps, null, null);
    }
  }

  /** One step of an auto, as the Autos tab stores it. */
  public sealed interface Step {
    record Path(String path, String variant) implements Step {}

    record Wait(double seconds) implements Step {}

    record Command(String name, double estimateS, boolean alongside) implements Step {}

    record If(String condition, List<Step> then, List<Step> otherwise) implements Step {}

    record RunAuto(String auto) implements Step {}

    /**
     * A command group, as PathPlanner's: "sequential" (one after another),
     * "parallel" (all, until all end), "deadline" (all, until the first ends)
     * or "race" (all, until any ends). Each of {@code steps} is one member.
     */
    record Group(String type, List<Step> steps) implements Step {}

    /** The format before command groups: lists at once ("all", "race" or "deadline"). */
    record Parallel(String mode, List<List<Step>> branches) implements Step {}

    /** Once the trigger fires, the steps run alongside the rest of the auto. */
    record When(Trigger trigger, List<Step> steps) implements Step {}
  }

  /** What a when step waits for. */
  public sealed interface Trigger {
    /** Seconds since the auto started. */
    record Time(double atS) implements Trigger {}

    /** The robot's center inside a rectangle, blue coordinates (flipped on red). */
    record Zone(double x, double y, double widthM, double heightM) implements Trigger {}

    record Condition(String name) implements Trigger {}
  }

  private static final ObjectMapper JSON = new ObjectMapper();

  private final File folder;
  private final String robot;
  private final List<Module> modules;
  private final double[] bumper;
  private final Drive drive;
  private final Field field;
  private final Map<String, PathEntry> paths;
  private final Map<String, Auto> autos;

  /** The field the Ares project plays on (Settings → Field). */
  public record Field(String key, double lengthM, double widthM, boolean mirrored) {}

  private AresIndex(File folder, String robot, List<Module> modules, double[] bumper, Drive drive, Field field, Map<String, PathEntry> paths, Map<String, Auto> autos) {
    this.field = field;
    this.folder = folder;
    this.robot = robot;
    this.modules = modules;
    this.bumper = bumper;
    this.drive = drive;
    this.paths = paths;
    this.autos = autos;
  }

  /** Reads {@code ares-index.json} from the Ares project folder. */
  public static AresIndex load(File folder) throws IOException {
    var file = new File(folder, "ares-index.json");
    if (!file.isFile()) {
      throw new IOException("There is no ares-index.json in " + folder
          + ": put the Ares project (the .robot.json and its folders) in src/main/deploy/ares/ and open it in Ares once");
    }
    return parse(folder, JSON.readTree(file));
  }

  public static AresIndex parse(File folder, String json) throws IOException {
    return parse(folder, JSON.readTree(json));
  }

  static AresIndex parse(File folder, JsonNode n) throws IOException {
    int format = n.path("format").asInt(0);
    if (format != 1) {
      throw new IOException("ares-index.json is format " + format + "; this AresLib reads format 1. Update AresLib or Ares so they match.");
    }
    var modules = new ArrayList<Module>();
    for (var m : n.path("robot").path("modules")) {
      modules.add(new Module(m.path("name").asText(), m.path("xM").asDouble(), m.path("yM").asDouble()));
    }
    var paths = new LinkedHashMap<String, PathEntry>();
    for (var p : n.path("paths")) {
      var variants = new ArrayList<Variant>();
      for (var v : p.path("variants")) variants.add(new Variant(v.path("name").asText(), text(v, "trajectory")));
      var branches = new ArrayList<Branch>();
      for (var b : p.path("branches")) {
        branches.add(new Branch(
            b.path("atWaypoint").asInt(), b.path("atTime").asDouble(Double.NaN),
            text(b, "condition"), b.path("path").asText()));
      }
      branches.sort((a, b) -> Integer.compare(a.atWaypoint(), b.atWaypoint()));
      var entry = new PathEntry(
          p.path("name").asText(), text(p, "trajectory"), p.path("generated").asBoolean(false),
          variants, text(p, "continuesFrom"),
          p.hasNonNull("continuesAt") ? p.path("continuesAt").asInt() : null,
          text(p, "condition"), branches);
      paths.put(entry.name(), entry);
    }
    var autos = new LinkedHashMap<String, Auto>();
    for (var a : n.path("autos")) {
      var auto = new Auto(
          a.path("name").asText(), a.path("budgetS").asDouble(15), steps(a.path("steps")),
          a.hasNonNull("resetOdometry") ? a.path("resetOdometry").asBoolean() : null,
          text(a, "folder"));
      autos.put(auto.name(), auto);
    }
    var b = n.path("robot").path("bumper");
    double[] bumper = b.has("lengthM") && b.has("widthM") ? new double[] {b.path("lengthM").asDouble(), b.path("widthM").asDouble()} : null;
    var d = n.path("robot").path("drive");
    Drive drive = d.isObject()
        ? new Drive(d.path("wheelRadiusM").asDouble(Double.NaN), d.path("driveGearRatio").asDouble(Double.NaN), d.path("driveCurrentLimitA").asDouble(Double.NaN))
        : null;
    var f = n.path("field");
    var field = f.has("lengthM") && f.has("widthM")
        ? new Field(f.path("key").asText(""), f.path("lengthM").asDouble(), f.path("widthM").asDouble(), "mirrored".equals(f.path("symmetry").asText()))
        : null;
    return new AresIndex(folder, n.path("robot").path("name").asText(""), List.copyOf(modules), bumper, drive, field, paths, autos);
  }

  /** One step (an event marker's command); null for a kind this version does not know. */
  public static Step step(JsonNode s) {
    var arr = new com.fasterxml.jackson.databind.node.ArrayNode(com.fasterxml.jackson.databind.node.JsonNodeFactory.instance);
    arr.add(s);
    var list = steps(arr);
    return list.isEmpty() ? null : list.get(0);
  }

  private static List<Step> steps(JsonNode list) {
    var out = new ArrayList<Step>();
    for (var s : list) {
      switch (s.path("type").asText()) {
        case "path" -> out.add(new Step.Path(s.path("path").asText(), text(s, "variant")));
        case "wait" -> out.add(new Step.Wait(s.path("seconds").asDouble()));
        case "command" -> out.add(new Step.Command(
            s.path("name").asText(), s.path("estimateS").asDouble(0), s.path("alongside").asBoolean(false)));
        case "if" -> out.add(new Step.If(s.path("condition").asText(), steps(s.path("then")), steps(s.path("else"))));
        case "auto" -> out.add(new Step.RunAuto(s.path("auto").asText()));
        case "parallel", "sequential", "deadline", "race" -> {
          if (s.has("branches")) {
            var branches = new ArrayList<List<Step>>();
            for (var b : s.path("branches")) branches.add(steps(b));
            out.add(new Step.Parallel(s.path("mode").asText("all"), List.copyOf(branches)));
          } else {
            out.add(new Step.Group(s.path("type").asText(), steps(s.path("steps"))));
          }
        }
        case "when" -> {
          var t = s.path("trigger");
          Trigger trigger = switch (t.path("kind").asText()) {
            case "zone" -> new Trigger.Zone(t.path("x").asDouble(), t.path("y").asDouble(), t.path("widthM").asDouble(), t.path("heightM").asDouble());
            case "condition" -> new Trigger.Condition(t.path("name").asText());
            default -> new Trigger.Time(t.path("atS").asDouble());
          };
          out.add(new Step.When(trigger, steps(s.path("steps"))));
        }
        default -> {
          // A step from a newer Ares: skipping it is safer than guessing.
        }
      }
    }
    return List.copyOf(out);
  }

  private static String text(JsonNode n, String field) {
    return n.hasNonNull(field) ? n.path(field).asText() : null;
  }

  public File folder() {
    return folder;
  }

  public String robot() {
    return robot;
  }

  /** The project's field, or null when it did not choose one. */
  public Field field() {
    return field;
  }

  /** The bumper's length and width (m), or null in an index from before Ares wrote it. */
  public double[] bumper() {
    return bumper;
  }

  /** The drive's mechanics, or null in an index from before Ares wrote them. */
  public Drive drive() {
    return drive;
  }

  public List<Module> modules() {
    return modules;
  }

  public Map<String, PathEntry> paths() {
    return paths;
  }

  public Optional<PathEntry> path(String name) {
    return Optional.ofNullable(paths.get(name));
  }

  public Map<String, Auto> autos() {
    return autos;
  }

  public Optional<Auto> auto(String name) {
    return Optional.ofNullable(autos.get(name));
  }

  public File file(String relative) {
    return new File(folder, relative);
  }
}
