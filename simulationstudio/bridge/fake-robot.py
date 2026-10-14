#!/usr/bin/env python3
"""Fake robot code: plays the part of the `vendor` profile's glue.

    python simulationstudio/bridge/fake-robot.py <robot-map.json> [seconds]

It stands in for a real robot's `simulationPeriodic`:

  1. brings up the NT4 server, as ntcore does inside the robot code;
  2. publishes the duty "the vendor is applying" to each motor;
  3. reads back the position, velocity and yaw the physics returns.

And then it verifies the circle closed. That circle is the only thing this
harness tests and the only thing that cannot be tested in pieces:

    robot -> bridge -> engine -> physics -> engine -> bridge -> robot

On a swerve, the steering goes in `position` mode: the harness sends it an
angle and the ENGINE closes the loop, just like a TalonFX. Checking that the
module reaches the requested angle and stays there is what verifies that the
setpoint travels, that the units are the ones the contract says and that the
engine's loop works.

Requires:  pip install pyntcore
"""
import json
import math
import os
import sys
import time

import ntcore

# The prefixes are part of the contract; they live in [[glue]] of topics.toml.
OUT = "/MARS/Glue/out"
IN = "/MARS/Glue/in"

# Steering in `position` mode has NO loop here: it is sent an angle and the
# engine closes the loop at the physics rate, like a TalonFX with Motion
# Magic. This is the difference between this harness and the previous attempt,
# which tried to hold it with duty from here and could not: a 12.8:1 steering
# stage on a Kraken has 90 N*m across 0.008 kg*m^2, and no loop over the
# network -- neither at 50 Hz nor at 250 -- has authority over that.
#
# Setpoint while driving: modules facing forward.
STEER_ANGLE_RAD = 0.0

# Afterwards they are asked to turn to this angle, with the robot still.
# Holding zero already tests quite a bit -- the steering takes a real
# disturbance when the robot accelerates -- but only asking for a DIFFERENT
# angle proves the setpoint really travels and that the units are the ones the
# contract says. A loop that ignored the setpoint and always held zero would
# pass the first test.
TARGET_ANGLE_RAD = 0.6           # 34 degrees
TARGET_TOLERANCE_RAD = 0.05      # 3 degrees

# How far a steering module can deviate and still count as held.
STEER_TOLERANCE_RAD = 0.35

# The robot drives straight, so the yaw should not move much. A wide margin:
# the wheels slip when launching at full power.
YAW_MAX_DEG = 25.0

# 20 ms, a WPILib robot's cycle. It can be lowered with MARS_PERIOD to tell
# "the loop is slow" from "the model is wrong".
PERIOD_S = float(os.environ.get("MARS_PERIOD", "0.02"))


def main(map_path: str, duration_s: float) -> int:
    robot_map = json.load(open(map_path, encoding="utf-8"))
    if robot_map["profile"] != "vendor":
        print(f"FAIL: this harness is for the vendor profile, not {robot_map['profile']!r}",
              file=sys.stderr)
        return 1

    # Steering is position-controlled and drive is open-loop power. They are
    # told apart by the joint name, which is the convention the robot map
    # already uses.
    steering = [a for a in robot_map["actuators"] if "steer" in a["name"]]
    drives = [a for a in robot_map["actuators"] if a not in steering]
    print(f"[robot] {robot_map['robot']}: {len(drives)} drive,"
          f" {len(steering)} steering")

    # Check the port BEFORE starting. `startServer` on a busy port neither
    # fails nor warns: it stays quiet, the clients connect to the OTHER server
    # --- usually the real robot code --- and see none of these topics. The
    # symptom shows up miles from the cause.
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", 5810)) == 0:
            print(
                "FAIL: there is already an NT4 server on port 5810."
                + "\n      It is almost certainly your robot code (simulateJava)."
                + "\n      This harness PLAYS the robot code, so the two cannot"
                + "\n      run together: close one.",
                file=sys.stderr,
            )
            return 1

    inst = ntcore.NetworkTableInstance.getDefault()
    inst.startServer()
    print("[robot] NT4 server listening")

    names = [a["name"] for a in robot_map["actuators"]]
    ratio = {a["name"]: a.get("gearRatio", 1.0) for a in robot_map["actuators"]}

    # --- what the glue PUBLISHES (what the vendor applies to each motor) ----
    enabled = inst.getBooleanTopic(f"{OUT}/enabled").publish()
    duty = {n: inst.getDoubleTopic(f"{OUT}/{n}/duty").publish() for n in names}
    setpoint = {n: inst.getDoubleTopic(f"{OUT}/{n}/setpoint").publish() for n in names}

    # --- what the glue READS (what the physics returns) ---------------------
    pos = {n: inst.getDoubleTopic(f"{IN}/{n}/position").subscribe(0.0) for n in names}
    vel = {n: inst.getDoubleTopic(f"{IN}/{n}/velocity").subscribe(0.0) for n in names}
    yaw = inst.getDoubleTopic(f"{IN}/gyro/yaw").subscribe(0.0)

    def module_angle(name: str) -> float:
        """The module's position in radians, undoing the reduction.

        The contract delivers positions on the MOTOR's shaft; the steering
        loop reasons about the module's angle, which is the physical one.
        """
        return pos[name].get() / ratio[name]

    # Disabled first, on purpose: if anything moved here the engine would be
    # ignoring the match state. A robot with the DS off rolls free.
    #
    # The steering gets its setpoint right here, so when enabled the engine
    # does not start chasing a target nobody gave it.
    enabled.set(False)
    for a in drives:
        duty[a["name"]].set(1.0)
    for a in steering:
        setpoint[a["name"]].set(0.0)
    time.sleep(2.0)
    pos_still = {n: pos[n].get() for n in names}
    vel_still = max(abs(vel[n].get()) for n in names)
    print(f"[robot] disabled with duty 1.0: max velocity {vel_still:.3f} rad/s")

    # --- enable and drive ----------------------------------------------------
    enabled.set(True)
    print(f"[robot] enabled, driving for {duration_s:.0f} s")
    end = time.time() + duration_s
    vel_max = 0.0
    deviation_max = 0.0
    last_debug = 0.0
    while time.time() < end:
        for a in drives:
            duty[a["name"]].set(1.0)
        # The steering is sent the SETPOINT, in motor radians. The module
        # getting there and staying is the engine's job.
        for a in steering:
            n = a["name"]
            setpoint[n].set(STEER_ANGLE_RAD * ratio[n])
            deviation_max = max(deviation_max, abs(module_angle(n) - STEER_ANGLE_RAD))

        time.sleep(PERIOD_S)
        vel_max = max(vel_max, max(abs(vel[a["name"]].get()) for a in drives))

        if os.environ.get("MARS_DEBUG") and steering:
            now = time.time()
            if now - last_debug > 0.5:
                last_debug = now
                n = steering[0]["name"]
                print(f"[dbg] {n}: ang={math.degrees(module_angle(n)):+8.1f} deg"
                      f"  vel={vel[n].get() / ratio[n]:+7.2f} rad/s"
                      f"  duty={duty[n].get() if hasattr(duty[n], 'get') else float('nan'):+.3f}"
                      f"  yaw={yaw.get():+7.1f}")

    pos_final = {n: pos[n].get() for n in names}
    yaw_final = yaw.get()

    # --- point at a different angle -----------------------------------------
    # With the drive stopped, so the only motion is the steering's and the
    # result does not depend on the chassis' dynamics.
    reached = {}
    if steering:
        for a in drives:
            duty[a["name"]].set(0.0)
        for a in steering:
            setpoint[a["name"]].set(TARGET_ANGLE_RAD * ratio[a["name"]])
        print(f"[robot] pointing at {math.degrees(TARGET_ANGLE_RAD):.0f} degrees")
        time.sleep(2.0)
        reached = {a["name"]: module_angle(a["name"]) for a in steering}

    enabled.set(False)
    time.sleep(0.3)

    failures = []

    # --- the match state is respected ---------------------------------------
    if vel_still > 1.0:
        failures.append(f"disabled, it was turning at {vel_still:.2f} rad/s:"
                        " the engine ignores /mars/cmd/match")

    # --- the circle closed ---------------------------------------------------
    print(f"[robot] max drive velocity: {vel_max:.1f} rad/s (motor shaft)")
    if vel_max < 10.0:
        failures.append(f"the wheels barely turned ({vel_max:.2f} rad/s): the duty"
                        " did not reach the engine, or its state did not come back")

    for a in drives:
        n = a["name"]
        travel = pos_final[n] - pos_still[n]
        turns = travel / (2 * math.pi)
        print(f"[robot] {n}: {turns:+.1f} motor turns (reduction {ratio[n]})")
        if travel <= 0.0:
            failures.append(f"{n} did not advance ({travel:+.3f} rad)")

    # --- the position loop held ----------------------------------------------
    if steering:
        print(f"[robot] max steering deviation: {math.degrees(deviation_max):.1f} degrees")
        if deviation_max > STEER_TOLERANCE_RAD:
            failures.append(
                f"the steering loop did not hold: {math.degrees(deviation_max):.1f}"
                " degrees of deviation. The position feedback arrives wrong, or"
                " in other units"
            )

    for n, ang in reached.items():
        error = ang - TARGET_ANGLE_RAD
        print(f"[robot] {n}: reached {math.degrees(ang):+.1f} degrees"
              f" ({math.degrees(error):+.1f} error)")
        if abs(error) > TARGET_TOLERANCE_RAD:
            failures.append(
                f"{n} did not reach the setpoint: {math.degrees(ang):+.1f} degrees"
                f" instead of {math.degrees(TARGET_ANGLE_RAD):.0f}"
            )

    print(f"[robot] yaw = {yaw_final:.1f} degrees")
    if abs(yaw_final) > YAW_MAX_DEG:
        failures.append(f"the robot turned {yaw_final:.1f} degrees driving straight")

    for f in failures:
        print(f"FAIL: {f}", file=sys.stderr)
    if failures:
        return 1
    print("[robot] OK: the circle robot -> bridge -> physics -> bridge -> robot closed")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    code = main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 4.0)
    # os._exit: ntcore leaves C++ threads running and their teardown during
    # interpreter finalization returns an exit code that is not ours.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
