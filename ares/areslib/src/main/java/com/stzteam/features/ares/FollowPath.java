package com.stzteam.features.ares;

import com.stzteam.features.ares.index.AresIndex;
import com.stzteam.features.ares.trajectory.AresSample;
import com.stzteam.features.ares.trajectory.AresTrajectory;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.Command;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.UnaryOperator;

/**
 * Drives one Ares path: samples its trajectory on a clock, feeds the speeds and
 * the wheel forces forward with feedback on top, and along the way
 *
 * <ul>
 *   <li>runs the event markers' commands (a zone's until it ends),
 *   <li>at a waypoint where a branch leaves, takes it if its condition holds,
 *       and carries on along the branch,
 *   <li>on a stretch marked "?" follows Ares's estimate when the robot is where
 *       it expected, and hands over to the pathfinder when it is not.
 * </ul>
 *
 * <p>Built by {@link Ares#path}, {@link Ares#section}, {@link Ares#split} and the
 * autos. On the red alliance it drives the path flipped, decided when it starts.
 */
public final class FollowPath extends Command {
  /** One trajectory being followed; a branch replaces it with another. */
  private static final class Leg {
    final String name;
    final AresTrajectory traj;
    final List<double[]> spans = new ArrayList<>(); // [startT, endT, index]
    final List<AresIndex.Branch> branches = new ArrayList<>();
    final List<Double> branchTimes = new ArrayList<>();
    final double endT;

    Leg(String name, AresTrajectory traj, List<AresIndex.Branch> branches, double endT) {
      this.name = name;
      this.traj = traj;
      this.endT = endT;
      var s = traj.samples();
      for (int i = 0; i < traj.pathfind().size(); i++) {
        var p = traj.pathfind().get(i);
        spans.add(new double[] {s.get(p.startSample()).t(), s.get(Math.min(p.endSample(), s.size() - 1)).t(), i});
      }
      spans.sort((a, b) -> Double.compare(a[0], b[0]));
      for (var b : branches) {
        // Taken from this trajectory's own waypoint times: a variant moves the
        // waypoints, and with them when the branch point comes.
        double t = b.atWaypoint() < traj.waypointTimes().size()
            ? traj.waypointTimes().get(b.atWaypoint()) : b.atTime();
        if (Double.isNaN(t) || b.condition() == null) continue;
        this.branches.add(b);
        branchTimes.add(t);
      }
    }
  }

  private final Ares ares;
  private final String key;
  private final UnaryOperator<AresTrajectory> crop;
  private final int untilWaypoint;
  private final boolean branches;
  private final AresController controller;
  private final Timer timer = new Timer();

  private Leg leg;
  private boolean red;
  private double t;
  private double clockT0;
  private double trajT0;
  private int nextSpan;
  private int nextBranch;
  private int nextEvent;
  private final Map<AresIndex.Step, Command> built = new IdentityHashMap<>();
  private Command inner;
  private double innerEndT;
  private final Map<Command, Double> running = new LinkedHashMap<>(); // command -> when it ends (NaN: by itself)
  private final Set<String> pulse = new HashSet<>();
  private boolean failed;
  private double offSince = Double.NaN;
  private int replans;
  private boolean arrivalChecked;

  FollowPath(Ares ares, String key, UnaryOperator<AresTrajectory> crop, int untilWaypoint, boolean branches) {
    this.ares = ares;
    this.key = key;
    this.crop = crop;
    this.untilWaypoint = untilWaypoint;
    this.branches = branches;
    this.controller = new AresController(ares.config().translation, ares.config().rotation, ares.config().periodS);
    addRequirements(ares.drive().subsystem());
    // The event commands run inside this one, so it holds what they need,
    // along this path and any branch it may take.
    for (var e : ares.eventsReachable(key, branches)) {
      var c = ares.eventCommand(e);
      if (c == null) continue;
      // A marker's own command is built once, here, and run every time.
      if (e.command() != null) built.put(e.command(), c);
      addRequirements(c.getRequirements());
    }
    setName("Ares: " + key);
  }

  @Override
  public void initialize() {
    running.clear();
    pulse.clear();
    inner = null;
    replans = 0;
    arrivalChecked = false;
    red = ares.config().flip.getAsBoolean();
    var blue = ares.trajectory(key);
    failed = blue == null;
    if (failed) {
      DriverStation.reportError("Ares: \"" + key + "\" has no trajectory. Generate it in Ares and deploy again.", false);
      return;
    }
    var traj = ares.orient(crop.apply(blue), red);
    double end = traj.endTime();
    if (untilWaypoint >= 0 && untilWaypoint < traj.waypointTimes().size()) end = traj.waypointTimes().get(untilWaypoint);
    start(new Leg(key, traj, branches ? ares.branches(key) : List.of(), end));
    timer.restart();
    clockT0 = 0;
  }

  private void start(Leg next) {
    leg = next;
    offSince = Double.NaN;
    t = leg.traj.startTime();
    trajT0 = t;
    clockT0 = timer.get();
    nextSpan = 0;
    nextBranch = 0;
    nextEvent = 0;
    while (nextEvent < leg.traj.events().size() && leg.traj.events().get(nextEvent).t() < t) nextEvent++;
    controller.reset();
    AresTelemetry.path(leg.name, leg.traj.poses());
  }

  @Override
  public void execute() {
    if (failed) return;
    for (var name : pulse) ares.activeEvents().remove(name);
    pulse.clear();

    if (inner != null) {
      inner.execute();
      if (!inner.isFinished()) {
        events();
        return;
      }
      inner.end(false);
      inner = null;
      t = innerEndT;
      trajT0 = t;
      clockT0 = timer.get();
      AresTelemetry.path(leg.name, leg.traj.poses());
    }

    t = Math.min(trajT0 + timer.get() - clockT0, leg.endT);

    // Arrival: a path that ends at rest, ending off its last pose (a shove
    // late in it, a stall), drives there before it is done. Once.
    if (t >= leg.endT && !arrivalChecked && nextSpan >= leg.spans.size()) {
      arrivalChecked = true;
      var last = leg.traj.sample(leg.endT);
      var cfg = ares.config();
      double off = ares.drive().pose().getTranslation().getDistance(last.pose().getTranslation());
      if (cfg.arriveM > 0 && Math.hypot(last.vx(), last.vy()) < 0.05 && off > cfg.arriveM) {
        inner = ares.pathfinder().toPose(last.pose(), new edu.wpi.first.math.kinematics.ChassisSpeeds(), cfg.pathfindConstraints);
        innerEndT = leg.endT;
        replans++;
        AresTelemetry.replanned(replans, off);
        inner.initialize();
        inner.execute();
        return;
      }
    }

    // A stretch the robot finds its own way through.
    if (nextSpan < leg.spans.size() && t >= leg.spans.get(nextSpan)[0]) {
      var at = leg.spans.get(nextSpan++);
      var span = leg.traj.pathfind().get((int) at[2]);
      var expected = leg.traj.sample(at[0]);
      double off = ares.drive().pose().getTranslation().getDistance(expected.pose().getTranslation());
      if (span.fromUnknown() || off > ares.config().estimateToleranceM) {
        var end = leg.traj.sample(at[1]);
        var c = ares.config().pathfindConstraints;
        var limits = new AresPathfinder.Constraints(
            Double.isNaN(span.maxVelocityMps()) ? c.maxVelocityMps() : span.maxVelocityMps(),
            c.maxAccelerationMps2(),
            Double.isNaN(span.maxAngularVelocityRadps()) ? c.maxAngularVelocityRadps() : span.maxAngularVelocityRadps(),
            c.maxAngularAccelerationRadps2());
        inner = ares.pathfinder().toPose(span.goal(), end.fieldSpeeds(), limits);
        innerEndT = Math.min(at[1], leg.endT);
        t = at[0];
        events();
        inner.initialize();
        inner.execute();
        return;
      }
    }

    // A branch point: take it, or let it go by.
    while (nextBranch < leg.branches.size() && t >= leg.branchTimes.get(nextBranch)) {
      var b = leg.branches.get(nextBranch++);
      if (!ares.condition(b.condition())) continue;
      var child = ares.trajectory(b.path());
      if (child == null) {
        DriverStation.reportError("Ares: branch \"" + b.path() + "\" has no trajectory; staying on " + leg.name, false);
        continue;
      }
      events(); // what the parent had up to here
      endZones();
      var traj = ares.orient(child, red);
      start(new Leg(b.path(), traj, ares.branches(b.path()), traj.endTime()));
      t = leg.traj.startTime();
      break;
    }

    events();
    var target = leg.traj.sample(t);
    var pose = ares.drive().pose();

    // Knocked well off the trajectory (a hit, a stall, a wheel off the
    // carpet): feedback alone would chase it at full error. Find the way back
    // to where the trajectory will be a moment from now, and pick it up there.
    var cfg = ares.config();
    double off = pose.getTranslation().getDistance(target.pose().getTranslation());
    if (cfg.replanToleranceM > 0 && off > cfg.replanToleranceM && replans < cfg.maxReplans) {
      if (Double.isNaN(offSince)) offSince = timer.get();
      if (timer.get() - offSince >= cfg.replanDelayS) {
        double rejoin = Math.min(t + cfg.rejoinAheadS, leg.endT);
        // Never past what must happen on the trajectory itself: a "?"
        // stretch, or a branch point.
        if (nextSpan < leg.spans.size()) rejoin = Math.min(rejoin, leg.spans.get(nextSpan)[0]);
        if (nextBranch < leg.branchTimes.size()) rejoin = Math.min(rejoin, leg.branchTimes.get(nextBranch));
        if (rejoin > t + 0.1) {
          var to = leg.traj.sample(rejoin);
          inner = ares.pathfinder().toPose(to.pose(), to.fieldSpeeds(), cfg.pathfindConstraints);
          innerEndT = rejoin;
          replans++;
          offSince = Double.NaN;
          AresTelemetry.replanned(replans, off);
          inner.initialize();
          inner.execute();
          return;
        }
      }
    } else {
      offSince = Double.NaN;
    }
    var speeds = controller.calculate(pose, target);
    ares.drive().drive(ares.forDrive(AresSetpoint.of(target, speeds, pose.getRotation())));
    AresTelemetry.speeds(speeds, edu.wpi.first.math.kinematics.ChassisSpeeds.fromRobotRelativeSpeeds(ares.drive().robotSpeeds(), pose.getRotation()));
    AresTelemetry.target(target.pose(), pose, controller.errorM());
  }

  // Starts the events the clock has reached and runs the ones going.
  private void events() {
    var list = leg.traj.events();
    while (nextEvent < list.size() && t >= list.get(nextEvent).t()) {
      var e = list.get(nextEvent++);
      ares.activeEvents().add(e.name());
      if (!e.isZone()) pulse.add(e.name());
      var c = e.command() != null ? built.get(e.command()) : ares.eventCommand(e.name());
      if (c == null) continue;
      // Whatever it shares a subsystem with gives way, as when scheduling.
      for (var other : new ArrayList<>(running.keySet())) {
        if (other == c || !Collections.disjoint(other.getRequirements(), c.getRequirements())) {
          other.end(true);
          running.remove(other);
        }
      }
      c.initialize();
      running.put(c, e.isZone() ? e.endT() : Double.NaN);
    }
    for (var e : list) {
      if (e.isZone() && t >= e.endT() && !pulse.contains(e.name())) ares.activeEvents().remove(e.name());
    }
    var it = running.entrySet().iterator();
    while (it.hasNext()) {
      var entry = it.next();
      var c = entry.getKey();
      double until = entry.getValue();
      if (!Double.isNaN(until) && t >= until) {
        c.end(true);
        it.remove();
        continue;
      }
      c.execute();
      if (c.isFinished()) {
        c.end(false);
        it.remove();
      }
    }
    AresTelemetry.time(t, ares.activeEvents());
  }

  // Zones belong to the trajectory they were drawn on: leaving it ends them.
  private void endZones() {
    var it = running.entrySet().iterator();
    while (it.hasNext()) {
      var entry = it.next();
      if (!Double.isNaN(entry.getValue())) {
        entry.getKey().end(true);
        it.remove();
      }
    }
    for (var e : leg.traj.events()) if (e.isZone()) ares.activeEvents().remove(e.name());
  }

  @Override
  public boolean isFinished() {
    return failed || inner == null && t >= leg.endT && nextSpan >= leg.spans.size() && arrivalChecked;
  }

  @Override
  public void end(boolean interrupted) {
    timer.stop();
    if (inner != null) {
      inner.end(true);
      inner = null;
    }
    for (var c : running.keySet()) c.end(true);
    running.clear();
    if (leg != null) {
      for (var e : leg.traj.events()) ares.activeEvents().remove(e.name());
    }
    pulse.clear();
    AresTelemetry.idle();
    if (failed) return;
    // A path that ends moving hands its speed to whatever comes next; one
    // that ends at rest, or is cut short, stops.
    AresSample last = leg.traj.sample(leg.endT);
    if (interrupted || Math.hypot(last.vx(), last.vy()) < 0.1 && Math.abs(last.omega()) < 0.1) {
      ares.drive().stop();
    }
  }

  /** How many times it found its way back to the trajectory since it started. */
  public int replans() {
    return replans;
  }

  /** The trajectory this command is driving now (flipped if it is), or null before it starts. */
  public AresTrajectory current() {
    return leg == null ? null : leg.traj;
  }

  /** Where the robot will start, for the alliance it is on now. */
  public Pose2d startPose() {
    var blue = ares.trajectory(key);
    return blue == null ? null : ares.orient(crop.apply(blue), ares.config().flip.getAsBoolean()).initial().pose();
  }
}
