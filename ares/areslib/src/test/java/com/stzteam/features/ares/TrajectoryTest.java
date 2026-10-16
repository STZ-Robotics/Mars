package com.stzteam.features.ares;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stzteam.features.ares.trajectory.AresSample;
import com.stzteam.features.ares.trajectory.AresTrajectory;
import com.stzteam.features.ares.trajectory.FieldSymmetry;
import java.io.File;
import org.junit.jupiter.api.Test;

class TrajectoryTest {
  static final File PROJECT = new File("src/test/resources/project");
  static final double L = 16.541, W = 8.0692, MASS = 58.0;

  static AresTrajectory main() throws Exception {
    return AresTrajectory.load(new File(PROJECT, "trajectories/Main.traj.json"));
  }

  @Test
  void readsWhatTheAppWrites() throws Exception {
    var t = main();
    assertEquals("Main", t.name());
    assertEquals(3, t.waypointTimes().size());
    assertEquals(AresTrajectory.Start.KNOWN, t.start());
    assertEquals(4, t.initial().modules());
    assertEquals(2.0, t.initial().x(), 1e-9);
    // The markers come sorted by time; the zone keeps its end.
    assertEquals("spin", t.events().get(0).name());
    assertTrue(t.events().get(0).isZone());
    assertEquals(0.6, t.events().get(0).endT(), 1e-9);
    assertEquals("intake", t.events().get(1).name());

    var alt = AresTrajectory.load(new File(PROJECT, "trajectories/Alt.traj.json"));
    assertEquals(AresTrajectory.Start.PREVIOUS, alt.start());
    assertEquals("Main", alt.continuesFrom().orElseThrow());
  }

  @Test
  void theForcesAreTheAcceleration() throws Exception {
    // What makes them a feedforward: the wheels' pushes add up to m a.
    for (var s : main().samples()) {
      double fx = 0, fy = 0;
      for (int i = 0; i < s.modules(); i++) {
        fx += s.moduleForceXN()[i];
        fy += s.moduleForceYN()[i];
      }
      assertEquals(MASS * s.ax(), fx, 1e-6 * MASS + 1e-6);
      assertEquals(MASS * s.ay(), fy, 1e-6 * MASS + 1e-6);
    }
  }

  @Test
  void samplingHitsTheSamplesAndIsContinuous() throws Exception {
    var t = main();
    for (var s : t.samples()) {
      var at = t.sample(s.t());
      assertEquals(s.x(), at.x(), 1e-9);
      assertEquals(s.vy(), at.vy(), 1e-9);
    }
    // Between samples, integrating the held acceleration lands on the next one.
    for (int k = 0; k + 1 < t.samples().size(); k++) {
      var a = t.samples().get(k);
      var b = t.samples().get(k + 1);
      var end = a.advance(b.t() - a.t(), b);
      assertEquals(b.x(), end.x(), 2e-3, "x at sample " + (k + 1));
      assertEquals(b.y(), end.y(), 2e-3);
      assertEquals(b.vx(), end.vx(), 2e-2);
    }
    assertEquals(t.last().x(), t.sample(99).x(), 0);
    assertEquals(t.initial().x(), t.sample(-1).x(), 0);
  }

  @Test
  void flippingTwiceIsNothing() throws Exception {
    var t = main();
    double[] mx = {0.276, 0.276, -0.276, -0.276}, my = {0.276, -0.276, 0.276, -0.276};
    for (var sym : FieldSymmetry.values()) {
      var partners = sym.modulePartners(mx, my);
      var back = t.flipped(sym, L, W, partners).flipped(sym, L, W, partners);
      for (int k = 0; k < t.samples().size(); k++) {
        var a = t.samples().get(k);
        var b = back.samples().get(k);
        assertEquals(a.x(), b.x(), 1e-9);
        assertEquals(a.y(), b.y(), 1e-9);
        assertEquals(0, Math.IEEEremainder(a.heading() - b.heading(), 2 * Math.PI), 1e-9);
        assertArrayEquals(a.moduleForceXN(), b.moduleForceXN(), 1e-9);
        assertArrayEquals(a.moduleForceYN(), b.moduleForceYN(), 1e-9);
      }
    }
  }

  @Test
  void aMirrorTradesLeftAndRight() {
    double[] mx = {0.276, 0.276, -0.276, -0.276}, my = {0.276, -0.276, 0.276, -0.276};
    assertArrayEquals(new int[] {1, 0, 3, 2}, FieldSymmetry.MIRRORED.modulePartners(mx, my));
    assertArrayEquals(new int[] {0, 1, 2, 3}, FieldSymmetry.ROTATIONAL.modulePartners(mx, my));
  }

  @Test
  void theFlippedForcesStillMakeTheFlippedAcceleration() throws Exception {
    double[] mx = {0.276, 0.276, -0.276, -0.276}, my = {0.276, -0.276, 0.276, -0.276};
    for (var sym : FieldSymmetry.values()) {
      var red = main().flipped(sym, L, W, sym.modulePartners(mx, my));
      for (AresSample s : red.samples()) {
        double fx = 0, fy = 0;
        for (int i = 0; i < 4; i++) {
          fx += s.moduleForceXN()[i];
          fy += s.moduleForceYN()[i];
        }
        assertEquals(MASS * s.ax(), fx, 1e-6 * MASS + 1e-6);
        assertEquals(MASS * s.ay(), fy, 1e-6 * MASS + 1e-6);
      }
      // And the robot ends where blue's would, seen from the other side.
      var end = main().last();
      double y = sym == FieldSymmetry.ROTATIONAL ? W - end.y() : end.y();
      assertEquals(L - end.x(), red.last().x(), 1e-9);
      assertEquals(y, red.last().y(), 1e-9);
    }
  }

  @Test
  void slicesStartTheirOwnClock() throws Exception {
    var t = main();
    int mid = t.indexAt(t.waypointTimes().get(1));
    var second = t.slice(mid, t.samples().size() - 1);
    assertEquals(0, second.startTime(), 0);
    assertEquals(t.endTime() - t.samples().get(mid).t(), second.duration(), 1e-9);
    assertEquals(AresTrajectory.Start.PREVIOUS, second.start());
    // The zone ended before the cut; the intake marker is before it too.
    assertTrue(second.events().stream().noneMatch(e -> e.name().equals("spin")));
    assertEquals(1, t.splitCount());
    assertEquals(t.duration(), t.split(0).duration(), 1e-9);
  }
}
