package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.stzteam.features.ares.trajectory.FieldSymmetry;
import edu.wpi.first.hal.HAL;
import java.io.File;
import java.nio.file.Files;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The field the Ares project plays on (Settings → Field) reaches the robot through the index. */
class ProjectFieldTest {
  File projectOn(String key, double l, double w, String symmetry) throws Exception {
    var dir = Files.createTempDirectory("ares-field").toFile();
    for (var f : List.of("trajectories/Main.traj.json", "trajectories/Alt.traj.json", "trajectories/Find.traj.json")) {
      var to = new File(dir, f);
      to.getParentFile().mkdirs();
      Files.copy(new File(TrajectoryTest.PROJECT, f).toPath(), to.toPath());
    }
    var mapper = new ObjectMapper();
    var index = (ObjectNode) mapper.readTree(new File(TrajectoryTest.PROJECT, "ares-index.json"));
    index.putObject("field").put("key", key).put("lengthM", l).put("widthM", w).put("symmetry", symmetry);
    mapper.writeValue(new File(dir, "ares-index.json"), index);
    return dir;
  }

  @Test
  void theRobotTakesTheProjectsFieldUnlessTheCodeSaysOtherwise() throws Exception {
    HAL.initialize(500, 0);
    var drive = new FollowPathTest.PerfectDrive();
    var crescendo = projectOn("2024-crescendo", 16.542, 8.211, "mirrored");
    var c = new Ares(drive, new Ares.Config().withFolder(crescendo)).config();
    assertEquals(FieldSymmetry.MIRRORED, c.symmetry);
    assertEquals(16.542, c.fieldLengthM, 1e-9);
    assertEquals(8.211, c.fieldWidthM, 1e-9);
    // What the code sets wins.
    var set = new Ares(drive, new Ares.Config().withFolder(crescendo).withSymmetry(FieldSymmetry.ROTATIONAL).withFieldSize(16, 8)).config();
    assertEquals(FieldSymmetry.ROTATIONAL, set.symmetry);
    assertEquals(16, set.fieldLengthM, 1e-9);
    // A project that chose none: Rebuilt's, rotational, as before.
    var none = new Ares(drive, new Ares.Config().withFolder(TrajectoryTest.PROJECT)).config();
    assertEquals(FieldSymmetry.ROTATIONAL, none.symmetry);
    assertEquals(16.541, none.fieldLengthM, 1e-9);
  }
}
