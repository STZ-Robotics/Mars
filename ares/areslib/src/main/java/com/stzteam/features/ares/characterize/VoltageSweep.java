package com.stzteam.features.ares.characterize;

import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.Command;
import java.util.ArrayList;
import java.util.List;
import java.util.function.DoubleConsumer;
import java.util.function.DoubleSupplier;

/**
 * Steps a voltage up, both ways, waits for the speed to settle at each step
 * and averages it: then |V| = kS + kV·|speed| by least squares. No logs, no
 * SysId app: the numbers come out of the robot, published as it goes.
 *
 * <p>The method of the team's DriveCharacterizationCommand, generalized:
 * the drive spins the robot in place (no room needed, and the wheels roll on
 * the carpet with the robot's weight on them, so kS includes that friction);
 * the steer turns the modules with the robot standing still.
 */
public class VoltageSweep extends Command {
  /** One settled step: the voltage and the mean |speed| (and anything else sampled). */
  public record Point(double volts, double speed, double extra) {}

  private final String name;
  private final double[] steps;
  private final double settleS;
  private final double sampleS;
  private final double maxSpeed;
  private final DoubleConsumer apply;
  private final DoubleSupplier speed;
  private final DoubleSupplier extra;
  private final Runnable stop;
  private final Timer timer = new Timer();
  private final List<Point> points = new ArrayList<>();
  private int step;
  private double sum;
  private double sumExtra;
  private int n;
  private String failure;
  private Fit fit;

  /**
   * @param steps the voltages, positive: each runs one way and then the other
   * @param maxSpeed above this |speed| the sweep stops (a safety cut)
   * @param extra sampled with the speed (the gyro rate, for the drive); may be null
   */
  public VoltageSweep(String name, double[] steps, double settleS, double sampleS, double maxSpeed,
      DoubleConsumer apply, DoubleSupplier speed, DoubleSupplier extra, Runnable stop, edu.wpi.first.wpilibj2.command.Subsystem requirement) {
    this.name = name;
    this.steps = new double[steps.length * 2];
    for (int i = 0; i < steps.length; i++) {
      this.steps[i] = steps[i];
      this.steps[steps.length + i] = -steps[i];
    }
    this.settleS = settleS;
    this.sampleS = sampleS;
    this.maxSpeed = maxSpeed;
    this.apply = apply;
    this.speed = speed;
    this.extra = extra;
    this.stop = stop;
    addRequirements(requirement);
    setName("Characterize " + name);
  }

  @Override
  public void initialize() {
    step = 0;
    sum = 0;
    sumExtra = 0;
    n = 0;
    failure = null;
    fit = null;
    points.clear();
    timer.restart();
    CharacterizationTelemetry.start(name, "running", steps.length);
  }

  @Override
  public void execute() {
    double v = Math.abs(speed.getAsDouble());
    if (v > maxSpeed) {
      failure = String.format("stopped: %.1f past the %.0f limit", v, maxSpeed);
      return;
    }
    apply.accept(steps[step]);
    double t = timer.get();
    if (t > settleS) {
      sum += v;
      sumExtra += extra == null ? 0 : Math.abs(extra.getAsDouble());
      n++;
    }
    if (t > settleS + sampleS && n > 0) {
      points.add(new Point(steps[step], sum / n, sumExtra / n));
      CharacterizationTelemetry.points(name, points, step + 1, steps.length);
      sum = 0;
      sumExtra = 0;
      n = 0;
      step++;
      timer.restart();
    }
  }

  @Override
  public boolean isFinished() {
    return failure != null || step >= steps.length;
  }

  @Override
  public void end(boolean interrupted) {
    stop.run();
    if (failure != null || interrupted) {
      CharacterizationTelemetry.state(name, failure != null ? failure : "stopped");
      return;
    }
    // Only the steps where it actually moved: below kS it does not.
    var moved = points.stream().filter(p -> p.speed() > 0.0125 * maxSpeed).toList();
    if (moved.size() < 3) {
      CharacterizationTelemetry.state(name, "failed: it moved on fewer than 3 steps (raise the voltages)");
      return;
    }
    fit = Fit.of(moved.stream().mapToDouble(Point::speed).toArray(), moved.stream().mapToDouble(p -> Math.abs(p.volts())).toArray());
    CharacterizationTelemetry.result(name, "kS", fit.intercept());
    CharacterizationTelemetry.result(name, "kV", fit.slope());
    CharacterizationTelemetry.result(name, "R2", fit.r2());
    finish(moved);
    CharacterizationTelemetry.state(name, fit.r2() > 0.99 ? "done" : "done, but R² is low: check the carpet and the battery");
  }

  /** For a subclass to add what else the points say. */
  protected void finish(List<Point> moved) {}

  /** The last fit (null until a sweep has finished). */
  public Fit fit() {
    return fit;
  }

  public List<Point> points() {
    return List.copyOf(points);
  }
}
