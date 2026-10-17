# AresLib

The robot side of Ares, as a **MARS Feature**: it reads the Ares project
deployed with the robot code, follows its trajectories and builds its autos
out of the robot's own commands.

It is a Feature and not a vendordep on purpose. It installs the way the rest
of MARS does (MARS Desktop, `workspace-mars/features/`), it can lean on MARS,
and it lives next to the planner, so the file format and the code that reads
it change in the same commit.

## Install

In MARS Desktop, **Project > Packages > Manual Install**, paste

```
https://stz-robotics.github.io/Mars/ares/MarsFeature.json
```

and press **INSTALL FROM URL**. (It is also in the verified catalog.) The
robot project needs WPILib's command framework, which every MARS project has;
`CtreSwerve` also needs the Phoenix 6 vendordep, which a CTRE swerve already has.

## The project goes in the deploy folder

Keep the Ares project (the `.robot.json` and its `paths/`, `trajectories/`,
`autos/`, `ares-index.json`) in **`src/main/deploy/ares/`** and open that
`.robot.json` in Ares. A deploy then carries what you generated, and AresLib
reads it from `/home/lvuser/deploy/ares` (or the same folder in simulation).
`ares-index.json` is rewritten by the app on every save: it is how the robot
knows the branches, variants and autos without listing folders.

## Wiring it (CTRE swerve)

```java
Ares ares = new Ares(
    CtreSwerve.of(drivetrain),        // the Tuner X CommandSwerveDrivetrain
    new Ares.Config()                 // defaults are fine to start
        .withGains(new AresController.Gains(3, 0, 0), new AresController.Gains(3, 0, 0)));

// Register BEFORE building autos: they look these up as they are built.
ares.registerCommand("shoot", superstructure.shoot());
ares.registerCommand("intake", intake.deploy());          // also an event marker's name
ares.registerCondition("hasPiece", indexer::hasPiece);    // if steps and branches

SendableChooser<Command> autos = ares.autoChooser();     // every auto, plus None
SmartDashboard.putData("Auto", autos);
```

**The gains.** Leave `withGains` out and AresLib reads `gains.json` from the
project: what the Tune tab's "Apply to robot" writes after tuning, so a deploy
carries the tuned gains with no code to change. `withGains` in the code wins
over the file. Either way it prints which gains it runs with and from where,
and publishes them on `/Ares/Gains`.

Not CTRE? `AresDrive.of(pose, robotSpeeds, resetPose, setpoint -> ..., subsystem)`
takes four lambdas. The setpoint has the speeds (field and robot frame) and
each wheel's force (field and robot frame) to feed forward however your
modules take it.

## What it does

- **Follows with the forces.** Every sample says what force each wheel puts on
  the carpet; `CtreSwerve` passes them as `WheelForceFeedforwardsX/Y`, so the
  PID only corrects what the forces missed. The gains can be lower than
  PathPlanner's 5.
- **Modules matched by position.** It pairs the `.robot.json`'s modules with
  the drivetrain's by where they are, so the order does not have to match,
  and raises an alert when they are not the same robot (a stale
  `TunerConstants` or `.robot.json`).
- **Alliance flip** on red, decided when each path starts: `ROTATIONAL`
  (2026) by default, `MIRRORED` with `withSymmetry`. A mirror trades the
  left wheels' forces for the right ones'.
- **Event markers** run the command built on them in Ares (Paths → the
  marker → "Build a command": named commands, waits, groups, as PathPlanner's
  markers carry one) or, without one, the command registered under their
  name, inside the path follower; a zone's command is cut when the zone
  ends. Either way `ares.event("intake")` is true while it lasts, to react
  with `.onTrue(...)` / `.whileTrue(...)`.
- **Branches.** At the waypoint where a branch leaves, if its condition holds,
  the robot carries on along the branch, without stopping. In an auto, a path
  followed by one of its own branches is driven only up to where the branch
  leaves.
- **"?" stretches (pathfinding).** If the robot is where Ares expected, it
  follows Ares's estimate, which is a real trajectory. If not, it hands over
  to the pathfinder:
  - with a **navgrid** (drawn in the Field tab, deployed as `navgrid.json`),
    `GridPathfinder`: A* around its blocked cells from where the robot
    actually is (the same search as the app's "Test route"), the corners
    driven with a profile that slows for each one. On red it searches in
    blue's frame and flips the corners back;
  - without one, `StraightPathfinder`: a straight profiled drive that avoids
    nothing;
  - or anything you plug in with `withPathfinder` (PathPlanner's AD*, see
    `AresPathfinder`). `navgrid.json` is PathPlanner's format, so the same
    file works for its pathfinder if copied to `deploy/pathplanner/`.
- **Knocked off the trajectory** (more than 0.5 m for 0.2 s: a hit, a stall),
  the pathfinder takes the robot to where the trajectory will be a second
  later and the path goes on from there, at most 3 times per path; it never
  rejoins past a "?" stretch or a branch point. `withReplan(...)` tunes it, a
  tolerance of 0 turns it off. `/Ares/Replans` counts them.
- **Autos**: path, wait, command (and "alongside", which runs with everything
  after it), if/else on a condition, nested autos, **together** (lists at once:
  until all end, the first ends, or list 1 ends: WPILib's parallel, race and
  deadline), and **when** (armed where it sits; once a time since the auto
  started comes, the robot enters a zone, or a condition holds, its steps run
  alongside the rest). Two things that need the same subsystem at once (two
  paths together) are an alert and only the first runs, not a crash. An auto that starts at a
  known pose resets odometry there (`withResetPoseAtAutoStart(false)` to not).
  `ares.startPose(auto)` gives that pose for placing the robot before a match.
- **Telemetry** under `/Ares` on NetworkTables, for Ares's Live tab (or
  AdvantageScope): the active path (`Path`, Pose2d[]), where the trajectory
  says to be (`Target`) and where the robot is (`Robot`, every loop), the
  error, the time, the active events, the replans, the speeds commanded and
  measured (`CommandedSpeeds`, `MeasuredSpeeds`: field vx, vy, omega) and the
  gains in use (`Gains/`).
- **Never stops the robot from booting.** A missing or broken project, an
  ungenerated path, a command or condition nobody registered: an alert on the
  dashboard and a message in the Driver Station, not an exception.

Also: `ares.path("Hub run")`, `ares.path("Hub run", "wide")` (a variant),
`ares.section("Hub run", "intake")`, `ares.split("Hub run", 1)`.

## Characterization, with no logs and no SysId

```java
AresCharacterization.publish(CtreSwerve.of(drivetrain).characterizable(TunerConstants.FrontLeft));
```

Three routines, as dashboard buttons under `Ares Characterize/`, that measure
on the robot and publish as they run under `/Ares/Characterize/<routine>`
(the team's DriveCharacterizationCommand, generalized):

- **Drive**: spins in place stepping the drives from 1 to 6 V both ways and
  fits |V| = kS + kV·rps (rotor rps, Tuner X's units); the gyro gives the
  wheel radius too. About 1.5 m of room.
- **Steer**: the robot stays put, the modules turn stepping the steers from
  0.3 to 2 V: kS and kV of the steer (module rps).
- **WheelRadius**: spins slowly; the gyro's angle against how far the wheels
  rolled is their true radius.

Ares's Measure tab connects over NetworkTables, presses them, draws the points
and the line as they come, compares with TunerConstants, and saves the results
(Tune starts from them). Results also land in Preferences.

## Building and testing

```bash
./gradlew test          # trajectories, flips, and the commands on the real scheduler
./gradlew publish       # writes maven/, which is committed
```

The tests drive a perfect simulated drivetrain through the fixture project in
`src/test/resources/project/` (made with `ares plan`): ending where the path
ends, the feedback pulling it back, the red alliance, markers and zones,
branches taken and not, an auto that leaves at a branch point, the
pathfinder taking over when the robot is knocked off the estimate, the
forces handed over in the drivetrain's order, and the grid pathfinder driving
around a wall without its center ever entering a blocked cell, on both
alliances.

## Releasing

The version is in `MarsFeature.json` (both `version` and the dependency's).
Bump it, `./gradlew publish`, commit `maven/`. The `pages` workflow copies
`maven/` and `MarsFeature.json` to `https://stz-robotics.github.io/Mars/ares/`
when it reaches `main`, and checks the jar is there.

`ares-index.json` carries `"format": 1`. A change the old AresLib cannot read
bumps it; AresLib refuses a format it does not know with a message, rather
than half-reading it.
