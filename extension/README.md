# MARS for VS Code

The editor half of MARS. It reads a robot project the way the framework does —
subsystems, their IO layers, their requests, the NetworkTables topics they
publish — and puts that where the code is, instead of leaving it to be
reconstructed by opening six files.

It lives here rather than in its own repository because it talks to things this
repository defines: the vendordep in [`lib/`](../lib), the project layout in
[`templates/project/`](../templates), the `workspace-mars/` folder MARS Desktop
writes. A version of it that disagrees with those is a version that breaks
somebody's project. In here, a change to both is one commit.

## What it does

**A sidebar.** Two views. **Project** answers what a newcomer asks before
touching anything — is the dashboard installed, what team is this, which run
mode is the Manifest pinned to, which MARS am I compiling against, what packages
are installed — and every answer is a link to the file that decides it. Its title
bar has the button that launches **MARS Desktop**.

**Architecture.** MARS spreads a subsystem across files on purpose: the data
here, the IO interface there, three implementations of it, one class per
request. That is what makes each piece swappable, and it is also why nobody can
see a subsystem whole. This view puts the pieces back together without moving
any of them, and every node jumps to its declaration.

**CodeLens.** The same links, over the declarations themselves. Above a
subsystem: its data class, its IO interface and how many implementations it has,
its requests, and the NetworkTables table it publishes under. Above a
`@Tunable` or `@Signal`: the full topic it produces, which is otherwise the
annotation's key, the member's name and the subsystem's key somewhere else
entirely. Above a request: the subsystem it acts on — a link nothing else can
follow, because a request names only the pair of types and never the subsystem.

**Live NetworkTables.** Connect to the robot or the simulator and the value of
every topic appears at the end of the line that publishes it — `→ 0.823` beside
the `@Tunable` field, beside the `NetworkIO.set`, beside the `@Signal`. A lens
over a `@Tunable` writes a new value back. The architecture tree shows the same
values on its topic nodes.

It is not a second dashboard: no graphs, no history, no log playback. Those are
what MARS Desktop is for, and an editor that grew them would be a worse version
of it. Two things follow from keeping it small — it does not synchronise clocks
(nothing here shows a timestamp, and a written value is stamped by the server on
arrival), and it subscribes only to the tables this project publishes, which the
scan already knows, instead of to the whole tree.

**Diagnostics.** Six things that compile, boot, and then go wrong quietly:

| | |
|---|---|
| `mars.duplicateKey` | Two subsystems claiming one NetworkTables table. They do not collide at construction; they collide on the wire. |
| `mars.topicCollision` | One topic published from two places. The last write each loop is the one the dashboard shows. |
| `mars.nullKey` | The subsystem wizard's `.key(null)` still in place. The subsystem publishes under no table at all. |
| `mars.orphanSubsystem` | A subsystem no container ever mentions. Nothing constructs it, so it never runs. |
| `mars.unimplementedIo` | An IO interface with nothing behind it, so `Injector.createIO` has nothing to hand out. |
| `mars.runMode` | The Manifest pinned to anything but `REAL`. This is the one that costs a match. |

Plus `mars.featureRequirement`, when an installed Feature declares a
`marsCoreRequired` the vendordep does not satisfy — otherwise a Gradle failure
on a method that does not exist yet, with nothing pointing at the package that
wanted it.

**Quick fixes**, because a rule that only reports is a rule that gets turned
off. `.key(null)` creates the `KeyManager` constant its own TODO names — or uses
it, when the wizard already left it there — and imports it. An orphan subsystem
gets constructed in the container, with the `Injector` form when all three IO
implementations exist and the one that does exist otherwise, because a fix that
does not compile is worse than none. An interface with nothing behind it gets
`Real` and `Sim` written, with every method stubbed and a return where the
signature needs one; never `Fallback`, which `@Fallback` generates at build
time. And the Manifest goes back to `REAL`.

There is no fix for a topic collision. Picking which of the two is wrong would
be a guess, and a quick fix that guesses gets accepted without being read.

**Renaming a table.** `MARS: Rename a NetworkTables table` rewrites the key
constant and every literal that names the same table. It is a rename of strings,
which is why no language server offers it and why doing it by hand always leaves
one behind — and the one left behind keeps publishing under the old name with
nothing reading it.

**Snippets and hovers.** Snippets for every MARS pattern, written to match what
the subsystem wizard generates rather than an idealised version of it — so a
hand-written subsystem and a generated one look the same. Hovers explain what a
`Request` is for and what returning from it actually does, which is the part
that does not fit in a Javadoc comment.

**Completion where no language server can help.** NetworkTables tables and keys
are strings, and a typo in one produces a topic nobody ever sees. Inside
`NetworkIO.set(...)` and `.key(...)` it offers the project's own key constants;
in the key position it offers the names already published under that table.

**A status bar entry** carrying the run mode, because a project left in `SIM`
looks exactly like a project in `REAL` until the robot is enabled.

### Keys held in constants

The subsystem wizard writes `.key(KeyManager.ARM_KEY)`, never a literal. The
dashboard's own source map stops at that constant and says so. This extension
does not have to: it has already read every file, so it resolves the constant
and names the topic. That is why the architecture view shows `/Arm/Position` in
a project where nothing says `"Arm"` anywhere near the subsystem.

What it still cannot resolve is a key built by concatenation or returned from a
method. Those are reported as unresolved rather than guessed at, which is what
`mars.nonLiteralKey` is for.

## Settings

| | |
|---|---|
| `mars.desktopPath` | Full path to `mars-desktop`. Empty means look where the installer put it (the folder it recorded, then its default), and in this repository's build output. |
| `mars.codeLens` | Turn the lenses off. |
| `mars.networkTables.address` | Connect straight to this `host:port`. Empty means being offered the simulator, the robot derived from the team number, the Driver Station and Systemcore. |

## Working on it

```bash
cd extension
npm install
npm run watch       # esbuild + tsc, both in watch mode
npm run compile     # type-check, lint and bundle once
npm test            # both suites
```

Press **F5** for an Extension Development Host with this extension loaded.
Debugging needs the `connor4312.esbuild-problem-matchers` extension, which
`.vscode/extensions.json` already recommends.

`dist/extension.js` is what ships, `src/` is what you edit.

### The two test suites

`npm test` runs both, and they need different things:

- **unit** (`src/test/unit/`) drives the scanner with Java as strings. Every case
  in it is either a shape the subsystem wizard generates, or something that has
  already fooled the scanner once — a brace inside a string literal, a bounded
  type parameter (`<D extends Data<D>>`) read as a supertype.
- **integration** (`src/test/integration/`) opens `src/test/fixture/`, a real
  MARS project deliberately left in several broken states, and checks that the
  extension wakes up for it, that the diagnostics land on the right lines of the
  right files, and that each quick fix produces the text it claims to. The
  fixture is also the fastest way to see the extension do anything: open that
  folder in the Development Host.

The quick-fix tests apply their edits for real and read the buffer back, then
revert; nothing is ever saved, so the fixture is byte-identical before and after
a run. The NetworkTables tests run against a WebSocket server that speaks the
protocol (`src/test/fakeNt.ts`) rather than against a mocked socket, because the
wire format is the part that can actually be wrong and a mock would only assert
that the client calls its own methods.

The scanner is regex over Java, not a parser — the same choice `source_map.rs`
makes in the dashboard, and for the same reasons. It means the tests are the only
thing keeping it honest, so a bug fixed there should arrive with the case that
found it.

## Before it can be published

- `publisher` is missing from `package.json`. It needs the Marketplace publisher
  id, which is an account thing and not a code thing.
- The Marketplace wants a 128×128 PNG icon; `media/mars.svg` is the activity bar
  icon, which is a different thing and may stay an SVG.
- The version is the *extension's* and follows nothing else here. The dashboard
  and the library each have their own, and `scripts/sync-version.mjs`
  deliberately does not touch this one.
