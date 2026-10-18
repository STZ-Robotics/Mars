package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stzteam.features.ares.characterize.AresCharacterizable;
import com.stzteam.features.ares.characterize.AresCharacterization;
import com.stzteam.features.ares.characterize.Fit;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Subsystem;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The routines on a swerve whose kS, kV and wheel radius are known. */
class CharacterizationTest {
  /**
   * Motors with a static friction and a back-EMF, a first-order response,
   * and wheels a little smaller than the code believes.
   */
  static final class FakeSwerve implements AresCharacterizable {
    static final double DRIVE_KS = 0.13, DRIVE_KV = 0.1156, STEER_KS = 0.29, STEER_KV = 2.483;
    static final double GEAR = 5.2734375, WHEEL_CODE = 0.0508, WHEEL_TRUE = 0.0495, MODULE_R = 0.39;
    final Subsystem subsystem = new Subsystem() {};
    double driveV, steerV, rotateRadps, driveRps, steerRps, rotations, yaw;

    void step(double dt) {
      // The drive: rotate() runs its own loop, spinDrives the open voltage.
      double target = rotateRadps != 0
          ? rotateRadps * MODULE_R / (2 * Math.PI * WHEEL_TRUE) * GEAR
          : Math.signum(driveV) * Math.max(0, Math.abs(driveV) - DRIVE_KS) / DRIVE_KV;
      driveRps += (target - driveRps) * dt / 0.12;
      double steerTarget = Math.signum(steerV) * Math.max(0, Math.abs(steerV) - STEER_KS) / STEER_KV;
      steerRps += (steerTarget - steerRps) * dt / 0.05;
      rotations += driveRps * dt;
      // The treads roll on the carpet: the robot turns by the TRUE radius.
      yaw += driveRps / GEAR * 2 * Math.PI * WHEEL_TRUE / MODULE_R * dt;
    }

    public int modules() { return 4; }
    public void spinDrives(double volts) { driveV = volts; rotateRadps = 0; steerV = 0; }
    public void spinSteers(double volts) { steerV = volts; driveV = 0; rotateRadps = 0; }
    public void rotate(double radps) { rotateRadps = radps; driveV = 0; steerV = 0; }
    public void stop() { driveV = 0; steerV = 0; rotateRadps = 0; }
    public double[] driveRps() { return new double[] {driveRps, -driveRps, driveRps, -driveRps}; }
    public double[] driveRotations() { return new double[] {rotations, -rotations, rotations, -rotations}; }
    public double[] steerRps() { return new double[] {steerRps, steerRps, steerRps, steerRps}; }
    public double gyroRateRadps() { return driveRps / GEAR * 2 * Math.PI * WHEEL_TRUE / MODULE_R; }
    public double gyroYawRad() { return yaw; }
    public double driveGearRatio() { return GEAR; }
    public double wheelRadiusM() { return WHEEL_CODE; }
    public double moduleRadiusM() { return MODULE_R; }
    public double speedAt12vMps() { return 5.85; }
    public Subsystem subsystem() { return subsystem; }
  }

  FakeSwerve hw;

  @BeforeEach
  void setUp() {
    HAL.initialize(500, 0);
    SimHooks.pauseTiming();
    // The routines move the robot: they only run enabled.
    edu.wpi.first.wpilibj.simulation.DriverStationSim.setEnabled(true);
    edu.wpi.first.wpilibj.simulation.DriverStationSim.notifyNewData();
    CommandScheduler.getInstance().cancelAll();
    hw = new FakeSwerve();
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().cancelAll();
    SimHooks.resumeTiming();
  }

  void run(Command c, double maxS) {
    CommandScheduler.getInstance().schedule(c);
    for (double t = 0; t < maxS && CommandScheduler.getInstance().isScheduled(c); t += 0.02) {
      CommandScheduler.getInstance().run();
      for (int k = 0; k < 4; k++) hw.step(0.005);
      SimHooks.stepTiming(0.02);
    }
  }

  double nt(String routine, String key) {
    return NetworkTableInstance.getDefault().getTable("Ares").getSubTable("Characterize").getSubTable(routine).getEntry(key).getDouble(Double.NaN);
  }

  @Test
  void aLineThroughPoints() {
    var f = Fit.of(new double[] {1, 2, 3, 4}, new double[] {1.5, 2.5, 3.5, 4.5});
    assertEquals(0.5, f.intercept(), 1e-12);
    assertEquals(1.0, f.slope(), 1e-12);
    assertEquals(1.0, f.r2(), 1e-12);
  }

  @Test
  void theDriveSweepFindsKsKvAndTheWheelRadius() {
    var c = AresCharacterization.drive(hw);
    run(c, 60);
    assertEquals(FakeSwerve.DRIVE_KS, c.fit().intercept(), 0.01);
    assertEquals(FakeSwerve.DRIVE_KV, c.fit().slope(), 0.002);
    assertTrue(c.fit().r2() > 0.999);
    assertEquals(14, c.points().size()); // 7 voltages, both ways
    // Published for the app, as it would read them.
    assertEquals(c.fit().slope(), nt("Drive", "kV"), 1e-12);
    assertEquals(FakeSwerve.WHEEL_TRUE, nt("Drive", "WheelRadiusM"), 0.0005);
    assertEquals(0.124, nt("Drive", "kVTheory"), 0.001);
    assertEquals(1.0, nt("Drive", "Progress"), 1e-12);
  }

  @Test
  void theSteerSweepFindsItsKsAndKv() {
    var c = AresCharacterization.steer(hw);
    run(c, 40);
    assertEquals(FakeSwerve.STEER_KS, c.fit().intercept(), 0.02);
    assertEquals(FakeSwerve.STEER_KV, c.fit().slope(), 0.05);
  }

  @Test
  void theWheelRadiusFromTheGyro() {
    var c = AresCharacterization.wheelRadius(hw);
    run(c, 20);
    assertEquals(FakeSwerve.WHEEL_TRUE, c.radius(), 0.0002);
    assertEquals(c.radius(), nt("WheelRadius", "WheelRadiusM"), 1e-12);
  }

  @Test
  void anNt4ClientPressingTheButtonStartsTheRoutine() throws Exception {
    // What Ares's Characterize tab does: a separate NT4 client publishes
    // true to the dashboard button's "running" topic.
    var server = NetworkTableInstance.create();
    var client = NetworkTableInstance.create();
    try {
      server.startServer("ares-test-nt.json", "127.0.0.1", 0, 5811);
      edu.wpi.first.wpilibj.smartdashboard.SmartDashboard.setNetworkTableInstance(server);
      com.stzteam.features.ares.characterize.CharacterizationTelemetry.setInstance(server);
      AresCharacterization.publish(hw);
      edu.wpi.first.wpilibj.smartdashboard.SmartDashboard.updateValues();
      client.startClient4("ares-app");
      client.setServer("127.0.0.1", 5811);
      for (int i = 0; i < 100 && !client.isConnected(); i++) Thread.sleep(20);
      assertTrue(client.isConnected());
      var running = client.getBooleanTopic("/SmartDashboard/Ares Characterize/Steer/running").publish();
      running.set(true);
      client.flush();
      boolean started = false;
      for (int i = 0; i < 100 && !started; i++) {
        Thread.sleep(20);
        edu.wpi.first.wpilibj.smartdashboard.SmartDashboard.updateValues();
        CommandScheduler.getInstance().run();
        hw.step(0.02);
        started = hw.steerV != 0;
      }
      assertTrue(started, "the steer routine did not start");
      // And the client sees it running, as the tab would.
      var state = client.getStringTopic("/Ares/Characterize/Steer/State").subscribe("");
      for (int i = 0; i < 50 && !state.get().equals("running"); i++) Thread.sleep(20);
      assertEquals("running", state.get());
    } finally {
      CommandScheduler.getInstance().cancelAll();
      edu.wpi.first.wpilibj.smartdashboard.SmartDashboard.setNetworkTableInstance(NetworkTableInstance.getDefault());
      com.stzteam.features.ares.characterize.CharacterizationTelemetry.setInstance(NetworkTableInstance.getDefault());
      client.close();
      server.close();
    }
  }

  @Test
  void aSweepThatGoesTooFastStops() {
    var c = AresCharacterization.drive(hw);
    CommandScheduler.getInstance().schedule(c);
    hw.driveRps = 500; // something is wrong: way past the safety cut
    CommandScheduler.getInstance().run();
    assertTrue(!CommandScheduler.getInstance().isScheduled(c));
    assertEquals(0, hw.driveV, 0);
  }
}
