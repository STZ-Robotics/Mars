# MARS library

A Java framework for FRC robot code, distributed as a WPILib vendordep. It gives
every subsystem the same shape — hardware behind an interface, state in a data
object, behavior in small requests — so subsystems are easy to read, test,
simulate and swap.

## Install

In VS Code with the WPILib extension: *WPILib: Manage Vendor Libraries → Install
new library (online)*, and paste

```
https://stz-robotics.github.io/Mars/Mars.json
```

Projects created from MARS Desktop already include it. API reference:
<https://stz-robotics.github.io/Mars/api/>.

## What it gives you

### Subsystems with swappable hardware

A `ModularSubsystem` is built from three pieces:

- **`Data`** — what the hardware read this loop, as plain public fields.
- **`IO`** — the hardware layer. It has a real, a simulated and a fallback
  implementation; the subsystem never knows which one it has.
- **`Request`** — one loop of behavior: given the latest data and the IO, do
  something and report an `ActionStatus`.

```java
public class Elevator extends ModularSubsystem<ElevatorData, ElevatorIO> {
    public Elevator(ElevatorIO io) {
        super(SubsystemBuilder.<ElevatorData, ElevatorIO>setup()
            .key(KeyManager.ELEVATOR_KEY)         // its NetworkTables table
            .hardware(io, new ElevatorData())
            .request(ElevatorRequests.hold()));   // what it does by default
    }

    @Override
    public void absolutePeriodic(ElevatorData inputs) {}   // runs every loop, whatever the request
}
```

The subsystem reads its inputs, runs the current request and publishes its
status every loop. Commands come from the requests:

```java
elevator.runRequest(() -> ElevatorRequests.manual(stick));          // until interrupted
elevator.runRequestUntilDone(() -> ElevatorRequests.goTo(1.2));     // until the request reports done
```

### Real, simulated or replayed

`Environment` holds the run mode (`REAL`, `SIM`, `REPLAY`) and `Injector` builds
the matching IO:

```java
ElevatorIO io = Injector.createIO(
    Manifest.HAS_ELEVATOR,       // false: a fallback that does nothing
    ElevatorIOFallback::new,
    ElevatorIOReal::new,         // in REAL; if it throws, the fallback instead
    ElevatorIOSim::new);         // in SIM and REPLAY
```

A subsystem on a fallback IO skips its loop entirely, so a half-built robot runs
safely with any module switched off.

### Diagnostics

- **`ActionStatus`** — every request reports `ok()`, `warning(...)`,
  `error(...)` or a team-defined `ModuleColorCode`, each with a severity, a
  message and an LED pattern. The status is published per subsystem and shown
  in MARS Desktop's Subsystems page.
- **`AlertRegistry`** — every subsystem's latest non-OK status in one place, for
  a dashboard or a pre-match check.
- **`MARSWatchdog`** — times each subsystem's loop and warns when it overruns
  (rate-limited, so a slow subsystem does not flood the Driver Station).
- **`GCSConsole`** — readable, timestamped console output for boot, mounts,
  requests and errors, with a crash report that shows the cause chain.

### Sharing state

- **`Blackboard`** — typed values one subsystem writes and another reads,
  without either importing the other. Writing `null` removes a value.
- **`Node`** — background processing that publishes a message every loop
  (vision, sensor fusion), ticked from the robot container.

### Controllers

`ControllerOI` describes a gamepad by position — sticks, bumpers, the four face
buttons, D-pad, triggers — with `XboxOI` and `PS5OI` implementations. Bindings
written against it work with either controller.

### Pit tests

A `TestRoutine` is a command sequence with assertions (`assertLessThan`,
`assertGreaterThan`, `assertTrue`) that log PASS or FAIL. `TestScheduler.runTest`
wraps one with start and finish logging, and it runs in Test mode.

```java
@MARSTest(name = "Elevator range")
public class ElevatorCheck extends TestRoutine {
    public Command getRoutineCommand() {
        return run(ElevatorRequests.goTo(1.0), elevator)
            .andThen(delay(1.5))
            .andThen(assertLessThan(calculateError(1.0, elevator::height), 0.02,
                "the elevator did not reach 1 m"));    // height(): a getter the subsystem declares
    }
}
```

## Building

```bash
cd lib
./gradlew build      # compile and test
```

### Releasing (maintainers)

The version is in `Mars.json` (`version` and the `Mars` dependency's version).
Bump both, run `./gradlew publish` — which writes the jars into `lib/maven/`,
committed with the change — and push to `main`. The `pages` workflow publishes
`Mars.json` and `maven/` to <https://stz-robotics.github.io/Mars/>, after
`node scripts/check-vendordep.mjs` confirms the version is in `maven/`. The `lib`
workflow builds and tests every change and uploads what `publish` writes, for a
machine that cannot build the library itself.

Keep stable, because every installed project depends on them: the vendordep URLs
(`…/Mars.json`, `…/maven/`), the repository name `STZ-Robotics/Mars` that those
URLs come from, and the vendordep uuid `8b9c1d2e-3f4a-5b6c-7d8e-9f0a1b2c3d4e`.
