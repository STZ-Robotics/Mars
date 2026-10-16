# Connecting the robot code to the simulation

Two files:

- [`java/MarsSimGlue.java`](java/MarsSimGlue.java) — copied into the robot project.
- [`java/CommandSwerveDrivetrain.patch.md`](java/CommandSwerveDrivetrain.patch.md) — the two lines that change.

---

## What to understand first

Your swerve **is already simulated**. `CommandSwerveDrivetrain` starts a
`Notifier` at 250 Hz that calls `updateSimState(...)`, and that is CTRE's
simulation: it models the motors, applies your gains and integrates the pose
with the swerve's kinematics.

It is a **kinematic** simulation. The robot goes exactly where the equations
say it would. It has no mass to accelerate, the wheels do not slip, and it
goes through walls — not because it is badly made, but because that is not
its job.

**MARS does not add a second simulation: it replaces that one.** One call is
swapped and the encoder values start coming from a robot with mass resting on
a floor with friction. Everything else in your code stays the same:
`TunerConstants`, `SwerveRequestFactory`, `DriverBindings`, the `Slot0Configs`
gains. There is no duplicated swerve logic anywhere.

```
      BEFORE                             AFTER
 ┌──────────────────┐              ┌──────────────────┐
 │ your swerve code │              │ your swerve code │   ← the same
 └────────┬─────────┘              └────────┬─────────┘
          │                                 │
   updateSimState()                   MarsSimGlue
   CTRE kinematics                          │
          │                                 ▼
          ▼                          Gazebo physics
   computed pose                     mass, friction, collisions
```

---

## The workflow

There are **four processes**, and only one is "the server".

### Your robot code brings up the NT4 server

Not us. That is not a simulation thing: it is how a real robot works. The
roboRIO runs the NetworkTables server and everything else — the dashboard,
Shuffleboard, AdvantageScope — connects as a client.

In simulation it is the same: `./gradlew simulateJava` brings up the server on
`localhost:5810`. **Your robot code owns the data**; MARS Simulation Studio,
the bridge and mars-desktop are its clients.

|  | NT4 server? |
|---|---|
| Your robot code | **Yes** |
| mars-desktop | no, client |
| The bridge | no, client |
| MARS Simulation Studio | does not speak NT4 |

That is why the bridge **waits** instead of dying when the server is not
there: you rebuild twenty times an afternoon and the physics has no reason to
restart with every build.

### The four processes

| | what it does |
|---|---|
| **mars-sim-server** | Gazebo without a window. The physics, at 250 Hz. Knows nothing about WPILib. |
| **mars-sim-gui** | The world's window. It *connects* to the server; it can be closed and reopened without touching the physics. |
| **mars-bridge** | The translator. The only one that speaks both languages. |
| **MARS Simulation Studio** | Launches the three with the right environment and kills them on close. |

The *Start* button launches them all.

### The startup order does not matter

1. **Simulation Studio** from mars-desktop's Sidebar → *Start simulation*. Your world shows up.
2. **Your robot**: `./gradlew simulateJava`.
3. **mars-desktop**: *Connect Sim*.

If you open the simulation first, the bridge waits. If you restart the robot
mid-match, it hooks back on by itself.

---

## The two data flows

**Telemetry — works without touching your code.** The true pose, the
simulation time, the real-time factor. Published to `/MARS/Sim/truthPose` and
to `/SmartDashboard/Field/Robot`.

Mind the name: `truthPose` is the **real** pose according to the physics.
Never feed it into your odometry. Compare your odometry against it — that is
what it is for.

**Hardware — this one needs the glue.** Without it, the simulation's engine
keeps zero torque, just like a real robot with the Driver Station off.

---

## The two motor modes

| | who closes the loop | what the glue publishes |
|---|---|---|
| drive | nobody, open loop | the applied voltage / 12 |
| steer | **the simulation's engine** | the module's target angle |

A 26:1 steer with a Kraken has too much torque for the time a message takes to
go and come back: closing that loop over the network does not work, and we
checked it at 50 Hz and at 250 Hz. A real TalonFX does not do it that way
either — it closes position **inside** the controller, at 1 kHz. The
simulation does the same.

---

## Making the numbers match

`MarsSimGlue` reads the reductions from `TunerConstants`, so that side keeps
itself in sync. But the world has its own, in
[`sim/worlds/gen_swerve.py`](../worlds/gen_swerve.py), and those have to be
kept by hand:

| gen_swerve.py | TunerConstants.java |
|---|---|
| `DRIVE_RATIO` | `kDriveGearRatio` |
| `STEER_RATIO` | `kSteerGearRatio` |
| `WHEEL_RADIUS` | `kWheelRadius` |
| `POS` | `kFrontLeftXPos` / `YPos` |

They are set to your robot's values. If they change there, change them here
and run `python sim/worlds/gen_swerve.py` again. A simulation with another
reduction gives velocities that are not yours, and tuning against that is
useless.

The module **names** (`fl`, `fr`, `bl`, `br`) have to match the ones in
`robot-map.json`. A misspelled name gives no error anywhere: the engine gets
nothing and stays still. It is the system's quietest failure, so if a module
does not move, look at the NetworkTables tree under `/MARS/Glue/`.

---

## Lockstep

In real time, the robot and the physics each run on their own clock. It
works, but every run comes out different (±10% measured with Offseason2026's
trajectory autotune) and a loaded PC degrades the physics instead of going
slower.

In **lockstep** the robot code sets the pace: WPILib's time is paused, and
every 4 ms step the glue sends the commands, the physics advances exactly that
step and the robot does not continue until it has the resulting state. The
same run gives the same result (±0.6% measured).

```powershell
# 1. the world (with real_time_factor 0) and the bridge in lockstep mode
.\simulationstudio\lockstep.ps1 -World worlds\offseason2026_lockstep.sdf `
    -RobotMap models\offseason2026\robot-map.json -Gui

# 2. the robot, in its project
$env:MARS_LOCKSTEP = "127.0.0.1:5811"; ./gradlew simulateJava
```

How it works, end to end:

| | what it does |
|---|---|
| glue (Java) | pauses WPILib's time; per step: reads the voltages, sends the commands over TCP, injects the state, `SimHooks.stepTiming(0.004)` |
| bridge | `--lockstep-port`: receives over TCP, publishes the command with `header.data["seq"]`, waits for the joints with that same seq |
| MarsLink | with commands carrying `seq`, each step waits in `PreUpdate` for the next one; publishes joints and pose stamped with it |

**Why TCP and not NT4:** NT4 delivers at most every 5 ms, i.e. ≥10 ms per
round trip for a 4 ms step. A local socket takes microseconds.

**The speed limit is Phoenix, not Gazebo.** The TalonFX's simulated firmware
runs on the wall clock and cannot be paused (measured: it takes 1.5 ms median
and 2.2 ms at most to react to a sensor change). Every step waits
`MARS_LOCKSTEP_SETTLE_MS` of wall time before reading the voltages:

| `MARS_LOCKSTEP_SETTLE_MS` | speed | effect |
|---|---|---|
| 2.5 (default) | ~1.1x | faithful: the TalonFX always got to react |
| 1.0 | ~2x | ~10% bias: sometimes it reads the voltage from one step back |
| 0.3 | ~3.4x | ~30%: too much artificial delay for tuning |

Gazebo alone, with this robot, gives ~3x real time; without Phoenix's firmware
in between, lockstep could get close to that.

## Sensor orientation and offsets

In its constructor the glue configures each TalonFX's and CANcoder's
`Orientation` and the CANcoder's `SensorOffset`, just like CTRE's
`SimSwerveDrivetrain`. Without that the CANcoder reports the raw position plus
the magnet offset: a module at 0° showed up at -135.7°. In real time the bug
stayed hidden by chance, because the glue starts with CTRE's sim while Gazebo
does not answer and that sim leaves the fields set. In lockstep Gazebo answers
from the first step.
