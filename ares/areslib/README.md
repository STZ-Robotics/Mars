# AresLib

The robot side of [Ares](../README.md). AresLib reads the Ares project deployed
with the robot code, follows its trajectories with the planned force on every
wheel, and builds the autos out of the robot's own commands. It is a MARS
Feature: it installs into a MARS project from MARS Desktop.

## Install

In MARS Desktop, **Project → Packages → Manual Install**, paste

```
https://stz-robotics.github.io/Mars/ares/MarsFeature.json
```

and press **Install from URL** (it is also in the verified catalog). The robot
project needs WPILib's command framework, which every MARS project has.
`CtreSwerve` also needs the Phoenix 6 vendordep, which a CTRE swerve already has.

## The Ares project goes in the deploy folder

Keep the Ares project (the `.robot.json` with its `paths/`, `trajectories/`,
`autos/` and `ares-index.json`) in **`src/main/deploy/ares/`** and open that
`.robot.json` in Ares. Every deploy then carries what you generated, and AresLib
reads it from the deploy folder on the robot and in simulation.

## Setting it up (CTRE swerve)

```java
Ares ares = new Ares(
    CtreSwerve.of(drivetrain)                                 // the Tuner X CommandSwerveDrivetrain
        .withModuleConstants(TunerConstants.FrontLeft),       // checks the .robot.json against it
    new Ares.Config()
        .withGains(new AresController.Gains(3, 0, 0), new AresController.Gains(3, 0, 0)));

// Register before building autos: they look these up as they are built.
ares.registerCommand("shoot", superstructure.shoot());
ares.registerCommand("intake", intake.deploy());          // also an event marker's name
ares.registerCondition("hasPiece", indexer::hasPiece);    // for if steps and branches

SendableChooser<Command> autos = ares.autoChooser();     // every auto, plus None
SmartDashboard.putData("Auto", autos);
```

**Gains.** Without `withGains`, AresLib uses the gains Ares's Tune tab saved in
the project (`gains.json`), so a deploy carries tuned gains with no code change.
Gains set in code win over the file. The gains in use are printed at boot and
published under `/Ares/Gains`.

**Robot check.** With `withModuleConstants`, AresLib compares the `.robot.json`
(gear ratio, wheel radius, current limit) with `TunerConstants` and raises an
alert naming every value that differs, and every path that asks for more speed
than the drivetrain reaches at 12 V. Setting `maxSpeedFraction` in the
`.robot.json` (about 0.8) leaves headroom for the feedback.

**Other drivetrains.** `AresDrive.of(pose, robotSpeeds, resetPose, setpoint -> ..., subsystem)`
takes four lambdas. Each setpoint carries the speeds and every wheel's force,
in the field and robot frames, to feed forward however your modules take them.

## What it does

- **Follows with the forces.** Each trajectory sample says what force each wheel
  puts on the carpet, and `CtreSwerve` feeds them forward, so the feedback only
  corrects what the forces missed.
- **Matches modules by position**, so their order does not have to agree, and
  raises an alert when the `.robot.json` and the drivetrain are not the same
  robot.
- **Flips for the red alliance** when each path starts: rotational symmetry by
  default, mirrored with `withSymmetry`. The field's own symmetry comes from the
  project.
- **Event markers** run the command built on them in Ares, or the command
  registered under their name. A zone's command is cut when the zone ends.
  `ares.event("intake")` is a trigger that is true while the event lasts.
- **Branches.** Where a branch leaves a path, if its condition holds, the robot
  carries on along the branch without stopping.
- **Pathfinding stretches.** A path segment marked as unknown is driven from
  wherever the robot actually is: around the project's navigation grid when
  there is one (`GridPathfinder`), in a straight line otherwise, or with your own
  `AresPathfinder`.
- **Recovers when knocked off course.** More than 0.5 m off for 0.2 s (a hit, a
  stall), the robot pathfinds to where the trajectory will be a second later and
  carries on, up to 3 times per path. `withReplan(...)` tunes it; a tolerance of
  0 turns it off.
- **Autos**: paths, waits, commands, if/else on a condition, nested autos,
  steps that run together (all, the first to end, or until one ends) and steps
  armed on a time, a zone or a condition. An auto that starts at a known pose
  resets odometry there, and `ares.startPose(auto)` tells you where to place
  the robot.
- **Telemetry** under `/Ares`: the active path, the target and actual pose,
  the error, the active events, the replans, commanded against measured speeds,
  and the gains — what Ares's Live tab draws.
- **Never stops the robot from booting.** A missing or broken project, an
  ungenerated path, or a command nobody registered becomes a dashboard alert and
  a Driver Station message, not an exception.

Paths can also be used piece by piece: `ares.path("Hub run")`,
`ares.path("Hub run", "wide")` (a variant), `ares.section("Hub run", "intake")`,
`ares.split("Hub run", 1)`.

## Going somewhere by itself

Drive to a pose around the navigation grid, from wherever the robot is.
`pathfindTo` takes poses in blue's coordinates, as paths are drawn, and flips
them on red; `pathfindToField` takes field coordinates and never flips, for a
goal the code already computed for its alliance.

```java
driver.a().whileTrue(ares.pathfindTo(new Pose2d(1.8, 7.6, Rotation2d.fromDegrees(-90))));
driver.b().whileTrue(ares.pathfindToField(() -> hubSpotFor(alliance()), limits));
ares.pathfindThenFollow("Score");   // to where Score starts, then Score
```

A goal inside a blocked cell is reached from the nearest open one.

### Obstacles that come and go

Boxes given by two opposite corners, in field coordinates — other robots seen by
vision, for example. The pathfinder keeps the robot clear of them and finds a
new way when they block the current one.

```java
ares.setDynamicObstacles(List.of(Pair.of(new Translation2d(4.5, 3.5), new Translation2d(5.4, 4.4))));
ares.setDynamicObstacles(List.of());   // clear them
```

### Paths made on the robot

A smooth path through poses decided in code, for short moves decided in the
moment. Blue's coordinates, flipped on red.

```java
ares.pathThrough(Rotation2d.kCW_90deg, start, via, end);      // starts at the first pose
ares.pathFromHere(Rotation2d.kZero, via, end);                 // starts wherever the robot is
ares.pathFromHere(limits, heading, () -> posesFromVision());   // poses decided when it starts
```

## Autos with triggers, in code

Instead of the Autos tab's list of steps, bind commands to what the paths do:

```java
var r = ares.routine("Two piece");
var main = r.path("Main");
var alt = r.path("Alt");
r.active().onTrue(main.resetOdometry().andThen(main.cmd()));
main.atTime("intake").onTrue(intake.deploy());     // a marker drawn in Paths
main.atTime(1.2).onTrue(shooter.spinUp());         // seconds into the path
main.done().onTrue(alt.cmd());                     // ended, not cut short
alt.atPose(new Pose2d(5, 2, Rotation2d.kZero), 0.3).onTrue(arm.raise());
alt.done().onTrue(shoot());
chooser.addOption("Two piece", r.cmd());
```

## Hot reload and the auto chooser

While the Ares app is connected, every path it generates and every auto it saves
is sent to the robot and replaces what AresLib has, without a deploy. It never
happens with a field connected, and it lasts until the robot restarts — deploy
to keep the changes. Turn it off with `withHotReload(false)` or in the app's
Settings.

`ares.autoChooser("Qualifiers")` lists one folder of the Autos tab. While the
robot is disabled, the selected auto and where to place the robot for it are
published under `/Ares/Auto/` and drawn on the dashboard.

## The project's variables in code

With *Settings → Project → Variables in the robot code* turned on, the Ares app
writes the Variables tab as a Java class: `AresVars.reach` is a `Distance`,
`AresVars.Poses.speaker` a `Pose2d`.

## Drivetrain characterization

```java
AresCharacterization.publish(CtreSwerve.of(drivetrain).characterizable(TunerConstants.FrontLeft));
```

Three routines appear as dashboard buttons under `Ares Characterize/`:

- **Drive** — spins in place stepping the drive voltage and fits kS and kV; the
  gyro gives the wheel radius too. Needs about 1.5 m of room.
- **Steer** — the robot stays put while the modules turn: kS and kV of the steer.
- **WheelRadius** — spins slowly and compares the gyro's angle with how far the
  wheels rolled.

Ares's Measure tab runs them over NetworkTables, plots the results as they come,
compares them with `TunerConstants` and saves them for the Tune tab.

## Building and testing

```bash
./gradlew test       # trajectories, alliance flips and the commands on the real scheduler
./gradlew e2eTest    # plans with the real planner, then follows it on a simulated CTRE swerve
```

The version is in `MarsFeature.json`. Releasing: bump it, run `./gradlew publish`
and commit `maven/`; the `pages` workflow publishes it to
`https://stz-robotics.github.io/Mars/ares/`.
