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

Nothing is built yet. This folder holds the plan and the reference material.

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
  planner/    stage 1 — the analytic optimizer: a time-optimal trajectory in
              seconds, from the robot model (the role Choreo plays today)
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

- **The solver for stage 1.** Writing a nonlinear solver from zero is a
  project of its own; Sleipnir (BSD-3) is the one Choreo uses. Options: use it
  as a math library, write a narrower solver of our own, or start stage 1 with
  a simpler method and invest in stage 2.
- **The trajectory format.** Ours, carrying what Choreo's cannot: mechanism
  events tied to the path, robustness margins, the simulation it was
  validated against.
- **Where the editor lives.** Its own app, or a tab inside MARS Desktop, which
  already has the 3D field, the swerve views and the NT4 client.
