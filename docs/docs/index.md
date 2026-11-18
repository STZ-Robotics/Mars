# MARS

**MARS** is a toolkit for FRC robot software from STZ Robotics.

- **[MARS library](https://github.com/STZ-Robotics/Mars/blob/main/lib/README.md)** — a WPILib
  vendordep that gives every subsystem the same shape: hardware behind
  swappable IO layers, state in a data object, behavior in requests. Real,
  simulated and replayed hardware from one switch, live diagnostics, a typed
  blackboard, controller abstractions and pit-test routines.
- **[MARS Desktop](https://github.com/STZ-Robotics/Mars/blob/main/desktop/README.md)** — a
  NetworkTables dashboard with 2D and 3D field views, swerve and mechanism
  views, plots, live equations, SysId and `.wpilog` files, plus project
  creation, packages and a subsystem wizard.
- **[MARS for VS Code](https://marketplace.visualstudio.com/items?itemName=STZRobotics.mars-developer-tools)**
  — an architecture view, live values next to the code, diagnostics, quick
  fixes and completion for MARS projects.
- **[Ares](https://github.com/STZ-Robotics/Mars/blob/main/ares/README.md)** — a trajectory
  planner and auto builder that plans with the robot's real physics, and
  AresLib to run it on the robot.

## Get started

1. **Install MARS Desktop** with the installer for your system from the
   [latest release](https://github.com/STZ-Robotics/Mars/releases/latest).
2. **Create a project** from MARS Desktop (*New Project*), or add the library to
   an existing one: *WPILib: Manage Vendor Libraries → Install new library
   (online)* with

    ```
    https://stz-robotics.github.io/Mars/Mars.json
    ```

3. **Install the VS Code extension**, *MARS Developer Tools*.

## Reference

- [Library API (Javadoc)](api/)
- [Source code](https://github.com/STZ-Robotics/Mars)
