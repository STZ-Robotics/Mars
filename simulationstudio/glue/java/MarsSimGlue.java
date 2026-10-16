// Copy to src/main/java/frc/robot/modules/swerve/MarsSimGlue.java
//
// What it is
// ==========
// It swaps the swerve's simulation engine. CTRE simulates the modules with
// kinematics: it integrates the pose from the velocities the code asks for.
// There is no friction, no mass, no collisions --- the robot goes through walls.
//
// This class replaces that simulation with Gazebo's. The robot now has mass,
// the wheels slip, and if it hits something it stops.
//
// What does NOT change
// ====================
// NONE of your swerve logic. TunerConstants, SwerveRequestFactory,
// DriverBindings, the Slot0Configs gains: all the same. There is no second
// swerve implementation anywhere. The only thing that changes is where the
// encoder values come from.
//
// And if the Studio is not running, this class steps aside on its own and lets
// CTRE simulate as always. Working without the simulation requires touching
// nothing.
//
// Lockstep
// ========
// With the environment variable MARS_LOCKSTEP=127.0.0.1:5811 (and the bridge with
// --lockstep-port 5811 on a world with real_time_factor 0) the robot stops
// running in real time: WPILib's time is paused and advances one physics step at
// a time. Every run comes out the same (±0.6% measured, against ±10% in real
// time) and it runs at ~1.1x real time. MARS_LOCKSTEP_SETTLE_MS (2.5 by default)
// trades speed for fidelity: 1.0 runs at ~2x with a ~10% bias.
//
// It uses ForgeMini's NetworkIO for all NT traffic, not the raw API: it is the
// project's convention and it is already proven there.

package frc.robot.modules.swerve;

import static edu.wpi.first.units.Units.Degrees;
import static edu.wpi.first.units.Units.Rotations;
import static edu.wpi.first.units.Units.RotationsPerSecond;

import com.ctre.phoenix6.Utils;
import com.ctre.phoenix6.hardware.CANcoder;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.sim.ChassisReference;
import com.ctre.phoenix6.swerve.SwerveDrivetrain;
import com.stzteam.forgemini.io.NetworkIO;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StructPublisher;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import frc.robot.configuration.constants.TunerConstants;

public final class MarsSimGlue {
  /** The contract's tables. See sim/protocol/topics.toml, section [[glue]]. */
  private static final String OUTPUT = "MARS/Glue/out";
  private static final String INPUT = "MARS/Glue/in";
  /** The glue's own diagnostics: says whether this class is alive and whether its thread runs. */
  private static final String DIAG = "MARS/Glue/diag";

  private static final double TWO_PI = 2.0 * Math.PI;

  /** The order HAS to be the robot-map's, and createDrivetrain()'s. */
  private static final String[] MODULES = {"fl", "fr", "bl", "br"};

  /**
   * Cycles without a new heartbeat before declaring the simulation absent. At
   * 250 Hz that is 0.4 s: enough not to flicker with a late message, little
   * enough that opening the Studio mid-session shows right away.
   */
  private static final int CYCLES_UNTIL_DEAD = 100;

  private final SwerveDrivetrain<TalonFX, TalonFX, CANcoder> drivetrain;
  private final double steerReduction;
  private final double coupling;

  private double lastInstant = Utils.getCurrentTimeSeconds();
  private double lastHeartbeat = -1.0;
  private int cyclesWithoutHeartbeat = Integer.MAX_VALUE;
  private boolean isConnected = false;
  private boolean crashed = false;
  private long ticks = 0;

  private final double[] commands = new double[8];
  private final boolean[] hasTarget = new boolean[4];

  // --- lockstep -------------------------------------------------------------
  /**
   * With MARS_LOCKSTEP=host:port the robot stops running in real time: WPILib's
   * time is paused and this glue advances it step by step, asking the physics
   * (mars-bridge --lockstep-port) for exactly one 4 ms step each time. Every
   * run comes out the same and a slow PC runs slower instead of degrading the
   * physics.
   *
   * <p>What can NOT be paused is the TalonFX's simulated firmware: Phoenix
   * runs on the wall clock (measured: it takes 1.5 ms median and 2.2 ms at
   * most to react to a sensor change). That is why each step waits
   * MARS_LOCKSTEP_SETTLE_MS (2.5 by default) of wall time before reading the
   * voltages. It is what limits the speed to ~1-1.5x real time.
   */
  private static final String LOCKSTEP = System.getenv("MARS_LOCKSTEP");
  private static final double STEP_S = 0.004;
  private static final int MAGIC = 0x4D4C5331; // "MLS1", ver bridge/src/lockstep.rs
  private volatile boolean lockstepActive = false;
  private StructPublisher<Pose2d> truth;

  public MarsSimGlue(SwerveDrivetrain<TalonFX, TalonFX, CANcoder> drivetrain) {
    this.drivetrain = drivetrain;

    // They are read from TunerConstants instead of being written again: if
    // someone changes the reduction there, this follows without anyone
    // remembering.
    this.steerReduction = TunerConstants.FrontLeft.SteerMotorGearRatio;
    this.coupling = TunerConstants.FrontLeft.CouplingGearRatio;

    configureSimState();

    // Two signs of life --- console and NetworkTables --- because the console is
    // not always being watched. If `MARS/Glue/diag/created` does not show up in
    // the NT tree, this class never got built, and then the problem is in the
    // `if` that decides to create it and not in here.
    System.out.println("[MARS] glue created, publishing to /" + OUTPUT + "/");
    NetworkIO.set(DIAG, "created", true);
    NetworkIO.set(DIAG, "steerReduction", steerReduction);
    NetworkIO.set(DIAG, "coupling", coupling);

    if (LOCKSTEP != null && !LOCKSTEP.isBlank()) {
      startLockstep(LOCKSTEP.trim());
    }
  }

  /**
   * Each motor's orientation and each CANcoder's offset, the way CTRE's
   * SimSwerveDrivetrain does it. Without this the positions written are read
   * as RAW: the CANcoder reports raw + the magnet offset (the FL module came
   * out at -135.7° while at 0°) and the inverted motors see their direction
   * reversed.
   *
   * <p>In real time this stayed hidden by chance: the glue started with CTRE's
   * sim while Gazebo did not answer, and updateSimState() left these fields
   * set (getSimState() always returns the same instance). In lockstep Gazebo
   * answers from the first step and it never happened.
   */
  private void configureSimState() {
    var moduleConstants =
        new com.ctre.phoenix6.swerve.SwerveModuleConstants<?, ?, ?>[] {
          TunerConstants.FrontLeft, TunerConstants.FrontRight,
          TunerConstants.BackLeft, TunerConstants.BackRight
        };
    for (int i = 0; i < 4; i++) {
      var c = moduleConstants[i];
      var module = drivetrain.getModule(i);
      module.getDriveMotor().getSimState().Orientation =
          c.DriveMotorInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
      module.getSteerMotor().getSimState().Orientation =
          c.SteerMotorInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
      var encoder = module.getEncoder().getSimState();
      encoder.Orientation =
          c.EncoderInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
      encoder.SensorOffset = c.EncoderOffset;
    }
  }

  /** Whether MARS's physics is feeding the robot right now. */
  public boolean isConnected() {
    return isConnected;
  }

  /**
   * Replaces {@code updateSimState}. Call from the drivetrain's simulation
   * thread, at the same rate that one was called.
   */
  public void update() {
    // In lockstep the lockstep thread is the one moving the physics, not this
    // Notifier (which anyway only fires when that thread advances WPILib's
    // time).
    if (lockstepActive) {
      return;
    }
    // A Notifier whose callback throws dies WITHOUT SAYING ANYTHING: the robot
    // stands still and there is not a single line on the console. Catching and
    // warning once turns that silent failure into one that can be read.
    try {
      refresh();
    } catch (Throwable e) {
      if (!crashed) {
        crashed = true;
        System.err.println("[MARS] the glue failed and shuts down: " + e);
        e.printStackTrace();
        NetworkIO.set(DIAG, "error", e.toString());
      }
    }
  }

  private void refresh() {
    final double now = Utils.getCurrentTimeSeconds();
    final double dt = now - lastInstant;
    lastInstant = now;

    // The thread's life counter. If `MARS/Glue/diag/ticks` does not go up in the
    // NT tree, this thread is not running --- which is a different problem from
    // the simulation not answering, and is fixed somewhere else.
    NetworkIO.set(DIAG, "ticks", (double) (++ticks));

    final double bus = RobotController.getBatteryVoltage();
    NetworkIO.set(OUTPUT, "enabled", DriverStation.isEnabled());

    // Publish ALWAYS, even disconnected: it is what makes starting MARS Sim in
    // the middle of a session work without restarting the robot.
    publishCommands(bus);

    if (!hasData()) {
      // Without a simulation, CTRE's. Working without opening the Studio stays
      // exactly as it was before installing any of this.
      if (isConnected) {
        isConnected = false;
        System.out.println("[MARS] simulation absent; going back to CTRE's");
        NetworkIO.set(DIAG, "connected", false);
      }
      drivetrain.updateSimState(dt, bus);
      return;
    }

    if (!isConnected) {
      isConnected = true;
      System.out.println("[MARS] simulation connected; the physics is in charge");
      NetworkIO.set(DIAG, "connected", true);
    }
    injectPhysics(bus);
  }

  /** What the robot code is asking of each motor, published over NT4. */
  private void publishCommands(double bus) {
    readCommands(bus, commands);
    for (int i = 0; i < 4; i++) {
      NetworkIO.set(OUTPUT, MODULES[i] + "_drive/duty", commands[2 * i]);
      if (hasTarget[i]) {
        NetworkIO.set(OUTPUT, MODULES[i] + "_steer/setpoint", commands[2 * i + 1]);
      }
    }
  }

  /**
   * Reads what the robot code asks of each motor, in the robot-map's order:
   * drive duty and steer setpoint in MOTOR rad. A module with no target yet
   * keeps its previous setpoint.
   */
  private void readCommands(double bus, double[] values) {
    var state = drivetrain.getState();

    for (int i = 0; i < 4; i++) {
      var module = drivetrain.getModule(i);
      var drive = module.getDriveMotor().getSimState();
      var steer = module.getSteerMotor().getSimState();

      // Phoenix needs to know the bus voltage before it can say what it is
      // applying. Without this getMotorVoltage() returns zero and the robot does
      // not move, with no error anywhere.
      drive.setSupplyVoltage(bus);
      steer.setSupplyVoltage(bus);

      values[2 * i] = drive.getMotorVoltage() / bus;

      // The module's target angle, which is what your swerve already computed ---
      // and already optimized, i.e. it never asks to turn more than 90 degrees.
      hasTarget[i] = state.ModuleTargets != null && state.ModuleTargets.length > i;
      if (hasTarget[i]) {
        double moduleRotations = state.ModuleTargets[i].angle.getRotations();
        values[2 * i + 1] = moduleRotations * TWO_PI * steerReduction;
      }
    }
  }

  /** What the physics returned over NT4 (real-time mode), put into the robot's sensors. */
  private void injectPhysics(double bus) {
    double[] pos = new double[8];
    double[] vel = new double[8];
    for (int i = 0; i < 4; i++) {
      pos[2 * i] = NetworkIO.get(INPUT, MODULES[i] + "_drive/position", 0.0);
      vel[2 * i] = NetworkIO.get(INPUT, MODULES[i] + "_drive/velocity", 0.0);
      pos[2 * i + 1] = NetworkIO.get(INPUT, MODULES[i] + "_steer/position", 0.0);
      vel[2 * i + 1] = NetworkIO.get(INPUT, MODULES[i] + "_steer/velocity", 0.0);
    }
    inject(pos, vel, NetworkIO.get(INPUT, "gyro/yaw", 0.0), bus);
  }

  /**
   * Puts the physics' state into Phoenix's simulated sensors. Both modes use
   * it: real time (over NT4) and lockstep (over TCP).
   *
   * @param pos position in MOTOR rad, in the robot-map's order: fl_drive,
   *     fl_steer, fr_drive, fr_steer, bl_drive, bl_steer, br_drive, br_steer
   * @param vel the same in rad/s
   * @param yawDegrees the chassis' true yaw, in degrees
   */
  private void inject(double[] pos, double[] vel, double yawDegrees, double bus) {
    for (int i = 0; i < 4; i++) {
      var module = drivetrain.getModule(i);
      var drive = module.getDriveMotor().getSimState();
      var steer = module.getSteerMotor().getSimState();
      var encoder = module.getEncoder().getSimState();
      encoder.setSupplyVoltage(bus);

      // The contract delivers radians and rad/s of the MOTOR's axis; Phoenix wants
      // rotations and rotations per second of the ROTOR, which is the same axis.
      double steerRotations = pos[2 * i + 1] / TWO_PI;
      double steerRps = vel[2 * i + 1] / TWO_PI;
      double moduleRotations = steerRotations / steerReduction;
      double moduleRps = steerRps / steerReduction;

      steer.setRawRotorPosition(Rotations.of(steerRotations));
      steer.setRotorVelocity(RotationsPerSecond.of(steerRps));

      // The CANcoder measures the MODULE, not the rotor: the reduction has to be
      // undone. And it has to be fed even if it seems redundant, because the steer
      // uses FusedCANcoder: if the CANcoder does not move, the control thinks the
      // module is stuck and saturates.
      encoder.setRawPosition(Rotations.of(moduleRotations));
      encoder.setVelocity(RotationsPerSecond.of(moduleRps));

      // COUPLING. On an MK4, turning the azimuth drags the drive motor along:
      // kCoupleRatio motor rotations per module rotation. Gazebo does not model it
      // --- its two joints are independent --- so it is added here, which is where
      // it is converted to rotor units.
      //
      // Without this the drive encoder would not move when turning the modules, and
      // the simulated robot's odometry would be CLEANER than the real one's right in
      // the maneuver where it behaves worst.
      double driveRotations = pos[2 * i] / TWO_PI + moduleRotations * coupling;
      double driveRps = vel[2 * i] / TWO_PI + moduleRps * coupling;

      drive.setRawRotorPosition(Rotations.of(driveRotations));
      drive.setRotorVelocity(RotationsPerSecond.of(driveRps));
    }

    // The gyro comes from the physics, not from integrating the velocities. That
    // is exactly the difference: if the odometry is wrong, it shows here.
    drivetrain.getPigeon2().getSimState().setRawYaw(Degrees.of(yawDegrees));
  }

  /**
   * Whether the simulation is really publishing.
   *
   * It looks at the HEARTBEAT --- a counter the bridge raises every cycle ---
   * and not at the sensor values: a stopped robot publishes zeros that cannot
   * be told apart from a dead channel, and with that the robot would freeze on
   * startup with nothing explaining it.
   */
  private boolean hasData() {
    double heartbeat = NetworkIO.get(INPUT, "heartbeat", -1.0);
    if (heartbeat != lastHeartbeat) {
      lastHeartbeat = heartbeat;
      cyclesWithoutHeartbeat = 0;
      return true;
    }
    if (cyclesWithoutHeartbeat < CYCLES_UNTIL_DEAD) {
      cyclesWithoutHeartbeat++;
      return true;
    }
    return false;
  }

  // --- lockstep -------------------------------------------------------------

  private void startLockstep(String target) {
    String[] parts = target.split(":");
    String host = parts[0];
    int port = parts.length > 1 ? Integer.parseInt(parts[1]) : 5811;
    double settleMs = 2.5;
    String settle = System.getenv("MARS_LOCKSTEP_SETTLE_MS");
    if (settle != null && !settle.isBlank()) {
      settleMs = Double.parseDouble(settle.trim());
    }

    Socket socket = null;
    long limit = System.nanoTime() + 15_000_000_000L;
    while (socket == null && System.nanoTime() < limit) {
      try {
        socket = new Socket(host, port);
      } catch (IOException e) {
        try {
          Thread.sleep(250);
        } catch (InterruptedException ie) {
          Thread.currentThread().interrupt();
          return;
        }
      }
    }
    if (socket == null) {
      System.err.println(
          "[MARS] lockstep: no bridge at " + target + " (mars-bridge --lockstep-port "
              + port + "); staying in real time");
      NetworkIO.set(DIAG, "lockstep", false);
      return;
    }

    try {
      socket.setTcpNoDelay(true);
    } catch (IOException e) {
      // Not fatal: just more latency per step.
    }
    truth =
        NetworkTableInstance.getDefault()
            .getStructTopic("/MARS/Sim/truthPose", Pose2d.struct)
            .publish();

    lockstepActive = true;
    SimHooks.pauseTiming();
    System.out.println(
        "[MARS] lockstep connected to " + target + "; the physics sets WPILib's time");
    NetworkIO.set(DIAG, "lockstep", true);

    final Socket connection = socket;
    final long settleNs = (long) (settleMs * 1e6);
    Thread thread = new Thread(() -> lockstepLoop(connection, settleNs), "mars-lockstep");
    thread.setDaemon(true);
    thread.start();
  }

  private void lockstepLoop(Socket socket, long settleNs) {
    final int n = 8;
    ByteBuffer request =
        ByteBuffer.allocate(4 + 8 + 1 + 4 + 4 + 8 * n).order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer header = ByteBuffer.allocate(4 + 8 + 8 * 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer body = ByteBuffer.allocate(16 * n).order(ByteOrder.LITTLE_ENDIAN);
    double[] pos = new double[n];
    double[] vel = new double[n];
    long seq = 0;

    try (socket;
        DataOutputStream output =
            new DataOutputStream(new BufferedOutputStream(socket.getOutputStream()));
        DataInputStream input =
            new DataInputStream(new BufferedInputStream(socket.getInputStream()))) {
      while (true) {
        double bus = RobotController.getBatteryVoltage();
        readCommands(bus, commands);

        seq++;
        request.clear();
        request.putInt(MAGIC).putLong(seq);
        request.put((byte) (DriverStation.isEnabled() ? 1 : 0));
        request.putInt(1).putInt(n);
        for (double v : commands) {
          request.putDouble(v);
        }
        output.write(request.array(), 0, request.position());
        output.flush();

        input.readFully(header.array());
        header.rewind();
        if (header.getInt() != MAGIC || header.getLong() != seq) {
          throw new IOException("lockstep response out of order");
        }
        header.getDouble(); // tiempo de simulacion
        double x = header.getDouble();
        double y = header.getDouble();
        double yaw = header.getDouble();
        int received = header.getInt();
        if (received != n) {
          throw new IOException("the bridge sent " + received + " actuators, expected " + n);
        }
        input.readFully(body.array());
        body.rewind();
        for (int i = 0; i < n; i++) {
          pos[i] = body.getDouble();
          vel[i] = body.getDouble();
        }

        inject(pos, vel, Math.toDegrees(yaw), bus);
        truth.set(new Pose2d(x, y, new Rotation2d(yaw)));

        // The robot runs its cycle (every 5 steps) and whatever Notifiers are due.
        SimHooks.stepTiming(STEP_S);

        // The TalonFX's firmware does not pause: give it wall time to react to the
        // new sensors and commands before reading them.
        long until = System.nanoTime() + settleNs;
        while (System.nanoTime() < until) {
          Thread.onSpinWait();
        }

        NetworkIO.set(DIAG, "ticks", (double) (++ticks));
      }
    } catch (Throwable e) {
      // Without lockstep the robot would be left with time frozen forever. Better
      // to go back to real time and say so.
      System.err.println("[MARS] lockstep ended: " + e + "; back to real time");
      NetworkIO.set(DIAG, "error", e.toString());
      lockstepActive = false;
      SimHooks.resumeTiming();
    }
  }
}
