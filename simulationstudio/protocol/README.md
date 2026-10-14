# MARS simulation protocol

The contract between three processes. Freezing it first is what makes it
possible to write the engine in C++ and the bridge in Rust in parallel without
them stepping on each other.

- **`topics.toml`** — the single source of truth for topic names and the
  field's dimensions. It is not aspirational: the bridge's `build.rs` reads it
  at compile time and emits the constants, so renaming a topic here breaks the
  bridge's build.
- **`check.py`** — verifies the contract does not contradict itself: world
  names, field dimensions, actuator order and the topics cited in this README.
- **`robot-map.example.json`** — the translation between roboRIO channels and
  SDF joints. It is the only thing that changes between robots.

Status: telemetry (engine → app) and the `vendor` profile's hardware loop
(robot code ⇄ engine) are implemented and verified, with both control modes.
The `hal` profile is not there.

Current version: **0.1.0**. The bridge refuses to operate against an engine
whose major does not match, and checks it in the `/mars/meta/hello` handshake.

## The three hops

```
 robot code                      bridge (Rust)              engine (C++)
 ──────────                      ─────────────              ────────────
 simulateJava / roboRIO                                     gz-sim headless

        │  (2) HALSim WS               │  (1) gz-transport        │
        │  ws://localhost:3300         │  protobuf, local IPC     │
        │  JSON, robot = client   ◄────┤  bridge = subscriber ◄───┤
        │                              │                          │
        │  (3) NT4 :5810               │                          │
        └──► robot = SERVER     ◄──────┤                          │
                    ▲                  │
                    │                  │
              MARS app (client)  ──────┘
```

Three role decisions worth not revisiting lightly:

**The bridge is the WebSocket server, not the client.** The robot code loads
`halsim_ws_client` and connects towards us. The other way round also works,
but the robot code restarts every time the team compiles, and the app is the
long-lived process. Having the ephemeral one be the one that connects means
restarting robot code does not tear the simulation down.

**The NT4 server is not ours.** The robot code brings it up on `:5810`, like
on a real robot. The bridge and the app are both clients. This keeps the
simulation indistinguishable from a real match from the app's point of view:
the same NT4 client in `src-tauri/src/nt4/` serves both cases, without a "sim
mode" code branch.

**The engine speaks neither NT4 nor WebSocket.** Only gz-transport. All the
glue lives in the bridge. That way the engine can be tested alone, with a
script that publishes actuators to it and reads joints, without bringing up
any of WPILib.

## The two profiles

Here is the detail that defines the project: **the HALSim WS protocol does not
cover CAN motors.** It covers PWM, DIO, AnalogIn, Encoder, Relay, SimDevice and
DriverStation — everything native to the roboRIO. A TalonFX or a SparkMax is
simulated by its vendor's sim API (`TalonFXSimState`, `SparkSim`), which lives
inside the robot's process and never shows up on wpilibws.

### `hal` profile — transparent

For mechanisms on PWM and sensors wired to the RIO. Zero changes to the robot
code: load the extension and that is it. It is the ideal case and the one to
use whenever possible.

### `vendor` profile — with glue

For drivetrains on CAN, which is where almost all of FRC is today. It needs
about 50 lines in the robot code that, in `simulationPeriodic`:

1. read what the vendor is asking of the motor and publish it: the duty on
   `/MARS/Glue/out/<name>/duty`, or the angle on
   `/MARS/Glue/out/<name>/setpoint` if that actuator closes position;
2. read `/MARS/Glue/in/<name>/position` and `/MARS/Glue/in/<name>/velocity`
   and inject them into the vendor with `setRawRotorPosition` /
   `setRotorVelocity`.

**Which of the two it publishes** is decided by the actuator's control mode,
declared in the SDF's `<actuator>` and repeated in the robot map. A motor with
its own loop --- a swerve steering module --- goes in `position` mode and the
simulation's engine closes the loop, just like the real TalonFX. See
[sim/bridge/README.md](../bridge/README.md).

It is intrusive, and it is the price of vendors not exposing their sim outside
their process. The glue goes in the robot's repository, not here, but its
contract is in `topics.toml` under `[[glue]]`.

A robot can use both profiles at once: `vendor` for the swerve and `hal` for
an elevator on PWM. The `robot-map` declares it per robot, and the actuators
carry their `hal` block anyway so they can migrate without rewriting the map.

## Who owns the time

**Nobody, and you need to know that.** The wpilibws protocol has no clock
message: there is no way for the simulation to impose its time on the robot's
HAL. The two clocks run on wall time, in parallel, unsynchronized.

In practice it works if and only if Gazebo holds a real-time factor of 1.0.
That is why the RTF is published on `/MARS/Sim/realTimeFactor` and is not a
decorative number: it is the loop's validity metric. Held below ~0.95, the
robot code is running its 20 ms cycle against physics that run slower, and any
PID gain tuned there will not transfer to the real robot. The app has to warn
about it visibly, not hide it in a log.

This puts a hard ceiling on the model's detail: if the robot is so heavy to
simulate that it does not reach 1.0, simplify it, do not lower the RTF.

## Conventions that bite

**Axes.** Gazebo uses ENU with Z up and yaw CCW positive from X. WPILib uses
the same yaw sense but measures from the axis pointing at the field's
opposite wall, and its origin is the alliance's corner. The bridge does the
whole conversion (origin and rotation) so neither the engine nor the glue
needs to know which alliance we are.

**Units.** In gz-transport everything goes in SI and radians, always. The
conversion to degrees and to WPILib's conventions happens once, at the
bridge's NT4 edge. A value in degrees inside the engine is a bug.

**Reductions.** `gearRatio` is a reduction: motor turns per output turn.
Encoders report on the motor's shaft, before the reduction, which is how the
integrated ones in Falcon and Kraken do it.

**Current limit.** `currentLimit` is an attribute of the SDF's `<actuator>` and
lives only in the engine: the bridge does not need it because it changes no
message. It is the stator current in amperes, and without it the DC model
delivers the whole stall current --- 366 A on a Kraken, i.e. several times the
grip available to a drive wheel. The right number is the slip current,
`I_slip = mu * m * g / wheels * r_wheel / (Kt * reduction)`, the same one CTRE
calls `kSlipCurrent`. It also clips negative current, so it also turns back-EMF
braking into real motor braking.

**The wheel radius is not in the robot map.** It comes from the SDF's
collision geometry, which is the only one the physics respects. Duplicating it
guarantees that one day they diverge and the simulated robot drives
differently from what its odometry says.

## Out of scope in 0.1.0

Deliberately, so the first version can close:

- **Cameras and vision.** Needs `gz-sensors` with rendering and OGRE2. The
  environment already has them installed as a dependency, but the engine does
  not load those plugins. When the time comes, it is a new profile, not a
  protocol change.
- **Game pieces and scoring.** The world is the robot and the floor.
- **Multiple robots.** The `/mars/` namespace carries no robot index yet.
  Adding one later is a major change.
- **Dynamic message introspection.** The conda-forge package's
  `gz-msgs12.gz_desc` descriptor does not parse (protobuf mismatch), so
  `gz topic --echo` on arbitrary types does not work in this environment.
  That is why the protocol sticks to standard `gz.msgs` types: C++'s static
  pub/sub does not go through the descriptor and is not affected.
