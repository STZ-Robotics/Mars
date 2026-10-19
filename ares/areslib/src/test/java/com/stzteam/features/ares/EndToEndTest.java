package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.ctre.phoenix6.configs.CANcoderConfiguration;
import com.ctre.phoenix6.configs.Slot0Configs;
import com.ctre.phoenix6.configs.TalonFXConfiguration;
import com.ctre.phoenix6.hardware.CANcoder;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.signals.StaticFeedforwardSignValue;
import com.ctre.phoenix6.swerve.SwerveDrivetrain;
import com.ctre.phoenix6.swerve.SwerveDrivetrainConstants;
import com.ctre.phoenix6.swerve.SwerveModuleConstants;
import com.ctre.phoenix6.swerve.SwerveModuleConstants.ClosedLoopOutputType;
import com.ctre.phoenix6.swerve.SwerveModuleConstantsFactory;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.stzteam.features.ares.ctre.CtreSwerve;
import com.stzteam.features.ares.trajectory.AresSample;
import com.stzteam.features.ares.trajectory.AresTrajectory;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.wpilibj.Notifier;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Subsystem;
import java.io.File;
import java.nio.file.Files;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * Ares end to end: the real planner ({@code ares plan}, run by the e2eTest task) plans a path for
 * a robot, and AresLib follows it on a simulated CTRE swerve built from the same .robot.json, with
 * the wheel forces fed forward through {@link CtreSwerve}. Runs in real time, as the CTRE
 * simulation does.
 */
@Tag("e2e")
class EndToEndTest {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final double LOOP_S = 0.02;

  private static File dir;
  private static JsonNode robot;
  private static SimSwerve drivetrain;
  private static SwerveModuleConstants<?, ?, ?> frontLeft;

  private Ares ares;
  private boolean red;
  private double maxErrorM;

  /** A Tuner X swerve that is its own subsystem, simulated at 250 Hz as Tuner X's template does. */
  static final class SimSwerve extends SwerveDrivetrain<TalonFX, TalonFX, CANcoder> implements Subsystem {
    private final Notifier sim;

    SimSwerve(SwerveDrivetrainConstants constants, SwerveModuleConstants<?, ?, ?>... modules) {
      super(TalonFX::new, TalonFX::new, CANcoder::new, constants, modules);
      double[] last = {Timer.getFPGATimestamp()};
      sim = new Notifier(() -> {
        double now = Timer.getFPGATimestamp();
        updateSimState(now - last[0], 12.0);
        last[0] = now;
      });
      sim.startPeriodic(0.004);
    }

    @Override
    public void close() {
      sim.close();
      super.close();
    }
  }

  @BeforeAll
  static void setUp() throws Exception {
    dir = new File(System.getProperty("ares.e2e.dir"));
    robot = JSON.readTree(new File(System.getProperty("ares.e2e.robot")));
    assertTrue(new File(dir, "hub-run.traj.json").isFile(), "ares plan did not write the trajectory");
    assertTrue(HAL.initialize(500, 0));
    DriverStationSim.setEnabled(true);
    DriverStationSim.setAutonomous(true);
    DriverStationSim.notifyNewData();
    drivetrain = buildDrivetrain(robot.path("drivetrain"));
  }

  @AfterAll
  static void tearDown() {
    CommandScheduler.getInstance().cancelAll();
    if (drivetrain != null) drivetrain.close();
  }

  @BeforeEach
  void newAres() {
    red = false;
    maxErrorM = 0;
  }

  @AfterEach
  void clear() {
    CommandScheduler.getInstance().cancelAll();
    CommandScheduler.getInstance().getActiveButtonLoop().clear();
  }

  // The drive as the .robot.json has it (ratio, wheel, slip current), the rest as the team's
  // Tuner X constants: what Ares planned for is what the simulated robot is.
  static SimSwerve buildDrivetrain(JsonNode d) {
    var factory = new SwerveModuleConstantsFactory<TalonFXConfiguration, TalonFXConfiguration, CANcoderConfiguration>()
        .withDriveMotorGearRatio(d.path("driveGearRatio").asDouble())
        .withSteerMotorGearRatio(26.09090909090909)
        .withCouplingGearRatio(3.375)
        .withWheelRadius(d.path("wheelRadiusM").asDouble())
        .withSlipCurrent(d.path("driveCurrentLimitA").asDouble())
        .withSpeedAt12Volts(5.85)
        .withSteerMotorGains(new Slot0Configs().withKP(55).withKD(0.35).withKS(0.29).withKV(2.483)
            .withStaticFeedforwardSign(StaticFeedforwardSignValue.UseClosedLoopSign))
        .withDriveMotorGains(new Slot0Configs().withKP(0.2).withKS(0.1295).withKV(0.1156))
        .withSteerMotorClosedLoopOutput(ClosedLoopOutputType.Voltage)
        .withDriveMotorClosedLoopOutput(ClosedLoopOutputType.Voltage)
        .withDriveMotorInitialConfigs(new TalonFXConfiguration())
        .withSteerMotorInitialConfigs(new TalonFXConfiguration())
        .withEncoderInitialConfigs(new CANcoderConfiguration())
        .withSteerInertia(0.01)
        .withDriveInertia(0.01)
        .withSteerFrictionVoltage(0.2)
        .withDriveFrictionVoltage(0.2);
    var modules = d.path("modules");
    var built = new SwerveModuleConstants<?, ?, ?>[modules.size()];
    for (int i = 0; i < modules.size(); i++) {
      var m = modules.get(i);
      boolean right = m.path("yM").asDouble() < 0;
      built[i] = factory.createModuleConstants(
          1 + 3 * i, 2 + 3 * i, 3 + 3 * i, 0.0,
          m.path("xM").asDouble(), m.path("yM").asDouble(), right, false, false);
    }
    frontLeft = built[0];
    return new SimSwerve(new SwerveDrivetrainConstants().withPigeon2Id(40), built);
  }

  /** An Ares project with the planned path and the robot, and optionally a navgrid. */
  static File project(String name, String navgrid) throws Exception {
    var p = new File(dir, name);
    new File(p, "trajectories").mkdirs();
    Files.copy(new File(dir, "hub-run.traj.json").toPath(), new File(p, "trajectories/hub-run.traj.json").toPath(),
        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    var d = robot.path("drivetrain");
    ObjectNode index = JSON.createObjectNode();
    index.put("format", 1);
    var r = index.putObject("robot");
    r.put("name", robot.path("name").asText());
    r.set("modules", d.path("modules"));
    r.set("bumper", robot.path("bumper"));
    var drive = r.putObject("drive");
    drive.put("wheelRadiusM", d.path("wheelRadiusM").asDouble());
    drive.put("driveGearRatio", d.path("driveGearRatio").asDouble());
    drive.put("driveCurrentLimitA", d.path("driveCurrentLimitA").asDouble());
    var path = index.putArray("paths").addObject();
    path.put("name", "hub-run");
    path.put("trajectory", "trajectories/hub-run.traj.json");
    path.put("generated", true);
    path.putArray("variants");
    path.putArray("branches");
    index.putArray("autos");
    JSON.writerWithDefaultPrettyPrinter().writeValue(new File(p, "ares-index.json"), index);
    var grid = new File(p, "navgrid.json");
    if (navgrid != null) Files.writeString(grid.toPath(), navgrid);
    else Files.deleteIfExists(grid.toPath());
    return p;
  }

  Ares ares(File project) {
    return new Ares(CtreSwerve.of(drivetrain).withModuleConstants(frontLeft),
        new Ares.Config().withFolder(project).withFlip(() -> red).withHotReload(false));
  }

  /** Runs the command in real time until it ends; tracks how far the robot is from {@code plan}. */
  double run(Command c, double maxS, AresTrajectory plan) throws InterruptedException {
    CommandScheduler.getInstance().schedule(c);
    double start = Timer.getFPGATimestamp();
    while (CommandScheduler.getInstance().isScheduled(c) && Timer.getFPGATimestamp() - start < maxS) {
      CommandScheduler.getInstance().run();
      if (plan != null) {
        var target = planAt(plan, Timer.getFPGATimestamp() - start);
        maxErrorM = Math.max(maxErrorM, target.getTranslation().getDistance(drivetrain.getState().Pose.getTranslation()));
        if (System.getProperty("ares.e2e.trace") != null) {
          var st = drivetrain.getState();
          System.out.printf("[trace] t=%.2f err=%.3f plan=(%.2f,%.2f) robot=(%.2f,%.2f) vRobot=%.2f%n",
              Timer.getFPGATimestamp() - start, target.getTranslation().getDistance(st.Pose.getTranslation()),
              target.getX(), target.getY(), st.Pose.getX(), st.Pose.getY(),
              Math.hypot(st.Speeds.vxMetersPerSecond, st.Speeds.vyMetersPerSecond));
        }
      }
      Thread.sleep((long) (LOOP_S * 1000));
    }
    return Timer.getFPGATimestamp() - start;
  }

  /** Where the plan is {@code time} after it starts, between its samples (they are tens of ms apart). */
  static Pose2d planAt(AresTrajectory t, double time) {
    var s = t.samples();
    double at = t.startTime() + time;
    for (int i = 1; i < s.size(); i++) {
      if (s.get(i).t() >= at) {
        var a = s.get(i - 1);
        var b = s.get(i);
        double f = b.t() > a.t() ? Math.max(0, (at - a.t()) / (b.t() - a.t())) : 1;
        return a.pose().interpolate(b.pose(), f);
      }
    }
    return s.get(s.size() - 1).pose();
  }

  static double headingErrorDeg(Pose2d a, Pose2d b) {
    return Math.abs(a.getRotation().minus(b.getRotation()).getDegrees());
  }

  void followsThePlan(boolean onRed) throws Exception {
    red = onRed;
    ares = ares(project("follow", null));
    assertTrue(ares.warnings().isEmpty(), "the .robot.json is the drivetrain's: " + ares.warnings());
    var plan = ares.orient(ares.trajectory("hub-run"), red);
    drivetrain.resetPose(plan.initial().pose());
    Thread.sleep(100); // the odometry thread picks the reset up

    double took = run(ares.path("hub-run"), plan.duration() + 3, plan);

    var end = drivetrain.getState().Pose;
    double endErr = end.getTranslation().getDistance(plan.last().pose().getTranslation());
    System.out.printf("[e2e] %s: planned %.2f s, took %.2f s | max tracking error %.1f cm | end %.1f cm, %.1f deg%n",
        red ? "red" : "blue", plan.duration(), took, 100 * maxErrorM, 100 * endErr, headingErrorDeg(end, plan.last().pose()));
    // What AresLib promises: a path that ends at rest ends within its arrival tolerance (beyond it,
    // it drives there). Measured: 4-5 cm at the end, 15-19 cm at worst along the way (the final hook,
    // turning 90 degrees while braking at full grip); the margins are for the real-time loop's jitter.
    assertTrue(endErr <= ares.config().arriveM, "ended " + endErr + " m from the end of the path");
    assertTrue(headingErrorDeg(end, plan.last().pose()) < 5, "heading off at the end");
    assertTrue(maxErrorM < 0.25, "strayed " + maxErrorM + " m from the plan while following it");
    assertTrue(took < plan.duration() + 1.0, "took " + took + " s for a " + plan.duration() + " s path");
  }

  @Test
  void followsThePlannedPathOnBlue() throws Exception {
    followsThePlan(false);
  }

  @Test
  void followsThePlannedPathOnRed() throws Exception {
    followsThePlan(true);
  }

  @Test
  void pathfindsAroundTheNavgridWithoutEnteringIt() throws Exception {
    // A wall at x in [7.8, 8.4) from the floor up to y = 6.3, in 0.3 m cells.
    int cols = 56, rows = 27;
    var g = new boolean[rows][cols];
    for (int r = 0; r < 21; r++) g[r][26] = g[r][27] = true;
    var json = JSON.createObjectNode();
    json.putObject("field_size").put("x", 16.541).put("y", 8.0692);
    json.put("nodeSizeMeters", 0.3);
    var rowsJson = json.putArray("grid");
    for (var row : g) {
      var a = rowsJson.addArray();
      for (boolean b : row) a.add(b);
    }
    ares = ares(project("pathfind", JSON.writeValueAsString(json)));
    var grid = NavGrid.parse(JSON.writeValueAsString(json));

    drivetrain.resetPose(new Pose2d(4, 2, Rotation2d.kZero));
    Thread.sleep(100);
    var goal = new Pose2d(12, 2, Rotation2d.kZero);
    var cmd = ares.pathfindToField(goal);
    CommandScheduler.getInstance().schedule(cmd);
    double start = Timer.getFPGATimestamp();
    boolean entered = false;
    double highest = 0;
    while (CommandScheduler.getInstance().isScheduled(cmd) && Timer.getFPGATimestamp() - start < 15) {
      CommandScheduler.getInstance().run();
      var p = drivetrain.getState().Pose.getTranslation();
      entered |= grid.blocked(p);
      highest = Math.max(highest, p.getY());
      Thread.sleep((long) (LOOP_S * 1000));
    }
    var end = drivetrain.getState().Pose;
    System.out.printf("[e2e] pathfind: %.2f s, highest y %.2f m, end %.1f cm from the goal%n",
        Timer.getFPGATimestamp() - start, highest, 100 * end.getTranslation().getDistance(goal.getTranslation()));
    assertFalse(entered, "the robot's center entered a blocked cell");
    assertTrue(highest > 6.3, "went over the top of the wall");
    assertEquals(12, end.getX(), 0.05);
    assertEquals(2, end.getY(), 0.05);
  }

  @Test
  void aStaleRobotJsonIsCaught() throws Exception {
    // The same project, but the drivetrain says another gear ratio: the alert names it.
    var stale = new CtreSwerve(drivetrain, drivetrain).withModuleConstants(
        new SwerveModuleConstantsFactory<TalonFXConfiguration, TalonFXConfiguration, CANcoderConfiguration>()
            .withDriveMotorGearRatio(6.75)
            .withWheelRadius(robot.path("drivetrain").path("wheelRadiusM").asDouble())
            .withSlipCurrent(robot.path("drivetrain").path("driveCurrentLimitA").asDouble())
            .createModuleConstants(0, 0, 0, 0, 0.3, 0.3, false, false, false));
    var a = new Ares(stale, new Ares.Config().withFolder(project("stale", null)).withHotReload(false));
    var w = String.join("; ", a.warnings());
    assertTrue(w.contains("gear ratio") && w.contains("6.7500 on the robot"), w);
  }
}
