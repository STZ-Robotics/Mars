# The change in `CommandSwerveDrivetrain.java`

Two places. Nothing else in your code changes.

## 1. The field and the constructors

```java
+   MarsSimGlue m_marsGlue;
```

In **each** of the three constructors, inside the `if` you already have:

```java
    if (Utils.isSimulation()) {
+       m_marsGlue = new MarsSimGlue(this);
        startSimThread();
    }
```

## 2. The simulation thread

```java
    private void startSimThread() {
        m_lastSimTime = Utils.getCurrentTimeSeconds();

        m_simNotifier = new Notifier(() -> {
            final double currentTime = Utils.getCurrentTimeSeconds();
            m_lastSimTime = currentTime;

-           double deltaTime = currentTime - m_lastSimTime;
-           updateSimState(deltaTime, RobotController.getBatteryVoltage());
+           // Gazebo solves the physics when MARS Simulation Studio is running;
+           // if not, the glue calls updateSimState on its own. It computes the
+           // delta itself, so it is no longer needed here.
+           m_marsGlue.update();
        });
        m_simNotifier.startPeriodic(kSimLoopPeriod);
    }
```

`RobotController` may end up unused in this file. It is only a compiler
warning, but the import is worth removing.

## Why this and not something else

`updateSimState` is where CTRE simulates the modules: it models the motors,
applies their gains and integrates the pose with the swerve's kinematics. It
is a *kinematic* simulation — the robot goes exactly where the equations say
it would, with no mass to accelerate, no wheels to slip and no walls to hit.

Replacing that call is enough because it is the only point where the
hardware's simulated state comes in. Everything above it — the
`SwerveRequestFactory` requests, Phoenix's steer loop, the odometry, your
controller binding — stays the same, because the encoders and the gyro keep
giving values; only now they come from a robot with mass resting on the floor.

## Working without the simulation

`m_marsGlue.update()` detects whether MARS Simulation Studio is publishing. If
it is not, it calls `updateSimState` itself and everything behaves as before
installing anything. Starting or closing MARS Simulation Studio mid-session
works without restarting the robot, and it says so on the console:

```
[MARS] simulation connected; the physics is in charge
[MARS] simulation absent; going back to CTRE's
```

It looks at the data's **heartbeat**, not its value: a stopped robot publishes
zeros that cannot be told apart from "nobody ever published", and with that the
robot would freeze on startup with nothing explaining it.

## If nothing happens: the diagnostics tree

The glue publishes its own state to `MARS/Glue/diag`. Look at that node in
mars-desktop's NetworkTables tree and read the table below. Each row rules out
a different stretch of the path, so the first one that fails is the cause.

| in `MARS/Glue/diag` | what it means |
|---|---|
| the node does not exist | The class **was not built**. The `if (Utils.isSimulation())` was not entered, or the running robot predates the rebuild. |
| `created = true`, `ticks` **does not go up** | It was built but the thread does not run: `startSimThread()` was not called, or the `Notifier` died. Look at `error`. |
| there is an `error` | `update()` threw. The text and the stack are on the robot's console. |
| `ticks` goes up, `connected = false` | The glue is fine; **it is the simulation that does not answer**. Check that MARS Simulation Studio is started and that the bridge says `NT4 connected`. |
| `ticks` goes up and `connected = true` | The loop is closed. If it still does not move, it is a naming or units problem. |

`created` also shows up on the robot's console as `[MARS] glue created`.

## How to check it works

With the simulation running and the robot in teleop:

1. **The robot moves in MARS Simulation Studio's window.** If not, look at the
   NetworkTables tree under `/MARS/Glue/` — the most common failure is a module
   name that does not match the robot-map.
2. **Floor it from a standstill.** The wheels slip and the odometry runs ahead
   of the true pose. Comparing `/MARS/Sim/truthPose` against your odometry's
   pose is exactly what this simulation exists to show you, and what no
   kinematic simulation can.
3. **Hit something** (once the world has a perimeter). With `updateSimState`
   it goes through; with this it stops.

## Coupling

`kCoupleRatio = 3.375` from `TunerConstants`: on an MK4, turning the azimuth
drags the drive motor along. Gazebo does not model it — its two joints are
independent — so the glue adds it when converting to rotor units.

Without it, the drive encoder would not move when turning the modules and the
simulated robot's odometry would come out **cleaner** than the real one's right
in the maneuver where it behaves worst. A simulation that lies in your favor
is worse than none.
