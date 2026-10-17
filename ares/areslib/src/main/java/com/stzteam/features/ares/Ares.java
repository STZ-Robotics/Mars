package com.stzteam.features.ares;

import com.stzteam.features.ares.index.AresIndex.Step;
import com.stzteam.features.ares.index.AresIndex;
import com.stzteam.features.ares.trajectory.AresSample;
import com.stzteam.features.ares.trajectory.AresTrajectory;
import com.stzteam.features.ares.trajectory.FieldSymmetry;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.networktables.NetworkTableEvent;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.wpilibj.Alert.AlertType;
import edu.wpi.first.wpilibj.Alert;
import edu.wpi.first.wpilibj.DriverStation.Alliance;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.Filesystem;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.smartdashboard.Field2d;
import edu.wpi.first.wpilibj.smartdashboard.SendableChooser;
import edu.wpi.first.wpilibj.smartdashboard.SmartDashboard;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.FunctionalCommand;
import edu.wpi.first.wpilibj2.command.Subsystem;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import java.io.File;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Queue;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.function.UnaryOperator;

/**
 * The robot side of Ares: reads the project deployed with the robot code and
 * turns its paths and autos into commands.
 *
 * <pre>{@code
 * Ares ares = new Ares(CtreSwerve.of(drivetrain), new Ares.Config());
 *
 * ares.registerCommand("shoot", superstructure.shoot());
 * ares.registerCondition("hasPiece", indexer::hasPiece);
 *
 * autoChooser = ares.autoChooser();          // every auto in the project
 * Command hub = ares.path("Hub run");        // or one path by itself
 * ares.event("intake").whileTrue(intake.run()); // or react to its markers
 * }</pre>
 *
 * <p>The Ares project lives in {@code src/main/deploy/ares/} (the {@code
 * .robot.json} and its {@code paths/}, {@code trajectories/}, {@code autos/}),
 * so a deploy carries it. Register the commands and conditions <em>before</em>
 * building autos: an auto looks them up as it is built, like PathPlanner's.
 */
public final class Ares {
  /** Everything with a default; change what differs with the {@code with} methods. */
  public static final class Config {
    File folder = new File(Filesystem.getDeployDirectory(), "ares");
    AresController.Gains translation = new AresController.Gains(4.0, 0, 0);
    AresController.Gains rotation = new AresController.Gains(4.0, 0, 0);
    /** Set by withGains: then gains.json is not read. */
    boolean gainsInCode;
    FieldSymmetry symmetry = FieldSymmetry.ROTATIONAL;
    double fieldLengthM = 16.541;
    double fieldWidthM = 8.0692;
    BooleanSupplier flip = () -> DriverStation.getAlliance().orElse(Alliance.Blue) == Alliance.Red;
    NetworkTableInstance nt = NetworkTableInstance.getDefault();
    boolean hotReload = true;
    AresPathfinder pathfinder;
    AresPathfinder.Constraints pathfindConstraints = new AresPathfinder.Constraints(3.0, 3.0, 2 * Math.PI, 4 * Math.PI);
    double estimateToleranceM = 0.3;
    double arriveToleranceM = 0.05;
    double arriveToleranceRad = Math.toRadians(3);
    boolean resetPoseAtAutoStart = true;
    double replanToleranceM = 0.5;
    double replanDelayS = 0.2;
    double rejoinAheadS = 1.0;
    int maxReplans = 3;
    double arriveM = 0.1;
    /** Set by withReplan or withArrival: then gains.json's recovery is not read. */
    boolean recoveryInCode;
    double periodS = 0.02;

    /** The Ares project folder; {@code deploy/ares} by default. */
    public Config withFolder(File folder) {
      this.folder = folder;
      return this;
    }

    /**
     * The feedback gains. With the wheel forces fed forward they correct only
     * what the forces missed, so they can be lower than PathPlanner's.
     */
    public Config withGains(AresController.Gains translation, AresController.Gains rotation) {
      this.translation = translation;
      this.rotation = rotation;
      this.gainsInCode = true;
      return this;
    }

    /** How the red alliance's field relates to blue's: rotational in 2026. */
    public Config withSymmetry(FieldSymmetry symmetry) {
      this.symmetry = symmetry;
      return this;
    }

    public Config withFieldSize(double lengthM, double widthM) {
      this.fieldLengthM = lengthM;
      this.fieldWidthM = widthM;
      return this;
    }

    /** When to drive the paths flipped; by default, on the red alliance. */
    public Config withFlip(BooleanSupplier flip) {
      this.flip = flip;
      return this;
    }

    /** What drives the "?" stretches when the robot is not where Ares expected. */
    public Config withPathfinder(AresPathfinder pathfinder) {
      this.pathfinder = pathfinder;
      return this;
    }

    /** The pathfinder's limits where the path set none. */
    public Config withPathfindConstraints(AresPathfinder.Constraints constraints) {
      this.pathfindConstraints = constraints;
      return this;
    }

    /** How far off Ares's estimate the robot may be and still follow it. */
    public Config withEstimateTolerance(double meters) {
      this.estimateToleranceM = meters;
      return this;
    }

    /** Whether an auto resets odometry to its first path's start (when that start is known). */
    /**
     * Whether the Ares app can send paths and autos to the robot without a
     * deploy (PathPlanner's hot reload); on by default. Never with a field
     * connected, and only until the robot restarts.
     */
    public Config withHotReload(boolean on) {
      this.hotReload = on;
      return this;
    }

    /** The NetworkTables instance for hot reload (the default one, but in tests). */
    public Config withNetworkTables(NetworkTableInstance nt) {
      this.nt = nt;
      return this;
    }

    public Config withResetPoseAtAutoStart(boolean reset) {
      this.resetPoseAtAutoStart = reset;
      return this;
    }

    /**
     * When the robot is more than {@code toleranceM} off the trajectory for a
     * moment, the pathfinder takes it to where the trajectory will be {@code
     * rejoinAheadS} later, and the path goes on from there (at most {@code
     * maxReplans} times per path). 0.5 m, 1 s and 3 by default; a tolerance of
     * 0 turns it off.
     */
    public Config withReplan(double toleranceM, double rejoinAheadS, int maxReplans) {
      this.replanToleranceM = toleranceM;
      this.rejoinAheadS = rejoinAheadS;
      this.maxReplans = maxReplans;
      this.recoveryInCode = true;
      return this;
    }

    /** The same, with how long it must stay that far off before it replans (0.2 s by default). */
    public Config withReplan(double toleranceM, double delayS, double rejoinAheadS, int maxReplans) {
      this.replanDelayS = delayS;
      return withReplan(toleranceM, rejoinAheadS, maxReplans);
    }

    /**
     * A path that ends at rest, ending farther than this from its last pose,
     * drives there before it is done: a shove late in a path does not leave
     * the robot where it fell. 0.1 m by default; 0 turns it off.
     */
    public Config withArrival(double toleranceM) {
      this.arriveM = toleranceM;
      this.recoveryInCode = true;
      return this;
    }

    /** The path controller's gains in use, after reading gains.json. */
    public AresController.Gains translation() {
      return translation;
    }

    public AresController.Gains rotation() {
      return rotation;
    }

    public Config withPeriod(double seconds) {
      this.periodS = seconds;
      return this;
    }
  }

  private final AresDrive drive;
  private final Config config;
  private volatile AresIndex index;
  /** The auto choosers made, with the folder each shows (null: all), to refresh on hot reload. */
  private final List<Map.Entry<SendableChooser<Command>, String>> choosers = new ArrayList<>();
  /** Hot reloads received on NetworkTables' thread, applied on the robot's. */
  private final Queue<Runnable> reloads = new ConcurrentLinkedQueue<>();
  private Field2d autoField;
  private String shownAuto = "";
  private final AresPathfinder pathfinder;
  private final Map<String, AresTrajectory> blue = new HashMap<>();
  private final Map<String, AresTrajectory> red = new HashMap<>();
  private final int[] partners;
  private final int[] driveOrder;
  private final Map<String, Command> commands = new HashMap<>();
  private final Map<String, BooleanSupplier> conditions = new HashMap<>();
  private final Set<String> activeEvents = new HashSet<>();
  private final Set<String> missing = new TreeSet<>();
  private final Alert missingAlert = new Alert("Ares", "", AlertType.kWarning);
  private final Alert loadAlert = new Alert("Ares", "", AlertType.kError);

  public Ares(AresDrive drive, Config config) {
    this.drive = drive;
    this.config = config;
    readGains(config);
    // Every loop: the robot's pose for the Live tab (path or not), the hot
    // reloads that came in, and the selected auto's start.
    edu.wpi.first.wpilibj2.command.CommandScheduler.getInstance().getDefaultButtonLoop().bind(this::periodic);
    if (config.hotReload) listenForHotReload();
    this.pathfinder = config.pathfinder != null ? config.pathfinder : defaultPathfinder(drive, config);
    AresIndex loaded;
    try {
      loaded = AresIndex.load(config.folder);
    } catch (Exception e) {
      // The robot must still boot without its autos.
      loaded = emptyIndex(config.folder);
      fail("Ares could not read its project: " + e.getMessage());
    }
    index = loaded;
    var bad = new ArrayList<String>();
    for (var p : index.paths().values()) {
      load(p.name(), p.trajectory(), p.generated(), bad);
      for (var v : p.variants()) load(p.name() + "@" + v.name(), v.trajectory(), v.trajectory() != null, bad);
    }
    if (!bad.isEmpty()) fail("Ares could not read " + String.join(", ", bad));
    var mx = index.modules().stream().mapToDouble(AresIndex.Module::xM).toArray();
    var my = index.modules().stream().mapToDouble(AresIndex.Module::yM).toArray();
    partners = config.symmetry.modulePartners(mx, my);
    driveOrder = matchModules(drive.moduleLocations(), index.modules());
  }

  // For each of the drivetrain's modules, the .robot.json module at the same
  // place: the forces were solved per module, and handing one wheel another's
  // force would push the robot sideways.
  private int[] matchModules(edu.wpi.first.math.geometry.Translation2d[] drivetrain, List<AresIndex.Module> ares) {
    if (drivetrain == null || ares.isEmpty()) return null;
    if (drivetrain.length != ares.size()) {
      fail("Ares: the drivetrain has " + drivetrain.length + " modules and the .robot.json " + ares.size() + "; the wheel forces are not fed forward");
      return new int[0];
    }
    var order = new int[drivetrain.length];
    var off = new ArrayList<String>();
    for (int k = 0; k < drivetrain.length; k++) {
      int best = 0;
      double bestD = Double.POSITIVE_INFINITY;
      for (int i = 0; i < ares.size(); i++) {
        double d = Math.hypot(ares.get(i).xM() - drivetrain[k].getX(), ares.get(i).yM() - drivetrain[k].getY());
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      order[k] = best;
      if (bestD > 0.03) off.add(String.format("%s is %.0f mm from the drivetrain's module %d", ares.get(best).name(), bestD * 1000, k));
    }
    if (!off.isEmpty()) {
      warnMissing("the .robot.json's modules are not where the drivetrain's are (" + String.join(", ", off) + "): check its module positions");
    }
    return order;
  }

  /** The setpoint with the forces in the drivetrain's module order. */
  AresSetpoint forDrive(AresSetpoint setpoint) {
    if (driveOrder != null && driveOrder.length == 0) {
      var zero = new double[0];
      return new AresSetpoint(setpoint.target(), setpoint.fieldSpeeds(), setpoint.robotSpeeds(), zero, zero, zero, zero, setpoint.sample());
    }
    return setpoint.reordered(driveOrder);
  }

  // The gains Tune applied (gains.json in the project), unless the code set
  // its own: what the robot runs with is then what was last tuned and
  // deployed, with no code to change.
  private void readGains(Config c) {
    var file = new File(c.folder, "gains.json");
    String source = "the defaults";
    if (c.gainsInCode) {
      source = "the robot code (withGains)";
    } else if (file.isFile()) {
      try {
        var n = new com.fasterxml.jackson.databind.ObjectMapper().readTree(file);
        var t = n.path("translation");
        var r = n.path("rotation");
        if (t.has("kp") && r.has("kp")) {
          c.translation = new AresController.Gains(t.path("kp").asDouble(), t.path("ki").asDouble(0), t.path("kd").asDouble(0));
          c.rotation = new AresController.Gains(r.path("kp").asDouble(), r.path("ki").asDouble(0), r.path("kd").asDouble(0));
          source = "gains.json" + (n.hasNonNull("source") ? " (" + n.path("source").asText() + ")" : "");
        }
        // The recovery Tune found against shoves, unless the code set its own.
        var rec = n.path("recovery");
        if (!c.recoveryInCode && rec.isObject()) {
          c.replanToleranceM = rec.path("toleranceM").asDouble(c.replanToleranceM);
          c.replanDelayS = rec.path("delayS").asDouble(c.replanDelayS);
          c.rejoinAheadS = rec.path("rejoinAheadS").asDouble(c.rejoinAheadS);
          c.arriveM = rec.path("arriveM").asDouble(c.arriveM);
          System.out.printf("Ares: recovery from gains.json: replan past %.2f m for %.2f s, rejoin %.2f s ahead, arrive within %.2f m%n",
              c.replanToleranceM, c.replanDelayS, c.rejoinAheadS, c.arriveM);
        }
      } catch (Exception e) {
        fail("Ares could not read gains.json (" + e.getMessage() + "): using " + (c.gainsInCode ? "the code's" : "the default") + " gains");
      }
    }
    var msg = String.format("Ares: path gains from %s: translation kP %.3f kI %.3f kD %.3f, rotation kP %.3f kI %.3f kD %.3f",
        source, c.translation.kP(), c.translation.kI(), c.translation.kD(), c.rotation.kP(), c.rotation.kI(), c.rotation.kD());
    System.out.println(msg);
    AresTelemetry.gains(source, c.translation, c.rotation);
  }

  // Around the navgrid when the project has one (navgrid.json, from the Field
  // tab), straight otherwise.
  private AresPathfinder defaultPathfinder(AresDrive drive, Config c) {
    var file = new File(c.folder, "navgrid.json");
    if (file.isFile()) {
      try {
        return new GridPathfinder(drive, NavGrid.load(file), c.translation, c.rotation, c.arriveToleranceM,
            c.arriveToleranceRad, c.flip, c.symmetry, c.fieldLengthM, c.fieldWidthM);
      } catch (Exception e) {
        fail("Ares could not read navgrid.json (" + e.getMessage() + "): pathfinding drives straight");
      }
    }
    return new StraightPathfinder(drive, c.translation, c.rotation, c.arriveToleranceM, c.arriveToleranceRad);
  }

  public Ares(AresDrive drive) {
    this(drive, new Config());
  }

  private void load(String key, String file, boolean generated, List<String> bad) {
    if (!generated || file == null) return;
    var f = index.file(file);
    if (!f.isFile()) return;
    try {
      blue.put(key, AresTrajectory.load(f));
    } catch (Exception e) {
      bad.add(file + " (" + e.getMessage() + ")");
    }
  }

  private static AresIndex emptyIndex(File folder) {
    try {
      return AresIndex.parse(folder, "{\"format\":1,\"paths\":[],\"autos\":[]}");
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private void fail(String message) {
    DriverStation.reportError(message, false);
    loadAlert.setText(message);
    loadAlert.set(true);
  }

  void warnMissing(String what) {
    if (!missing.add(what)) return;
    DriverStation.reportWarning("Ares: " + what, false);
    missingAlert.setText("Ares: " + String.join("; ", missing));
    missingAlert.set(true);
  }

  // --- Named commands and conditions ---------------------------------------

  /**
   * A command the autos and the event markers call by name: the {@code name}
   * of a command step, or of an event marker.
   */
  public Ares registerCommand(String name, Command command) {
    commands.put(name, command);
    return this;
  }

  /** The same, built fresh when an auto asks for it. */
  public Ares registerCommand(String name, Supplier<Command> command) {
    return registerCommand(name, Commands.defer(command, Set.of()));
  }

  /** A condition the autos' if steps and the paths' branches ask by name. */
  public Ares registerCondition(String name, BooleanSupplier condition) {
    conditions.put(name, condition);
    return this;
  }

  public boolean hasCommand(String name) {
    return commands.containsKey(name);
  }

  public boolean hasCondition(String name) {
    return conditions.containsKey(name);
  }

  /**
   * The registered command, wrapped so it can go into as many autos as use it
   * (WPILib lets a command be composed only once).
   */
  public Command command(String name) {
    var c = commands.get(name);
    if (c == null) {
      warnMissing("no command \"" + name + "\" registered");
      return Commands.none().withName(name + " (missing)");
    }
    return new FunctionalCommand(
            c::initialize, c::execute, c::end, c::isFinished, c.getRequirements().toArray(Subsystem[]::new))
        .withName(name);
  }

  /** Evaluates a registered condition now; false (and a warning) when there is none. */
  public boolean condition(String name) {
    var c = conditions.get(name);
    if (c == null) {
      warnMissing("no condition \"" + name + "\" registered");
      return false;
    }
    return c.getAsBoolean();
  }

  Command eventCommand(String name) {
    return commands.get(name);
  }

  /**
   * What an event marker runs: the command built on it in Ares, fresh, or
   * the one registered under its name (null when there is neither).
   */
  Command eventCommand(AresTrajectory.Event e) {
    if (e.command() == null) return commands.get(e.name());
    return build(List.of(e.command()), new ArrayList<>(List.of("event " + e.name())), new double[] {Timer.getFPGATimestamp()})
        .withName(e.name());
  }

  /**
   * True while a path is inside the event's zone, or for one loop when it
   * passes a marker that happens once. For reacting to markers with triggers
   * instead of (or besides) registering a command under their name.
   */
  public Trigger event(String name) {
    return new Trigger(() -> activeEvents.contains(name));
  }

  Set<String> activeEvents() {
    return activeEvents;
  }

  // --- Paths ---------------------------------------------------------------

  /** A path, driven whole, taking its branches when their conditions hold. */
  public Command path(String name) {
    return new FollowPath(this, name, UnaryOperator.identity(), -1, true);
  }

  // --- Going somewhere by itself ------------------------------------------

  /**
   * Drives to {@code goal} by itself (PathPlanner's pathfindToPose): around
   * the project's navgrid when it has one, straight otherwise, with the
   * pathfinding limits of the Config. The pose is in blue's coordinates, as
   * the paths are drawn, and is flipped on red. For teleop (a button that
   * lines up at the amp) or a step in code.
   */
  public Command pathfindTo(Pose2d goal) {
    return pathfindTo(() -> goal, config.pathfindConstraints);
  }

  /** The same, to a pose decided when it starts, with its own limits. */
  public Command pathfindTo(Supplier<Pose2d> goal, AresPathfinder.Constraints constraints) {
    return Commands.defer(() -> {
      var g = goal.get();
      if (config.flip.getAsBoolean()) g = config.symmetry.flip(g, config.fieldLengthM, config.fieldWidthM);
      return pathfinder.toPose(g, new ChassisSpeeds(), constraints);
    }, Set.of(drive.subsystem())).withName("Ares: to a pose");
  }

  /**
   * Drives by itself to where a path starts, then follows the path
   * (PathPlanner's pathfindThenFollowPath): for a path that is not driven
   * from where the robot already is.
   */
  public Command pathfindThenFollow(String path) {
    var start = trajectory(path).initial().pose();
    return Commands.sequence(pathfindTo(start), path(path)).withName("Ares: to " + path + ", then " + path);
  }

  /**
   * A path made on the robot through poses decided in code (PathPlanner's
   * paths from poses): a smooth curve through {@code waypoints}, the first
   * being where it starts, each pose's rotation the direction of travel
   * there, ending still and facing {@code endHeading}. Blue's coordinates,
   * flipped on red. It knows no wheel forces and no obstacles: for short
   * moves decided in the moment; what can be drawn in advance is better
   * drawn in Ares.
   */
  public Command pathThrough(Rotation2d endHeading, Pose2d... waypoints) {
    var list = List.of(waypoints);
    return curve(() -> onAlliance(list), endHeading, config.pathfindConstraints, "through " + list.size() + " poses");
  }

  /** The same from wherever the robot is: it sets off toward the first pose, then goes through the rest. */
  public Command pathFromHere(Rotation2d endHeading, Pose2d... waypoints) {
    return pathFromHere(config.pathfindConstraints, endHeading, () -> List.of(waypoints));
  }

  /** The same, with poses decided when it starts and limits of its own. */
  public Command pathFromHere(AresPathfinder.Constraints constraints, Rotation2d endHeading, Supplier<List<Pose2d>> waypoints) {
    return curve(() -> CurveThrough.fromHere(drive.pose(), onAlliance(waypoints.get())), endHeading, constraints, "from here");
  }

  private Command curve(Supplier<List<Pose2d>> points, Rotation2d endHeading, AresPathfinder.Constraints limits, String what) {
    Supplier<Rotation2d> heading = () -> config.flip.getAsBoolean()
        ? config.symmetry.flip(new Pose2d(config.fieldLengthM / 2, config.fieldWidthM / 2, endHeading), config.fieldLengthM, config.fieldWidthM).getRotation()
        : endHeading;
    return new CurveThrough(drive, points, heading, limits, config.translation, config.rotation, config.arriveToleranceM, config.arriveToleranceRad)
        .withName("Ares: " + what);
  }

  /** Poses drawn for blue, on the alliance the robot is on now. */
  private List<Pose2d> onAlliance(List<Pose2d> poses) {
    if (!config.flip.getAsBoolean()) return poses;
    return poses.stream().map(p -> config.symmetry.flip(p, config.fieldLengthM, config.fieldWidthM)).toList();
  }

  /**
   * A routine built with triggers in code, as Choreo's AutoRoutine: its
   * paths say when they are running, when they end, when they reach a time,
   * a marker or a pose, and the commands are bound to that.
   *
   * <pre>{@code
   * var r = ares.routine("Two piece");
   * var main = r.path("Main");
   * var alt = r.path("Alt");
   * r.active().onTrue(main.resetOdometry().andThen(main.cmd()));
   * main.atTime("intake").onTrue(intake.deploy());
   * main.done().onTrue(alt.cmd());
   * alt.atPose(new Pose2d(5, 2, Rotation2d.kZero), 0.3).onTrue(shooter.spinUp());
   * alt.done().onTrue(shoot());
   * chooser.addOption("Two piece", r.cmd());
   * }</pre>
   */
  public AresRoutine routine(String name) {
    return new AresRoutine(this, name);
  }

  /** One of a path's variants. */
  public Command path(String name, String variant) {
    return variant == null ? path(name) : new FollowPath(this, name + "@" + variant, UnaryOperator.identity(), -1, true);
  }

  /** A named section of a path, by itself. */
  public Command section(String path, String section) {
    return new FollowPath(this, path, t -> {
      var s = t.section(section).orElseThrow(() -> new IllegalArgumentException(path + " has no section \"" + section + "\""));
      return t.slice(s.startSample(), s.endSample());
    }, -1, false);
  }

  /** The {@code i}-th piece of a path cut at its split waypoints. */
  public Command split(String path, int i) {
    return new FollowPath(this, path, t -> t.split(i), -1, false);
  }

  /** The trajectory as Ares wrote it (blue alliance), or null if it was never generated. */
  public AresTrajectory trajectory(String key) {
    return blue.get(key);
  }

  /** The trajectory for the alliance: flipped when {@code flipped}. */
  public AresTrajectory orient(AresTrajectory t, boolean flipped) {
    if (!flipped) return t;
    if (blue.get(t.name()) == t) return red.computeIfAbsent(t.name(), k -> flip(t));
    return flip(t);
  }

  private AresTrajectory flip(AresTrajectory t) {
    int m = t.initial().modules();
    var p = partners.length == m ? partners : identity(m);
    return t.flipped(config.symmetry, config.fieldLengthM, config.fieldWidthM, p);
  }

  private static int[] identity(int n) {
    var out = new int[n];
    for (int i = 0; i < n; i++) out[i] = i;
    return out;
  }

  List<AresIndex.Branch> branches(String key) {
    var name = key.contains("@") ? key.substring(0, key.indexOf('@')) : key;
    return index.path(name).map(AresIndex.PathEntry::branches).orElse(List.of());
  }

  /** Every event marker the path may pass, branches included. */
  List<AresTrajectory.Event> eventsReachable(String key, boolean withBranches) {
    var out = new ArrayList<AresTrajectory.Event>();
    var seen = new HashSet<String>();
    var todo = new ArrayList<String>(List.of(key));
    while (!todo.isEmpty()) {
      var k = todo.remove(todo.size() - 1);
      if (!seen.add(k)) continue;
      var t = blue.get(k);
      if (t != null) out.addAll(t.events());
      if (withBranches) branches(k).forEach(b -> todo.add(b.path()));
    }
    return out;
  }

  // --- Autos ---------------------------------------------------------------

  public Set<String> autoNames() {
    return index.autos().keySet();
  }

  public Set<String> pathNames() {
    return index.paths().keySet();
  }

  /** An auto from the Autos tab, as one command. */
  public Command auto(String name) {
    var auto = index.auto(name);
    if (auto.isEmpty()) {
      warnMissing("no auto \"" + name + "\" in the project");
      return Commands.none().withName(name + " (missing)");
    }
    var steps = auto.get().steps();
    // When the auto started, for the when steps that wait for a time.
    double[] started = {Double.NaN};
    var body = build(steps, new ArrayList<>(List.of(name)), started);
    var reset = auto.get().resetOdometry();
    if (reset != null ? reset : config.resetPoseAtAutoStart) {
      var first = firstPath(steps, new HashSet<>());
      var traj = first == null ? null : blue.get(first);
      if (traj != null && traj.start() == AresTrajectory.Start.KNOWN) {
        body = Commands.runOnce(() -> drive.resetPose(orient(traj, config.flip.getAsBoolean()).initial().pose()))
            .andThen(body);
      }
    }
    return Commands.runOnce(() -> started[0] = Timer.getFPGATimestamp()).andThen(body).withName(name);
  }

  /** Where an auto starts, on the alliance the robot is on now: for placing it before the match. */
  public Optional<Pose2d> startPose(String auto) {
    var a = index.auto(auto);
    if (a.isEmpty()) return Optional.empty();
    var first = firstPath(a.get().steps(), new HashSet<>());
    var traj = first == null ? null : blue.get(first);
    if (traj == null || traj.start() != AresTrajectory.Start.KNOWN) return Optional.empty();
    return Optional.of(orient(traj, config.flip.getAsBoolean()).initial().pose());
  }

  /** Every auto, plus "None", for the dashboard. */
  public SendableChooser<Command> autoChooser() {
    return autoChooser(null);
  }

  /**
   * The autos in one folder of the Autos tab (PathPlanner's chooser with a
   * filter), plus "None": a chooser for qualifiers, another for playoffs.
   * While the robot is disabled, the one picked is published with where to
   * put the robot for it (/Ares/Auto, and the "Ares Auto" field).
   */
  public SendableChooser<Command> autoChooser(String folder) {
    var chooser = new SendableChooser<Command>();
    chooser.setDefaultOption("None", Commands.none());
    fillChooser(chooser, folder);
    choosers.add(Map.entry(chooser, folder == null ? "" : folder));
    return chooser;
  }

  private void fillChooser(SendableChooser<Command> chooser, String folder) {
    for (var a : index.autos().values()) {
      if (folder == null || folder.isEmpty() || folder.equals(a.folder())) chooser.addOption(a.name(), auto(a.name()));
    }
  }

  // --- Every loop ------------------------------------------------------------

  private void periodic() {
    AresTelemetry.robot(drive.pose());
    for (Runnable r; (r = reloads.poll()) != null; ) r.run();
    if (DriverStation.isDisabled() && !choosers.isEmpty()) showSelectedAuto();
  }

  /** The auto picked in the last chooser made: its name, its start pose, its first path on the field. */
  private void showSelectedAuto() {
    var picked = choosers.get(choosers.size() - 1).getKey().getSelected();
    var name = picked == null ? "None" : picked.getName();
    var key = name + (config.flip.getAsBoolean() ? "@red" : "@blue");
    if (key.equals(shownAuto)) return;
    shownAuto = key;
    var start = startPose(name).orElse(null);
    AresTelemetry.selectedAuto(name, start);
    if (autoField == null) {
      autoField = new Field2d();
      SmartDashboard.putData("Ares Auto", autoField);
    }
    if (start != null) autoField.setRobotPose(start);
    var first = index.auto(name).map(a -> firstPath(a.steps(), new HashSet<>())).orElse(null);
    var traj = first == null ? null : blue.get(first);
    autoField.getObject("Path").setPoses(traj == null ? List.of()
        : orient(traj, config.flip.getAsBoolean()).samples().stream().map(AresSample::pose).toList());
  }

  // --- Hot reload --------------------------------------------------------------

  private static final String RELOAD = "/Ares/HotReload/";

  private void listenForHotReload() {
    config.nt.addListener(new String[] {RELOAD + "Trajectories/", RELOAD + "Index"}, EnumSet.of(NetworkTableEvent.Kind.kValueRemote), e -> {
      var v = e.valueData;
      if (v == null || !v.value.isString()) return;
      var topic = v.getTopic().getName();
      var json = v.value.getString();
      reloads.add(() -> hotReload(topic, json));
    });
  }

  private void hotReload(String topic, String json) {
    var status = config.nt.getTable("Ares").getSubTable("HotReload");
    var what = topic.startsWith(RELOAD + "Trajectories/") ? topic.substring((RELOAD + "Trajectories/").length()) : "the autos";
    if (DriverStation.isFMSAttached()) {
      status.getEntry("Last").setString("refused " + what + ": a field is connected");
      return;
    }
    try {
      if (what.equals("the autos")) {
        index = AresIndex.parse(config.folder, json);
        for (var c : choosers) fillChooser(c.getKey(), c.getValue());
        shownAuto = "";
      } else {
        blue.put(what, AresTrajectory.parse(json));
        red.remove(what);
      }
      status.getEntry("Last").setString("applied " + what);
      status.getEntry("Count").setDouble(status.getEntry("Count").getDouble(0) + 1);
      System.out.println("Ares: hot reload of " + what);
    } catch (Exception ex) {
      status.getEntry("Last").setString("failed " + what + ": " + ex.getMessage());
    }
  }

  // The first path an auto drives, when it is the first thing that moves the
  // robot for certain (an if before it makes it a guess).
  private String firstPath(List<Step> steps, Set<String> seen) {
    for (var s : steps) {
      if (s instanceof Step.Path p) return p.variant() == null ? p.path() : p.path() + "@" + p.variant();
      if (s instanceof Step.If) return null;
      if (s instanceof Step.When) continue;
      if (s instanceof Step.Group g) {
        var found = firstPath(g.steps(), seen);
        if (found != null) return found;
        continue;
      }
      if (s instanceof Step.Parallel g) {
        for (var b : g.branches()) {
          var found = firstPath(b, seen);
          if (found != null) return found;
        }
        continue;
      }
      if (s instanceof Step.RunAuto r) {
        if (!seen.add(r.auto())) return null;
        var inner = index.auto(r.auto());
        if (inner.isEmpty()) return null;
        var found = firstPath(inner.get().steps(), seen);
        if (found != null || !inner.get().steps().isEmpty()) return found;
      }
    }
    return null;
  }

  private Command build(List<Step> steps, List<String> stack, double[] started) {
    var out = new ArrayList<Command>();
    for (int i = 0; i < steps.size(); i++) {
      var s = steps.get(i);
      var rest = steps.subList(i + 1, steps.size());
      if (s instanceof Step.Command c && c.alongside()) {
        // It runs with everything after it, and stops when that is done.
        out.add(Commands.deadline(build(rest, stack, started), command(c.name())));
        break;
      }
      if (s instanceof Step.When w) {
        // Armed here; when it fires, its steps run alongside the rest (and
        // stop with it). Last in its list, it is all there is to wait for.
        var fired = Commands.waitUntil(trigger(w.trigger(), started)).andThen(build(w.steps(), stack, started));
        if (rest.isEmpty()) {
          out.add(fired);
        } else {
          out.add(compose(stack, "a when step",
              () -> Commands.deadline(build(rest, stack, started), fired),
              () -> build(rest, stack, started)));
        }
        break;
      }
      var next = i + 1 < steps.size() ? steps.get(i + 1) : null;
      out.add(step(s, next, stack, started));
    }
    if (out.isEmpty()) return Commands.none();
    return out.size() == 1 ? out.get(0) : Commands.sequence(out.toArray(Command[]::new));
  }

  // WPILib refuses a group whose members share a subsystem (two paths at once,
  // a when that drives during a path): an alert and what can run, instead of a
  // robot that does not boot.
  // The fallback is built fresh: WPILib marks the members of a group as
  // composed before it finds the clash, and those can go nowhere else.
  private Command compose(List<String> stack, String what, Supplier<Command> group, Supplier<Command> fallback) {
    try {
      return group.get();
    } catch (IllegalArgumentException e) {
      warnMissing("auto \"" + stack.get(0) + "\": " + what + " has two things using the same subsystem (" + e.getMessage() + "); only the first runs");
      return fallback.get();
    }
  }

  private BooleanSupplier trigger(AresIndex.Trigger t, double[] started) {
    if (t instanceof AresIndex.Trigger.Time time) {
      return () -> !Double.isNaN(started[0]) && Timer.getFPGATimestamp() - started[0] >= time.atS();
    }
    if (t instanceof AresIndex.Trigger.Zone z) {
      return () -> {
        var p = drive.pose().getTranslation();
        // The zone is drawn for blue: bring the robot into blue's frame.
        if (config.flip.getAsBoolean()) p = config.symmetry.flip(p, config.fieldLengthM, config.fieldWidthM);
        return p.getX() >= z.x() && p.getX() <= z.x() + z.widthM() && p.getY() >= z.y() && p.getY() <= z.y() + z.heightM();
      };
    }
    var c = (AresIndex.Trigger.Condition) t;
    return () -> condition(c.name());
  }

  private Command step(Step s, Step next, List<String> stack, double[] started) {
    if (s instanceof Step.Path p) {
      var key = p.variant() == null ? p.path() : p.path() + "@" + p.variant();
      // Followed by a branch of itself: drive only up to where it leaves.
      int until = -1;
      if (next instanceof Step.Path n) {
        var child = index.path(n.path());
        if (child.isPresent() && p.path().equals(child.get().continuesFrom()) && child.get().continuesAt() != null) {
          until = child.get().continuesAt();
        }
      }
      if (!blue.containsKey(key)) warnMissing("\"" + key + "\" is not generated");
      return new FollowPath(this, key, UnaryOperator.identity(), until, until < 0);
    }
    if (s instanceof Step.Wait w) return Commands.waitSeconds(w.seconds());
    if (s instanceof Step.Command c) return command(c.name());
    if (s instanceof Step.If f) {
      var then = build(f.then(), stack, started);
      var otherwise = build(f.otherwise(), stack, started);
      return Commands.either(then, otherwise, () -> condition(f.condition()));
    }
    if (s instanceof Step.Group g) {
      if (g.type().equals("sequential")) return build(g.steps(), stack, started);
      var members = g.steps();
      if (members.isEmpty()) return Commands.none();
      if (members.size() == 1) return build(members, stack, started);
      return compose(stack, "a " + g.type() + " group", () -> {
        var cmds = members.stream().map(m -> build(List.of(m), stack, started)).toArray(Command[]::new);
        var others = java.util.Arrays.copyOfRange(cmds, 1, cmds.length);
        return switch (g.type()) {
          case "race" -> Commands.race(cmds);
          case "deadline" -> Commands.deadline(cmds[0], others);
          default -> Commands.parallel(cmds);
        };
      }, () -> build(List.of(members.get(0)), stack, started));
    }
    if (s instanceof Step.Parallel g) {
      var branches = g.branches();
      if (branches.isEmpty()) return Commands.none();
      if (branches.size() == 1) return build(branches.get(0), stack, started);
      return compose(stack, "a together step", () -> {
        var lists = branches.stream().map(b -> build(b, stack, started)).toArray(Command[]::new);
        var others = java.util.Arrays.copyOfRange(lists, 1, lists.length);
        return switch (g.mode()) {
          case "race" -> Commands.race(lists);
          case "deadline" -> Commands.deadline(lists[0], others);
          default -> Commands.parallel(lists);
        };
      }, () -> build(branches.get(0), stack, started));
    }
    if (s instanceof Step.RunAuto r) {
      var inner = index.auto(r.auto());
      if (inner.isEmpty()) {
        warnMissing("no auto \"" + r.auto() + "\" in the project");
        return Commands.none();
      }
      if (stack.contains(r.auto())) {
        warnMissing("auto \"" + r.auto() + "\" runs itself");
        return Commands.none();
      }
      var deeper = new ArrayList<>(stack);
      deeper.add(r.auto());
      return build(inner.get().steps(), deeper, started);
    }
    throw new IllegalArgumentException("Unknown step " + s);
  }

  // --- For the commands ----------------------------------------------------

  AresDrive drive() {
    return drive;
  }

  Config config() {
    return config;
  }

  AresPathfinder pathfinder() {
    return pathfinder;
  }

  public AresIndex index() {
    return index;
  }
}
