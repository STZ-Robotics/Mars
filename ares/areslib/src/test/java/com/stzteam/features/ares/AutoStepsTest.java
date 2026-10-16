package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The Autos tab's together and when steps, on the real scheduler. */
class AutoStepsTest {
  FollowPathTest.PerfectDrive drive;
  Ares ares;
  double clock;
  final List<Double> marks = new ArrayList<>();
  final List<double[]> holds = new ArrayList<>(); // [start, end]
  boolean go;

  @BeforeEach
  void setUp() {
    HAL.initialize(500, 0);
    SimHooks.pauseTiming();
    DriverStationSim.setEnabled(true);
    DriverStationSim.notifyNewData();
    CommandScheduler.getInstance().cancelAll();
    drive = new FollowPathTest.PerfectDrive();
    ares = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT).withFlip(() -> false));
    ares.registerCommand("mark", Commands.runOnce(() -> marks.add(clock)));
    ares.registerCommand("hold", () -> Commands.startEnd(
        () -> holds.add(new double[] {clock, Double.NaN}),
        () -> holds.get(holds.size() - 1)[1] = clock));
    ares.registerCondition("go", () -> go);
  }

  @AfterEach
  void tearDown() {
    CommandScheduler.getInstance().cancelAll();
    SimHooks.resumeTiming();
  }

  double run(Command c, double maxS, double goAtS) {
    CommandScheduler.getInstance().schedule(c);
    for (clock = 0; clock < maxS; clock += 0.02) {
      go = clock >= goAtS;
      CommandScheduler.getInstance().run();
      if (!CommandScheduler.getInstance().isScheduled(c)) return clock;
      SimHooks.stepTiming(0.02);
      drive.step(0.02);
    }
    return clock;
  }

  @Test
  void aDeadlineEndsWithItsFirstListAndCutsTheOthers() throws Exception {
    drive.pose = new Pose2d(9, 9, new Rotation2d());
    double took = run(ares.auto("Together"), 10, 99);
    double path = TrajectoryTest.main().duration();
    assertEquals(path, took, 0.08);
    assertEquals(1, holds.size());
    assertEquals(path, holds.get(0)[1], 0.08); // cut when the path ended
  }

  @Test
  void aRaceEndsWithTheFirstToFinish() {
    double took = run(ares.auto("Race"), 5, 99);
    assertEquals(0.5, took, 0.05);
    assertEquals(0.5, holds.get(0)[1], 0.05);
  }

  @Test
  void aWhenOnTimeFiresAtItsTimeDuringThePath() {
    run(ares.auto("WhenTime"), 10, 99);
    assertEquals(1, marks.size());
    assertEquals(0.3, marks.get(0), 0.05);
  }

  @Test
  void aWhenOnAZoneFiresWhenTheRobotGetsThere() throws Exception {
    run(ares.auto("WhenZone"), 10, 99);
    assertEquals(1, marks.size());
    var main = TrajectoryTest.main();
    // Inside a 1 m box around the end: in the last stretch of the path.
    assertTrue(marks.get(0) > main.duration() * 0.6, "fired at " + marks.get(0));
  }

  @Test
  void aWhenOnAConditionFiresWhenItHoldsAndNotAfterTheAuto() {
    run(ares.auto("WhenCondition"), 5, 0.4);
    assertEquals(1, marks.size());
    assertEquals(0.4, marks.get(0), 0.05);
    marks.clear();
    run(ares.auto("WhenCondition"), 5, 99); // never holds: nothing, and the auto still ends
    assertEquals(0, marks.size());
  }

  @Test
  void twoPathsAtOnceAreAnAlertNotACrash() throws Exception {
    drive.pose = new Pose2d(9, 9, new Rotation2d());
    double took = run(ares.auto("Clash"), 10, 99);
    assertEquals(TrajectoryTest.main().duration(), took, 0.08); // only the first list
  }
}
