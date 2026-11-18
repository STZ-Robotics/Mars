# Templates

The starting points MARS Desktop creates new work from. They are built into the
MARS Desktop binary, so creating a project needs no internet connection and no
`git`.

| Folder | What it becomes | Created by |
|---|---|---|
| [`project/`](project/) | A WPILib robot project with MARS set up: the vendordep, the `Manifest`, a robot container and the `workspace-mars/` folder MARS Desktop uses. | *New Project* |
| [`feature/`](feature/) | A MARS Feature repository: a library other teams can install from MARS Desktop, with the build and the GitHub workflow that publishes it. | *Create Feature* |

## Editing a template

Change the files here, then run the template tests and rebuild MARS Desktop:

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml templates
```

The tests check that hidden files such as `.wpilib/` are included, that the files
the Feature wizard rewrites are where it expects them, and that `gradlew` stays
executable.

`project/vendordeps/Mars.json` must match `lib/Mars.json`;
`node scripts/check-vendordep.mjs` fails when it falls behind a library release.

The repositories `STZ-Robotics/MarsTemplate` and
`STZ-Robotics/MARS-Feature-Template` hold copies of these templates and must stay
online: earlier releases of MARS Desktop download from them.
