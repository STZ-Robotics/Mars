package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.smartdashboard.SmartDashboard;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import java.io.File;
import java.nio.file.Files;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** What the Ares app sends to a running robot (hot reload), and the auto choosers by folder. */
class HotReloadTest {
  // One server (the robot's) and one client (the app's) for the whole class,
  // as on a robot: NetworkTables instances made and closed over and over in
  // one JVM stop delivering to listeners.
  static NetworkTableInstance server;
  static NetworkTableInstance app;
  FollowPathTest.PerfectDrive drive;
  Ares ares;

  @BeforeAll
  static void connect() throws Exception {
    HAL.initialize(500, 0);
    server = NetworkTableInstance.create();
    server.startServer("ares-test-nt.json", "127.0.0.1", 0, 5813);
    app = NetworkTableInstance.create();
    app.startClient4("ares-app");
    app.setServer("127.0.0.1", 5813);
    for (int i = 0; i < 200 && !app.isConnected(); i++) Thread.sleep(10);
    assertTrue(app.isConnected(), "the app's client did not connect");
  }

  @AfterAll
  static void disconnect() {
    app.close();
    server.close();
  }

  @BeforeEach
  void setUp() throws Exception {
    DriverStationSim.setEnabled(false);
    DriverStationSim.setFmsAttached(false);
    DriverStationSim.notifyNewData();
    server.getTable("Ares").getSubTable("HotReload").getEntry("Last").setString("");
    drive = new FollowPathTest.PerfectDrive();
    ares = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> false).withNetworkTables(server));
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().getDefaultButtonLoop().clear();
    // As the other tests leave it.
    DriverStationSim.setFmsAttached(false);
    DriverStationSim.setEnabled(true);
    DriverStationSim.notifyNewData();
  }

  /** Runs the robot's loop until {@code done} holds (or two seconds pass). */
  void waitFor(BooleanSupplier done) throws InterruptedException {
    for (int i = 0; i < 200 && !done.getAsBoolean(); i++) {
      CommandScheduler.getInstance().run();
      Thread.sleep(10);
    }
  }

  String status() {
    return server.getTable("Ares").getSubTable("HotReload").getEntry("Last").getString("");
  }

  void send(String topic, String json) {
    var pub = app.getStringTopic(topic).publish(edu.wpi.first.networktables.PubSubOption.keepDuplicates(true));
    pub.set(json);
    app.flush();
  }

  @Test
  void aTrajectorySentReplacesTheOneOnTheRobot() throws Exception {
    var alt = Files.readString(new File(TrajectoryTest.PROJECT, "trajectories/Alt.traj.json").toPath());
    double before = ares.trajectory("Main").duration();
    send("/Ares/HotReload/Trajectories/Main", alt);
    waitFor(() -> status().equals("applied Main"));
    assertEquals("applied Main", status());
    assertEquals(ares.trajectory("Alt").duration(), ares.trajectory("Main").duration(), 1e-9);
    assertTrue(Math.abs(before - ares.trajectory("Main").duration()) > 0.01);
  }

  @Test
  void anIndexSentAddsItsAutosToTheChoosers() throws Exception {
    var mapper = new ObjectMapper();
    var index = (ObjectNode) mapper.readTree(new File(TrajectoryTest.PROJECT, "ares-index.json"));
    var hot = mapper.createObjectNode().put("name", "Hot").put("folder", "Qualifiers");
    hot.putArray("steps").addObject().put("type", "path").put("path", "Main");
    index.withArray("autos").add(hot);
    var chooser = ares.autoChooser("Qualifiers");
    send("/Ares/HotReload/Index", mapper.writeValueAsString(index));
    waitFor(() -> status().equals("applied the autos"));
    assertTrue(ares.autoNames().contains("Hot"));
    SmartDashboard.putData("Qualifiers", chooser);
    SmartDashboard.updateValues();
    var options = NetworkTableInstance.getDefault().getTable("SmartDashboard").getSubTable("Qualifiers").getEntry("options").getStringArray(new String[0]);
    java.util.Arrays.sort(options);
    // Only that folder's autos, the one that just came included.
    assertArrayEquals(new String[] {"Branchy", "Full", "Hot", "None"}, options);
  }

  @Test
  void nothingIsReloadedWithAFieldConnected() throws Exception {
    DriverStationSim.setFmsAttached(true);
    DriverStationSim.notifyNewData();
    var alt = Files.readString(new File(TrajectoryTest.PROJECT, "trajectories/Find.traj.json").toPath());
    double before = ares.trajectory("Main").duration();
    send("/Ares/HotReload/Trajectories/Main", alt);
    waitFor(() -> status().startsWith("refused"));
    assertTrue(status().startsWith("refused Main"), status());
    assertEquals(before, ares.trajectory("Main").duration(), 1e-9);
  }

  @Test
  void theAutoPickedIsPublishedWithWhereTheRobotStarts() throws Exception {
    var chooser = ares.autoChooser();
    SmartDashboard.putData("Auto", chooser);
    SmartDashboard.updateValues();
    NetworkTableInstance.getDefault().getTable("SmartDashboard").getSubTable("Auto").getEntry("selected").setString("Branchy");
    SmartDashboard.updateValues();
    var selected = NetworkTableInstance.getDefault().getTable("Ares").getSubTable("Auto").getEntry("Selected");
    waitFor(() -> selected.getString("").equals("Branchy"));
    assertEquals("Branchy", selected.getString(""));
    var start = NetworkTableInstance.getDefault().getTable("Ares").getSubTable("Auto")
        .getStructTopic("StartPose", edu.wpi.first.math.geometry.Pose2d.struct).subscribe(null).get();
    var main = TrajectoryTest.main().initial().pose();
    assertEquals(main.getX(), start.getX(), 1e-6);
    assertEquals(main.getY(), start.getY(), 1e-6);
  }
}
