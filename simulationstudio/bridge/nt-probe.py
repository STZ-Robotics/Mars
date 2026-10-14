#!/usr/bin/env python3
"""Brings up a real NT4 server and verifies what the bridge publishes.

    python simulationstudio/bridge/nt-probe.py [seconds] [min_travel_m]

With `min_travel_m` it also requires the pose to FOLLOW the robot: it has to be
driven in parallel. Without that argument it only checks the static pose.

It uses WPILib's `ntcore` -- the REFERENCE implementation, the same one that
runs on a roboRIO -- instead of checking the bridge against our own code. If
the wire format had a bug, a test written by us could share the same
misunderstanding; ntcore cannot.

It acts as the server because in simulation the NT4 server is brought up by
the robot code, not by the bridge or the app. Here it takes that place.

Requires:  pip install pyntcore
"""
import math
import os
import struct
import sys
import time

import ntcore

# These values come from ../protocol/topics.toml and the field's dimensions.
# The robot starts at Gazebo's origin, which is the CENTER of the field, so in
# WPILib's frame it gets half of each dimension.
CENTER_X = 16.54 / 2
CENTER_Y = 8.21 / 2
TOLERANCE_M = 0.30  # the robot settles a few centimeters when it appears

EXPECTED_SCHEMAS = [
    "Translation2d", "Rotation2d", "Pose2d",
    "Translation3d", "Quaternion", "Rotation3d", "Pose3d",
]


def main(duration_s: float, min_travel_m: float) -> int:
    inst = ntcore.NetworkTableInstance.getDefault()
    inst.startServer()
    print(f"[nt] NT4 server listening, {duration_s:.0f} s")

    pose2d = inst.getRawTopic("/MARS/Sim/truthPose").subscribe("struct:Pose2d", b"")
    pose3d = inst.getRawTopic("/MARS/Sim/truthPose3d").subscribe("struct:Pose3d", b"")
    field = inst.getDoubleArrayTopic("/SmartDashboard/Field/Robot").subscribe([])
    state = inst.getStringTopic("/MARS/Sim/state").subscribe("")
    rtf = inst.getDoubleTopic("/MARS/Sim/realTimeFactor").subscribe(0.0)
    sim_t = inst.getDoubleTopic("/MARS/Sim/simTime").subscribe(0.0)
    schemas = {
        n: inst.getRawTopic(f"/.schema/struct:{n}").subscribe("structschema", b"")
        for n in EXPECTED_SCHEMAS
    }

    xs, rtfs, times = [], [], []
    end = time.time() + duration_s
    while time.time() < end:
        time.sleep(0.1)
        raw = pose2d.get()
        if len(raw) == 24:
            x, _y, _th = struct.unpack("<ddd", raw)
            xs.append(x)
        if (v := rtf.get()) > 0:
            rtfs.append(v)
        if (t := sim_t.get()) > 0:
            times.append(t)

    failures = []

    # --- schemas -------------------------------------------------------------
    # Without a published descriptor, the app receives a blob it cannot decode.
    for name, sub in schemas.items():
        d = sub.get()
        if not d:
            failures.append(f"the {name} schema is missing")
        else:
            print(f"[nt] schema {name}: {d.decode()}")

    # --- Pose2d --------------------------------------------------------------
    raw = pose2d.get()
    if len(raw) != 24:
        failures.append(f"truthPose is {len(raw)} bytes, expected 24")
    else:
        x, y, th = struct.unpack("<ddd", raw)
        print(f"[nt] Pose2d = ({x:.3f}, {y:.3f}, {th:.3f} rad)")
        # The robot may have moved in X if something drove it, but in Y it
        # should not leave the center.
        if abs(y - CENTER_Y) > TOLERANCE_M:
            failures.append(f"y={y:.3f} far from the center {CENTER_Y:.3f}")

    # The translation is checked against the FIRST sample, not the last: the
    # robot starts at Gazebo's origin, which is the center of the field, and
    # that gives the exact value the bridge has to publish. A wide range does
    # not work because the world has no walls -- the collision plane is
    # infinite -- and the robot can legitimately leave the field.
    if xs:
        if abs(xs[0] - CENTER_X) > TOLERANCE_M:
            failures.append(
                f"the first x was {xs[0]:.3f}, expected the center"
                f" {CENTER_X:.3f}: the translation is wrong"
            )
        if min(xs) < -TOLERANCE_M:
            failures.append(
                f"x reached {min(xs):.3f}: in WPILib's frame the origin is the"
                " corner, not the center"
            )

    # --- Pose3d --------------------------------------------------------------
    raw3 = pose3d.get()
    if len(raw3) != 56:
        failures.append(f"truthPose3d is {len(raw3)} bytes, expected 56")
    else:
        x3, y3, z3, qw, qx, qy, qz = struct.unpack("<ddddddd", raw3)
        print(f"[nt] Pose3d = ({x3:.3f}, {y3:.3f}, {z3:.3f}) q=({qw:.3f},{qx:.3f},{qy:.3f},{qz:.3f})")
        # A quaternion that is not unit length means something else (roll,
        # pitch, yaw for instance) was sent in the rotation's slot.
        norm = (qw * qw + qx * qx + qy * qy + qz * qz) ** 0.5
        if abs(norm - 1.0) > 1e-6:
            failures.append(f"the quaternion is not unit length (norm {norm:.6f})")
        if abs(x3 - x) > 1e-9 or abs(y3 - y) > 1e-9:
            failures.append("Pose2d and Pose3d disagree in X/Y")

    # --- Field2d -------------------------------------------------------------
    f = field.get()
    if len(f) != 3:
        failures.append(f"Field/Robot has {len(f)} elements, expected 3")
    else:
        print(f"[nt] Field2d = [{f[0]:.3f}, {f[1]:.3f}, {f[2]:.1f} deg]")
        if abs(f[0] - x) > 1e-9:
            failures.append("Field2d and truthPose disagree in X")
        # Field2d goes in DEGREES and the struct in radians: if someone copies
        # the value from one to the other, this catches it.
        if abs(f[2] - math.degrees(th)) > 1e-6:
            failures.append(f"Field2d theta={f[2]:.3f} is not {th:.3f} rad in degrees")

    # --- health --------------------------------------------------------------
    print(f"[nt] state = {state.get()!r}")
    if state.get() not in ("running", "paused"):
        failures.append(f"unexpected state: {state.get()!r}")
    if not times:
        failures.append("simTime never arrived")
    elif times[-1] <= times[0]:
        failures.append("simTime did not advance: the simulation is stopped")
    if not rtfs:
        failures.append("realTimeFactor never arrived")
    else:
        mean = sum(rtfs) / len(rtfs)
        print(f"[nt] mean real-time factor = {mean:.2f} ({len(rtfs)} samples)")

    if xs:
        travel = max(xs) - min(xs)
        print(f"[nt] x covered [{min(xs):.3f}, {max(xs):.3f}] = {travel:.3f} m"
              f" in {len(xs)} samples")
        # With something driving the robot in parallel, a pose that does not
        # change means the bridge published once and got stuck -- a failure a
        # static check cannot tell apart from working fine.
        if min_travel_m > 0 and travel < min_travel_m:
            failures.append(
                f"the pose did not follow the robot: {travel:.3f} m < {min_travel_m} m"
            )

    for f_ in failures:
        print(f"FAIL: {f_}", file=sys.stderr)
    if failures:
        return 1
    print("[nt] OK: the bridge speaks NT4 correctly against WPILib's ntcore")
    return 0


if __name__ == "__main__":
    code = main(
        float(sys.argv[1]) if len(sys.argv) > 1 else 12.0,
        float(sys.argv[2]) if len(sys.argv) > 2 else 0.0,
    )
    # os._exit instead of sys.exit: ntcore is a native extension that leaves a
    # server running in C++ threads, and its teardown during interpreter
    # finalization returns an exit code that is not ours. The verdict is
    # already printed and the outputs flushed; all that is left is shutting
    # down, and we do not want shutting down to change the result.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
