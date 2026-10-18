package com.stzteam.features.ares;

import com.stzteam.features.ares.trajectory.AresTrajectory;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.event.EventLoop;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * An auto written in code with triggers, as Choreo's AutoRoutine: instead of
 * a list of steps, its paths say when they are running, when they end, when
 * they reach a time, a marker or a pose, and commands are bound to that.
 *
 * <p>The triggers are polled by {@link #cmd()}, the routine's command, only
 * while it runs: put that in the auto chooser. Bind with {@code onTrue} (it
 * happens) or {@code whileTrue} (while it lasts).
 */
public final class AresRoutine {
  private final Ares ares;
  private final String name;
  private final EventLoop loop = new EventLoop();
  private final List<Path> paths = new ArrayList<>();
  private boolean running;

  AresRoutine(Ares ares, String name) {
    this.ares = ares;
    this.name = name;
  }

  /** A path of this routine. Each call is a handle of its own, with its own triggers. */
  public Path path(String path) {
    var p = new Path(path);
    paths.add(p);
    return p;
  }

  /** True while the routine runs: {@code active().onTrue(...)} is how it starts. */
  public Trigger active() {
    return new Trigger(loop, () -> running);
  }

  /** A condition of the robot's, polled with the routine's triggers. */
  public Trigger observe(BooleanSupplier condition) {
    return new Trigger(loop, () -> running && condition.getAsBoolean());
  }

  /** The routine: it polls its triggers until the auto ends (or it is interrupted). */
  public Command cmd() {
    return cmd(() -> false);
  }

  /** The same, ending when {@code finished} is true. */
  public Command cmd(BooleanSupplier finished) {
    return Commands.runEnd(() -> {
          running = true;
          loop.poll();
          // A path's "done" lasts one poll.
          for (var p : paths) p.justDone = false;
        }, () -> {
          running = false;
          loop.poll();
          for (var p : paths) p.reset();
        })
        .beforeStarting(() -> paths.forEach(Path::reset))
        .until(finished)
        .withName(name);
  }

  /** A path of the routine, and what it says about itself. */
  public final class Path {
    private final String key;
    private final Timer timer = new Timer();
    private boolean active;
    private boolean justDone;

    private Path(String key) {
      this.key = key;
    }

    private void reset() {
      active = false;
      justDone = false;
      timer.stop();
      timer.reset();
    }

    /** The command that drives it. */
    public Command cmd() {
      return ares.path(key)
          .beforeStarting(() -> {
            active = true;
            justDone = false;
            timer.restart();
          })
          .finallyDo(interrupted -> {
            active = false;
            timer.stop();
            justDone = !interrupted;
          })
          .withName(name + ": " + key);
    }

    /** Sets the robot's pose to where the path starts (flipped on red), as an auto does by default. */
    public Command resetOdometry() {
      return Commands.runOnce(() -> ares.drive().resetPose(trajectory().initial().pose()));
    }

    /** True while the path is being driven. */
    public Trigger active() {
      return new Trigger(loop, () -> active);
    }

    /** True once, when the path ends having been driven to the end (not when it is cut short). */
    public Trigger done() {
      return new Trigger(loop, () -> justDone);
    }

    /** True from {@code seconds} into the path until it ends. */
    public Trigger atTime(double seconds) {
      return new Trigger(loop, () -> active && timer.get() >= seconds);
    }

    /**
     * True from the path's event marker {@code marker} until the path ends
     * (or while a zone marker lasts, its zone).
     */
    public Trigger atTime(String marker) {
      var events = ares.trajectory(key).events().stream().filter(e -> e.name().equals(marker)).toList();
      if (events.isEmpty()) {
        ares.warnMissing("path \"" + key + "\" has no marker \"" + marker + "\"");
        return new Trigger(loop, () -> false);
      }
      var e = events.get(0);
      return new Trigger(loop, () -> active && timer.get() >= e.t() && (!e.isZone() || timer.get() < e.endT()));
    }

    /**
     * True while the robot is within {@code toleranceM} of {@code pose}
     * (blue's coordinates, flipped on red) during the path.
     */
    public Trigger atPose(Pose2d pose, double toleranceM) {
      return new Trigger(loop, () -> {
        if (!active) return false;
        var p = ares.config().flip.getAsBoolean()
            ? ares.config().symmetry.flip(pose, ares.config().fieldLengthM, ares.config().fieldWidthM)
            : pose;
        return ares.drive().pose().getTranslation().getDistance(p.getTranslation()) <= toleranceM;
      });
    }

    /** The trajectory, on the alliance the robot is on now. */
    public AresTrajectory trajectory() {
      return ares.orient(ares.trajectory(key), ares.config().flip.getAsBoolean());
    }
  }
}
