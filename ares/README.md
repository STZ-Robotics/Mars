# Ares

Trajectory planning and optimization for STZ Robotics, built on MARS and its
physics simulation.

PathPlanner and Choreo plan against a model of the robot: a point with a
traction limit on a flat 2D field. Ares plans against the robot itself — the
Gazebo model in `simulationstudio/`, driven by the real robot code in
lockstep — so a trajectory is judged by what the robot actually does with it:
whether it slips, whether it clears the HUB, how it takes a ramp, how far the
controller drifts from it, and whether the mechanisms are where they need to
be when they need to be.

It is our team's tool, not a product for all of FRC. That decides a lot: it
can assume MARS, our robots and our simulation, and it does not have to be
compatible with anyone's files.

## Status

`core/` and `planner/` exist, with tests. There is a terminal entry point
until the app exists:

    cargo run --release --bin ares -- time examples/robots/offseason2026.json examples/paths/hub-run.json
    cargo run --release --bin ares -- plan examples/robots/offseason2026.json examples/paths/hub-run.json -o hub-run.traj.json

Planning is two stages:

1. **`ares time`** (core): Ares' own time-optimal solver follows the spline
   through the waypoints as fast as the robot can. Milliseconds; the best
   timing for that exact curve.
2. **`ares plan`** (planner): stage 1 warm-starts a full nonlinear program on
   [Sleipnir](https://github.com/SleipnirGroup/Sleipnir) (the solver under
   Choreo, built from source by CMake). The curve is free; waypoints are
   constraints. On `hub-run` it is 14% faster than the spline, in ~150 ms.

What both stages model that PathPlanner and Choreo do not:

- **One `robot.json` per robot**, shared by every project, with the physics a
  model needs (mass, inertia, center of mass height, the motors from
  MarsLink's table, their current limit, the battery, the wheels' grip) and
  the 3D model the app draws.
- **The motor as it is**: current limit and back-EMF along each wheel, so
  pushing fades toward free speed and braking does not. Choreo caps torque
  only; PathPlanner caps one acceleration for the whole robot.
- **Load transfer.** With the center of mass height, accelerating moves
  weight to the trailing wheels, their grip follows, and no wheel is asked to
  carry negative load: the robot never tips.
- **Rotation is part of the path.** Translation, rotation and the curve all
  draw from the same grip.
- **The bumper**, not a point, against the field walls and keep-out circles.
- **Every sample says what each module does**: speed, angle, force, load,
  the grip in use and the current the motor draws. Not just how fast, but why.

App: not started. Gazebo stage: not started.

## Reference

`reference/` holds PathPlanner (MIT) and Choreo (BSD-3), cloned for study. It
is ignored by git. Ares does not build on them; if a piece of either is ever
copied in, it keeps its license notice.

| | PathPlanner | Choreo |
|---|---|---|
| GUI | Flutter / Dart | Tauri + React + TypeScript |
| Trajectory | Splines + a motion profile with constraints | Time-optimal NLP (TrajoptLib on the Sleipnir solver, C++) |
| Robot side | PathPlannerLib (Java/C++/Python) | ChoreoLib (Java/C++/Python) |
| Robot model | Max velocity/acceleration, module limits | Mass, MOI, wheel radius, motor torque, a friction coefficient |
| Field | 2D image + navgrid | 2D image + keep-out zones |

Choreo is the closer relative: same stack as MARS Desktop (Tauri + React +
Rust) and a real optimizer underneath. Its limit is the model, not the solver.

## Proposed architecture

Open for discussion; nothing here is decided.

```
ares/
  app/        Tauri + React: the editor, on the MARS 3D field (Field 3D's assets)
  core/       Rust: the file format, the robot model, the field, constraints
  planner/    the analytic optimizer: core's timing warm-starts the full NLP
              on Sleipnir (the role Choreo plays today)
  refiner/    stage 2 — Gazebo in the loop: runs the trajectory in lockstep
              against the real robot code and optimizes what the analytic
              model cannot see (slip, terrain, collisions, tracking, timing)
  lib/        the robot side, inside the MARS library: follower, events,
              mechanism hooks
```

The two stages are the point. Stage 1 is fast and always available; stage 2
is slow (a 15 s auto is ~14 s per evaluation at lockstep's ~1.1x) and is what
nobody else can do. Stage 2 starts from stage 1's answer, so it refines
instead of searching blind.

## Before stage 2 means anything

Stage 2 optimizes against the simulation, so the simulation has to match the
robot. The first piece of work is calibration: replay a real log in lockstep
and fit Gazebo's parameters (friction, slip current, inertia) until the
simulated path matches the real one, and report the remaining error. A
trajectory optimized against an uncalibrated simulation is optimal for a robot
that does not exist.

## Decisions pending

- ~~The solver for stage 1~~: our own. Today it times a given path optimally;
  shaping the path itself (where the curve goes, not only how fast it is
  driven) is the next step, on top of the same physics.
- **The trajectory format.** Ours, carrying what Choreo's cannot: mechanism
  events tied to the path, robustness margins, the simulation it was
  validated against.
- ~~Where the editor lives~~: its own app, looking and working like MARS
  Desktop.
