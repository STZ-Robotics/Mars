package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;

import edu.wpi.first.hal.HAL;
import java.io.File;
import java.nio.file.Files;
import java.util.List;
import org.junit.jupiter.api.Test;

/** gains.json, what the Tune tab's "Apply to robot" writes. */
class GainsTest {
  File project(String gains) throws Exception {
    var dir = Files.createTempDirectory("ares-gains").toFile();
    for (var f : List.of("ares-index.json", "trajectories/Main.traj.json", "trajectories/Alt.traj.json", "trajectories/Find.traj.json")) {
      var to = new File(dir, f);
      to.getParentFile().mkdirs();
      Files.copy(new File(TrajectoryTest.PROJECT, f).toPath(), to.toPath());
    }
    if (gains != null) Files.writeString(new File(dir, "gains.json").toPath(), gains);
    return dir;
  }

  @Test
  void theTunedGainsAreUsedWhenTheCodeSetsNone() throws Exception {
    HAL.initialize(500, 0);
    var dir = project("{\"format\":1,\"source\":\"Tune\",\"translation\":{\"kp\":0.73,\"ki\":0,\"kd\":0.19},\"rotation\":{\"kp\":0.61,\"ki\":0,\"kd\":0}}");
    var config = new Ares.Config().withFolder(dir);
    new Ares(new FollowPathTest.PerfectDrive(), config);
    assertEquals(0.73, config.translation().kP(), 1e-12);
    assertEquals(0.19, config.translation().kD(), 1e-12);
    assertEquals(0.61, config.rotation().kP(), 1e-12);
  }

  @Test
  void theRecoveryComesWithTheGains() throws Exception {
    HAL.initialize(500, 0);
    var dir = project("{\"translation\":{\"kp\":1},\"rotation\":{\"kp\":1},\"recovery\":{\"toleranceM\":0.3,\"delayS\":0.1,\"rejoinAheadS\":0.6,\"arriveM\":0.05}}");
    var config = new Ares.Config().withFolder(dir);
    new Ares(new FollowPathTest.PerfectDrive(), config);
    assertEquals(0.3, config.replanToleranceM, 1e-12);
    assertEquals(0.6, config.rejoinAheadS, 1e-12);
    assertEquals(0.05, config.arriveM, 1e-12);
  }

  @Test
  void theCodesOwnGainsWin() throws Exception {
    HAL.initialize(500, 0);
    var dir = project("{\"translation\":{\"kp\":0.73},\"rotation\":{\"kp\":0.61}}");
    var config = new Ares.Config().withFolder(dir).withGains(new AresController.Gains(3, 0, 0), new AresController.Gains(2, 0, 0));
    new Ares(new FollowPathTest.PerfectDrive(), config);
    assertEquals(3, config.translation().kP(), 1e-12);
  }

  @Test
  void withoutTheFileTheDefaultsStay() throws Exception {
    HAL.initialize(500, 0);
    var config = new Ares.Config().withFolder(project(null));
    new Ares(new FollowPathTest.PerfectDrive(), config);
    assertEquals(4, config.translation().kP(), 1e-12);
  }
}
