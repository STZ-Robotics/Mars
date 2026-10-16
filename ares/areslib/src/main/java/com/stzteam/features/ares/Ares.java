package com.stzteam.features.ares;

import com.stzteam.features.ares.index.AresIndex;
import com.stzteam.features.ares.index.AresIndex.Step;
import com.stzteam.features.ares.trajectory.AresTrajectory;
import com.stzteam.features.ares.trajectory.FieldSymmetry;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.wpilibj.Alert;
import edu.wpi.first.wpilibj.Alert.AlertType;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.DriverStation.Alliance;
import edu.wpi.first.wpilibj.Filesystem;
import edu.wpi.first.wpilibj.smartdashboard.SendableChooser;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.FunctionalCommand;
import edu.wpi.first.wpilibj2.command.Subsystem;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
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
    FieldSymmetry symmetry = FieldSymmetry.ROTATIONAL;
    double fieldLengthM = 16.541;
    double fieldWidthM = 8.0692;
    BooleanSupplier flip = () -> DriverStation.getAlliance().orElse(Alliance.Blue) == Alliance.Red;
    AresPathfinder pathfinder;
    AresPathfinder.Constraints pathfindConstraints = new AresPathfinder.Constraints(3.0, 3.0, 2 * Math.PI, 4 * Math.PI);
    double estimateToleranceM = 0.3;
    double arriveToleranceM = 0.05;
    double arriveToleranceRad = Math.toRadians(3);
    boolean resetPoseAtAutoStart = true;
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
    public Config withResetPoseAtAutoStart(boolean reset) {
      this.resetPoseAtAutoStart = reset;
      return this;
    }

    public Config withPeriod(double seconds) {
      this.periodS = seconds;
      return this;
    }
  }

  private final AresDrive drive;
  private final Config config;
  private final AresIndex index;
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

  private void warnMissing(String what) {
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

  /** Every event name the path may pass, branches included. */
  Set<String> eventsReachable(String key, boolean withBranches) {
    var out = new LinkedHashSet<String>();
    var seen = new HashSet<String>();
    var todo = new ArrayList<String>(List.of(key));
    while (!todo.isEmpty()) {
      var k = todo.remove(todo.size() - 1);
      if (!seen.add(k)) continue;
      var t = blue.get(k);
      if (t != null) t.events().forEach(e -> out.add(e.name()));
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
    var body = build(steps, new ArrayList<>(List.of(name)));
    if (config.resetPoseAtAutoStart) {
      var first = firstPath(steps, new HashSet<>());
      var traj = first == null ? null : blue.get(first);
      if (traj != null && traj.start() == AresTrajectory.Start.KNOWN) {
        body = Commands.runOnce(() -> drive.resetPose(orient(traj, config.flip.getAsBoolean()).initial().pose()))
            .andThen(body);
      }
    }
    return body.withName(name);
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
    var chooser = new SendableChooser<Command>();
    chooser.setDefaultOption("None", Commands.none());
    for (var name : autoNames()) chooser.addOption(name, auto(name));
    return chooser;
  }

  // The first path an auto drives, when it is the first thing that moves the
  // robot for certain (an if before it makes it a guess).
  private String firstPath(List<Step> steps, Set<String> seen) {
    for (var s : steps) {
      if (s instanceof Step.Path p) return p.variant() == null ? p.path() : p.path() + "@" + p.variant();
      if (s instanceof Step.If) return null;
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

  private Command build(List<Step> steps, List<String> stack) {
    var out = new ArrayList<Command>();
    for (int i = 0; i < steps.size(); i++) {
      var s = steps.get(i);
      if (s instanceof Step.Command c && c.alongside()) {
        // It runs with everything after it, and stops when that is done.
        out.add(Commands.deadline(build(steps.subList(i + 1, steps.size()), stack), command(c.name())));
        break;
      }
      var next = i + 1 < steps.size() ? steps.get(i + 1) : null;
      out.add(step(s, next, stack));
    }
    if (out.isEmpty()) return Commands.none();
    return out.size() == 1 ? out.get(0) : Commands.sequence(out.toArray(Command[]::new));
  }

  private Command step(Step s, Step next, List<String> stack) {
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
      var then = build(f.then(), stack);
      var otherwise = build(f.otherwise(), stack);
      return Commands.either(then, otherwise, () -> condition(f.condition()));
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
      return build(inner.get().steps(), deeper);
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
