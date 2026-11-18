# MARS Feature Template

A starting point for a **MARS Feature**: a Java library that any MARS robot
project can install from MARS Desktop's Packages page. The easiest way to start
one is MARS Desktop's **Create Feature** wizard, which fills in everything below
for you. To set it up by hand:

## 1. Describe the Feature

Edit `MarsFeature.json`:

| Field | |
|---|---|
| `featureId` | A unique name with no spaces, e.g. `KrakenWrappers`. |
| `name`, `description`, `author` | What teams see in MARS Desktop. |
| `groupId` | Your team's Java package, e.g. `com.team868.kraken`. |
| `version` | The Feature's version (also in `javaDependencies`). |
| `marsCoreRequired` | The oldest MARS library version it works with. |
| `mavenUrls` | Where the jars are published: `https://<user>.github.io/<repo>/maven/`. |

## 2. Write the code

Rename the package under `src/main/java/` to match your `groupId` and write your
code there. WPILib, ForgeMini and the MARS library are available. Leave the
`generated` folder alone: the build writes `FeatureConstants.java` into it.

## 3. Publish

The included GitHub workflow builds the Feature and publishes it to GitHub Pages
on every push to `main`:

1. Push to `main`.
2. In the repository's **Settings → Pages**, set the source to **Deploy from a
   branch**, branch `gh-pages`, folder `/ (root)`.

A few minutes later, teams can install it in MARS Desktop with **Packages →
Manual Install** and the URL of your `MarsFeature.json`.
