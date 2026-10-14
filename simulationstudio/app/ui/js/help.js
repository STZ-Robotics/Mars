// Contextual help: the "?" every panel and every property group carries, and
// the registry of topics it opens.
//
// Everything the program does that does not explain itself has an entry here.
// The rule followed when writing them: each topic says WHAT the control is,
// WHAT happens if it changes, and WHAT breaks if it is set wrong --- that third
// point is what turns a description into help. Almost every failure of this
// app is silent (physics that does not converge, a world without a plugin that
// starts and publishes nothing), so a topic that only repeats the field's name
// is useless.

import { el, escapeHtml, fill, icon } from "./core.js";

const T = (title, body, see = []) => ({ title, body, see });

export const HELP = {
  // --- the application --------------------------------------------------
  "app.overview": T(
    "What MARS Simulation Studio is",
    `<p><strong>MARS Simulation Studio</strong> runs and authors the physics simulation of your
     robot. It is a separate application from MARS Desktop on purpose: the simulation drags in
     the whole Gazebo environment, and that weight has no business travelling inside the
     dashboard your team runs at a competition.</p>
     <p>Two things live here:</p>
     <ul>
       <li><strong>Run</strong> — start, supervise and stop the three processes that make up a
       running simulation, and read their logs when one of them dies.</li>
       <li><strong>Author</strong> — create and edit the worlds the physics engine loads, import
       worlds and models from elsewhere, and inspect the robot maps that wire a robot's joints to
       its motor controllers.</li>
     </ul>
     <p>What it deliberately does <em>not</em> do is draw your robot. Gazebo's own window shows
     the physics, and MARS Desktop plots the telemetry — it receives poses over NT4 from the
     simulation exactly as it would from a real robot.</p>`,
    ["app.processes", "app.world-window"]
  ),

  "app.processes": T(
    "The three processes",
    `<p>A running simulation is three separate programs, started in this order:</p>
     <table>
       <tr><th>Process</th><th>What it does</th></tr>
       <tr><td><code>mars-sim-server</code></td><td>The physics engine. Loads the world SDF, steps
       the physics, and publishes state over gz-transport. Headless — it draws nothing.</td></tr>
       <tr><td><code>mars-sim-gui</code></td><td>The world window: Gazebo's own GUI with the MARS
       panel layout. It <em>connects</em> to the engine, so you can close and reopen it without
       touching the physics.</td></tr>
       <tr><td><code>mars-bridge</code></td><td>Translates between gz-transport and the robot:
       poses and joint state out to NT4, motor commands in.</td></tr>
     </table>
     <p>None of them can be launched on their own — each needs the conda environment on PATH for
     its DLLs, the gz plugin paths, and the right working directory. That is what this app is
     for.</p>
     <p class="warn">Closing this window kills all three. On Windows killing a parent does not
     kill its children, so if the app is force-killed from Task Manager the engine and bridge
     survive and hold the gz-transport topics — the next launch then sees two engines publishing
     poses and they overwrite each other with no error at all.</p>`,
    ["app.overview", "diagnostics"]
  ),

  "app.world-window": T(
    "The world window",
    `<p>The 3D view is Gazebo's own GUI (<code>mars-sim-gui</code>) with the MARS panel layout
     from <code>gui/mars.config</code>: scene, entity tree, component inspector, joints, lights,
     transform control, view angle and world control/stats.</p>
     <p>It is a client of the engine, not part of it. Closing it does not stop the simulation, and
     the simulation runs fine without it — that is how it runs in CI.</p>
     <p>If the window opens grey, the render resources are missing: see the
     <strong>OGRE-Next</strong> row on the Diagnostics page.</p>`,
    ["diagnostics"]
  ),

  // --- launching ----------------------------------------------------------
  "launch.world": T(
    "World",
    `<p>The <code>.sdf</code> file the physics engine loads. It defines everything that is not the
     robot: gravity, the ground and its friction, the field walls, lighting, and any props.</p>
     <p>Worlds live in <code>sim/worlds/</code>. Create one in <strong>World Library</strong>, or
     import an existing <code>.sdf</code> from anywhere on disk.</p>
     <p class="note">A world whose <code>&lt;world name&gt;</code> is not <code>mars</code> will
     load, but nothing will work: every standard gz-sim topic carries the world name
     (<code>/world/mars/clock</code>) and the bridge subscribes to the ones with
     <code>mars</code> in them.</p>`,
    ["worlds.name-mars", "worlds.library"]
  ),

  "launch.robot": T(
    "Robot map",
    `<p>A <code>robot-map.json</code> is the translation between your robot code's channels and
     the joints of the SDF: which joint each motor drives, its gear ratio, and how its encoder
     reports.</p>
     <p>It is the only file that changes between robots. The world describes the field; the robot
     map describes the machine.</p>
     <p class="warn">The order of the actuator list is not cosmetic — it <em>is</em> the index into
     the <code>gz.msgs.Actuators</code> message. If it disagrees with the order of the
     <code>&lt;actuator&gt;</code> tags in the SDF, the robot gets its commands crossed with no
     error anywhere. <code>protocol/check.py</code> exists to catch exactly that.</p>`,
    ["robots.map", "robots.actuators"]
  ),

  "launch.nt": T(
    "NetworkTables server",
    `<p>Where the bridge publishes telemetry. <strong>The NT4 server is not ours</strong> — your
     robot code brings it up on port 5810, exactly as a real robot does, and both the bridge and
     MARS Desktop are clients of it.</p>
     <p>That is what keeps a simulated match indistinguishable from a real one on the dashboard
     side: the same NT4 client code serves both, with no "simulation mode" branch.</p>
     <p>Use <code>127.0.0.1</code> when you run robot code with <code>simulateJava</code> on this
     machine. Point it at another address only if the robot code runs elsewhere.</p>`,
    ["protocol.topics"]
  ),

  "launch.status": T(
    "Run status",
    `<p>The status line reports what the supervisor actually knows, not what it was asked to do.
     Each process is polled with a non-blocking wait; when one exits on its own the light turns
     red and the reason appears.</p>
     <p>That check is the difference between a crash you find out about and a UI that says
     "Running" forever after the engine died — the worst way to fail is silently.</p>
     <p>If one of the two core processes dies, the other is stopped too: it has nobody left to
     talk to.</p>`,
    ["console.logs"]
  ),

  "console.logs": T(
    "Process logs",
    `<p>Each process writes a <code>.log</code> (normal startup) and a <code>.err</code> (what
     matters when it fails) into <code>sim/build/</code>. Both are concatenated here.</p>
     <p>The view follows the tail only while you are already at the bottom. If you scrolled up to
     read something, it stays put — jumping the scroll out from under a reader is one of the most
     annoying things a log panel can do.</p>
     <p><strong>Where to look first:</strong> a world that fails to load shows up in the engine
     log; a missing DLL shows up as a Windows error with no name in it (check Diagnostics); a
     bridge that connects to nothing but keeps running usually means the engine started after it,
     or the world has no scene broadcaster.</p>`,
    ["diagnostics", "world.plugins"]
  ),

  diagnostics: T(
    "Diagnostics",
    `<p>Every prerequisite for <strong>Start</strong>, checked one at a time.</p>
     <p>This page exists because almost every failure of this app is an installation problem, and
     none of them explain themselves: the engine dies with a Windows error that does not name the
     missing DLL, or the 3D window opens grey and the only trace is a line in stderr nobody
     reads.</p>
     <p>Rows marked <strong>FAIL</strong> stop the simulation from running. Rows marked
     <strong>WARN</strong> do not — you get a simulation with less in it (no 3D window, for
     instance, which is exactly how it runs in CI).</p>`,
    ["app.processes"]
  ),

  // --- world library ------------------------------------------------------
  "worlds.library": T(
    "World Library",
    `<p>Every <code>.sdf</code> in <code>sim/worlds/</code>, with what could be read out of it:
     the declared world name, how many models, includes, plugins and lights it has, and its
     physics step.</p>
     <p>The <strong>MANAGED</strong> tag means the world was created here and has a
     <code>.studio.json</code> next to it holding the properties that generated it. Those worlds
     open in the property editor. Everything else is an <em>external</em> world: you can run it,
     read it and edit its XML by hand, but the property tree will not rewrite it.</p>`,
    ["worlds.managed", "worlds.import"]
  ),

  "worlds.generator": T(
    "Generated worlds",
    `<p>A third kind of world, next to managed and external: one written by a <strong>script</strong>.
     <code>worlds/swerve.sdf</code> is the one that ships — a four-module swerve is four identical
     corners with their inertia tensors computed, and <code>worlds/gen_swerve.py</code> writes it
     together with its <code>robot-map.json</code> so the <em>order</em> of the actuators cannot
     drift between the two files.</p>
     <p>The <strong>Generator</strong> tab is that script's own option list. The panel does not know
     what any of the options mean: it asks the script with <code>--options</code> and draws what
     comes back. Add an option to the generator and it appears here on its own — which is the only
     way the window and the terminal can stay in agreement.</p>
     <p><strong>Generate</strong> reruns the script and overwrites both files. Anything you edited
     by hand in the Source tab is lost at that point, and that is the trade: the script is the
     source, the SDF is its output.</p>
     <p class="warn">The options that cost you the most are the ones about how much is in the world.
     Every physical FUEL is a dynamic body: 408 of them take the real-time factor to 0.48, and below
     about 0.95 the control loop stops being representative of the real robot. The field mesh is the
     other one — it is the heaviest thing the window draws.</p>`,
    ["worlds.managed", "world.fuel", "world.physics.rtf"]
  ),

  "worlds.managed": T(
    "Managed vs. external worlds",
    `<p>A world you create in the editor is written twice: the <code>.sdf</code> Gazebo eats, and
     a <code>.studio.json</code> beside it with the properties that produced it. That JSON is what
     lets the property tree reopen the world later and regenerate the SDF without losing
     anything.</p>
     <p>An <code>.sdf</code> with no JSON beside it is <strong>external</strong>. The editor
     refuses to regenerate it, on purpose: an SDF written by hand contains things this generator
     has no concept of, and rebuilding it from the handful of values a regular expression can
     recover would destroy someone's work silently.</p>
     <p>External worlds are still fully usable — run them, read them, and edit the XML in the
     <strong>Source</strong> tab.</p>`,
    ["worlds.library", "world.plugins"]
  ),

  "worlds.name-mars": T(
    "Why every world is named \"mars\"",
    `<p>The world name is part of the protocol, not a label. Standard gz-sim topics embed it —
     <code>/world/mars/clock</code>, <code>/world/mars/pose/info</code> — and the bridge
     subscribes to those exact names. <code>sim/protocol/check.py</code> fails the build if any
     SDF in <code>worlds/</code> declares a different one.</p>
     <p>Worlds generated here always emit <code>&lt;world name="mars"&gt;</code>. An imported
     world that declares something else is flagged in the library; fix it in the
     <strong>Source</strong> tab before running it.</p>`,
    ["worlds.import", "protocol.topics"]
  ),

  "worlds.import": T(
    "Importing a world",
    `<p>Copies an <code>.sdf</code> (or <code>.world</code>) from anywhere on disk into
     <code>sim/worlds/</code>. If the source folder has <code>meshes/</code>,
     <code>materials/</code> or <code>models/</code> next to it, those come along too — a world
     whose meshes arrive without their files opens grey, and the only trace is in stderr.</p>
     <h4>After importing, check these</h4>
     <ul>
       <li><strong>The world name.</strong> It must be <code>mars</code>.</li>
       <li><strong>The physics and scene-broadcaster plugins.</strong> Without the first nothing
       moves; without the second the bridge sees no state and waits forever.</li>
       <li><strong>Mesh URIs.</strong> <code>model://</code> URIs resolve through
       <code>GZ_SIM_RESOURCE_PATH</code>; relative paths resolve from <code>sim/</code>, which is
       the working directory the engine is launched with.</li>
       <li><strong>Scale.</strong> SDF is metres, always. A model authored in millimetres arrives
       a thousand times too big and the solver explodes on the first step.</li>
     </ul>
     <p>The library flags the first two for you.</p>`,
    ["guide.sdf-model", "worlds.name-mars"]
  ),

  // --- world properties ---------------------------------------------------
  "world.physics.step": T(
    "Physics step",
    `<p>How much simulated time each solver step advances, in seconds. Smaller is more accurate
     and more expensive.</p>
     <p><strong>0.004 s (250 Hz)</strong> is the default and a deliberate one: WPILib's loop runs
     at 50 Hz (20 ms), so that is exactly five physics steps per robot cycle — enough resolution
     that fast wheels do not tunnel through the floor, without making each step expensive.</p>
     <p class="warn">Raising the step is the wrong way to buy performance. If the model is too
     heavy to hold real time, simplify the model. A simulation running below real time invalidates
     every gain you tune on it.</p>`,
    ["world.physics.rtf"]
  ),

  "world.physics.rtf": T(
    "Real-time factor",
    `<p>The target ratio between simulated time and wall-clock time. <code>1.0</code> means one
     simulated second per real second.</p>
     <p class="warn">This is the single most important number in the whole simulation, and it is
     not decorative. The HALSim WebSocket protocol has <strong>no clock message</strong>: there is
     no way for the simulation to impose its time on the robot's HAL. Your robot code's 20 ms loop
     and Gazebo's physics run on two unsynchronised wall clocks, in parallel.</p>
     <p>That works if, and only if, Gazebo actually holds a real-time factor of 1.0. Sustained
     below about 0.95, your robot code is running its control loop against physics that are
     falling behind, and any PID gain you tune there will not transfer to the real robot.</p>
     <p>The achieved RTF is published on <code>/MARS/Sim/realTimeFactor</code>. Watch it.</p>`,
    ["world.physics.step", "protocol.topics"]
  ),

  "world.physics.engine": T(
    "Physics engine",
    `<p><strong>DART</strong> is the default and what everything here has been verified against.</p>
     <p><strong>Bullet Featherstone</strong> is the fallback. It uses a reduced-coordinate
     articulated-body solver, which behaves better on long kinematic chains with high gear
     ratios, and differently enough on contact that friction values tuned for DART will not carry
     over unchanged.</p>
     <p>Switch only if DART is actually giving you trouble, and re-check your drivetrain
     behaviour afterwards.</p>`,
    ["world.friction"]
  ),

  "world.gravity": T(
    "Gravity",
    `<p>Acceleration along Z, in m/s². Earth is <code>-9.8</code>.</p>
     <p>Setting it to zero is a genuinely useful debugging tool: it isolates whether a mechanism
     misbehaves because of its own dynamics or because it is fighting its own weight. It is not a
     configuration you should ever tune a controller against.</p>`
  ),

  "world.ground": T(
    "Ground plane",
    `<p>An infinite static collision plane at Z = 0, with a finite visual rectangle drawn on top of
     it at the field dimensions.</p>
     <p class="note">The <em>collision</em> plane is infinite even though the <em>visual</em> one
     is not. Without perimeter walls the robot simply drives off the drawn field and keeps going,
     with nothing to stop it.</p>`,
    ["world.walls", "world.friction"]
  ),

  "world.friction": T(
    "Ground friction (μ, μ2)",
    `<p>Coulomb friction coefficients of the ground surface. <code>mu</code> acts along the first
     friction direction and <code>mu2</code> along the perpendicular one; for FRC carpet they are
     normally equal.</p>
     <p><strong>0.9</strong> is a starting value for FRC carpet, not a measured one. Calibrate it
     against real robot data — a drivetrain accelerating on the wrong μ reaches the wrong speed in
     the wrong time, and everything you tune downstream inherits that error.</p>
     <p>Making them different is how you model a surface that slips more sideways than forwards,
     such as omni or mecanum rollers when the wheel itself is modelled as a plain cylinder.</p>`,
    ["world.ground"]
  ),

  "world.field-size": T(
    "Field dimensions",
    `<p>Length (along X) and width (along Y) of the drawn field, in metres. The FRC field is
     <strong>16.54 × 8.21 m</strong>, and that number is also declared in
     <code>protocol/topics.toml</code>, where the bridge reads it at compile time to convert
     between Gazebo's origin and WPILib's alliance-corner origin.</p>
     <p class="warn">Changing the size here changes the drawn ground and the wall positions. It
     does <em>not</em> change what the bridge believes the field is. If you want a field of a
     different size to convert correctly, change it in <code>topics.toml</code> too and rebuild
     the bridge.</p>`,
    ["protocol.axes"]
  ),

  "world.walls": T(
    "Perimeter walls",
    `<p>Four static boxes around the field. Without them the robot drives off the edge, because
     the ground's collision plane is infinite while its visual is not.</p>
     <p>Height matters for what you are testing: low walls (0.3–0.5 m) stop a drivetrain;
     realistic ones matter only if a mechanism can reach over them.</p>`,
    ["world.ground"]
  ),

  "world.lighting": T(
    "Sun",
    `<p>A single directional light. Its direction vector points <em>where the light travels</em>,
     so a downward sun has a negative Z.</p>
     <p>Lighting is cosmetic for physics, and not for anything else: shadows cost render time in
     the world window, and if you ever enable camera sensors, the lighting is what those cameras
     see. A vision pipeline tuned against a badly lit simulated field learns the wrong
     thresholds.</p>`,
    ["world.scene", "world.sensors"]
  ),

  "world.scene": T(
    "Scene",
    `<p>Ambient light level, background colour and whether shadows are cast. All of it affects only
     what the world window and any camera sensors see; none of it affects the physics.</p>
     <p>Ambient light is the floor of illumination — raise it if models look black on their unlit
     side, lower it for contrast.</p>`,
    ["world.lighting"]
  ),

  "world.plugins": T(
    "World plugins",
    `<p>Systems the engine loads with the world. Two are mandatory and are always written:</p>
     <ul>
       <li><strong>Physics</strong> — resolves the dynamics. Without it, the world loads and
       nothing ever moves.</li>
       <li><strong>SceneBroadcaster</strong> — publishes world state over gz-transport. Without
       it, the bridge subscribes and waits forever, and no error is printed anywhere.</li>
     </ul>
     <p>The optional ones:</p>
     <ul>
       <li><strong>UserCommands</strong> — lets entities be spawned and deleted at runtime. Needed
       if you want to drop game pieces into a running simulation.</li>
       <li><strong>Sensors</strong> — required for anything that renders: cameras, depth, lidar.
       Costs render time whether or not a sensor exists.</li>
       <li><strong>IMU</strong> — required for <code>&lt;sensor type="imu"&gt;</code> to produce
       readings. If your robot map declares an IMU and this is off, the gyro reads zero forever.</li>
     </ul>
     <p><strong>Extra plugins</strong> takes raw filenames, one per line, for anything else in
     your gz plugin path.</p>`,
    ["world.sensors", "robots.imu"]
  ),

  "world.sensors": T(
    "Sensors and vision",
    `<p>Camera and lidar sensors need the <strong>Sensors</strong> system, which needs a render
     engine (OGRE2) even when the engine is otherwise headless.</p>
     <p class="note">Vision is out of scope for protocol 0.1.0. The conda environment already has
     <code>gz-sensors</code> installed, and turning this plugin on works, but nothing in the
     bridge forwards camera data to your robot code yet. When it lands it will be a new profile,
     not a protocol change.</p>`,
    ["world.plugins"]
  ),

  "world.field": T(
    "FRC field model",
    `<p>The real field, as a 3D mesh, dropped into the world. It comes from an
     <strong>AdvantageScope field asset</strong> — the same folders MARS Desktop downloads for its
     Field 3D tab — installed into <code>sim/fields/</code> from the <strong>Field Library</strong>
     page.</p>
     <p class="warn">It goes in as a <strong>visual only</strong>. The 2026 field is about 2.9 M
     triangles; using it as collision geometry would put the solver into mesh-on-mesh contact, the
     most expensive thing a physics engine does, and the real-time factor — on which the validity
     of the whole loop depends — would collapse. Physics still comes from the ground plane and the
     perimeter walls.</p>
     <p>Two consequences worth knowing:</p>
     <ul>
       <li><strong>The 3D window takes about half a minute to open</strong> with the field loaded.
       The engine and the bridge are unaffected; it is the renderer.</li>
       <li><strong>The robot will drive through field elements.</strong> They are scenery. If you
       need something to collide with, add a prop where it is.</li>
     </ul>
     <p>The default rotation is a 90° roll, because glTF is authored Y-up and Gazebo is Z-up.
     Position and scale are there for a field whose model does not match that convention.</p>`,
    ["world.field.origin", "world.field.install", "world.props"]
  ),

  "world.field.origin": T(
    "Where the origin is — and why the robot starts in the middle",
    `<p>This trips everyone up once, so it is worth being precise: there are <strong>two</strong>
     frames, and both are right.</p>
     <table>
       <tr><th>Frame</th><th>Origin</th></tr>
       <tr><td><strong>Gazebo</strong> — the world, the field mesh, every pose in the SDF</td>
       <td>The <em>centre</em> of the playing area</td></tr>
       <tr><td><strong>WPILib</strong> — what your robot code and the dashboard see</td>
       <td>The blue alliance <em>corner</em></td></tr>
     </table>
     <p>So a robot spawned at Gazebo <code>0, 0</code> is standing in the middle of the field, and
     that is exactly where WPILib reports <code>(8.27, 4.11)</code> — the centre. Nothing is
     misplaced.</p>
     <p><strong>The bridge does the translation</strong>, once, at its NT4 edge
     (<code>sim/bridge/src/field.rs</code>). It adds half the field length and half the width. Both
     frames are right-handed with Z up and yaw positive counter-clockwise, so there is no rotation
     and no mirroring involved — just a shift.</p>
     <p class="warn">Which is why you should <em>not</em> move the field mesh so its corner sits on
     the Gazebo origin, even though the corner is where WPILib counts from. Do that and every pose
     the dashboard receives is off by half a field, with nothing reporting an error. The field mesh
     is authored centred — the AdvantageScope config puts its driver stations at
     <code>x = ±8.28</code> — so leaving it at <code>0 0 0</code> is what lines it up.</p>
     <p>If you want a robot to start somewhere specific in FRC coordinates, subtract half the field
     from each axis: WPILib <code>(2.0, 1.0)</code> is Gazebo <code>(-6.27, -3.11)</code>.</p>`,
    ["world.pose", "protocol.axes", "world.field-size"]
  ),

  "world.field.install": T(
    "Installing a field",
    `<p>Copies an AdvantageScope field folder into <code>sim/fields/</code> and prepares its mesh
     for Gazebo.</p>
     <p>It is copied rather than referenced where it sits, because a world pointing at a path under
     <code>%APPDATA%</code> would not open on anybody else's machine — and worlds are part of the
     repository.</p>
     <h4>What "prepares" means</h4>
     <p>The official field models declare nearly every material as fully metallic with very low
     roughness. Under a PBR renderer a surface like that has no colour of its own: it reflects the
     environment. OGRE2 here has no environment map, so what it reflects is black — the field
     loads, the physics runs, and the screen shows a field-shaped black shape.</p>
     <p>Installing rewrites the metallic factor to zero, which is the same fix AdvantageScope
     applies by forcing <code>MeshPhongMaterial</code> instead of a PBR material. The edit is done
     byte-for-byte, keeping the file exactly the same length, so no offset inside the glTF
     moves.</p>`,
    ["world.field", "guide.sdf-model"]
  ),

  "world.robot-include": T(
    "Robot include",
    `<p>Adds an <code>&lt;include&gt;</code> pointing at a robot model, with a spawn pose.</p>
     <p>Leave it empty when the robot is defined <em>inside</em> the world file, which is how the
     bundled <code>testbot.sdf</code> and <code>swerve.sdf</code> do it — that avoids depending on
     <code>GZ_SIM_RESOURCE_PATH</code> being set correctly while you are debugging something
     else.</p>
     <p>Use it when the robot lives in its own model directory: <code>model://my-robot</code>
     resolves through the resource path, and a relative path resolves from <code>sim/</code>.</p>`,
    ["guide.sdf-model", "world.pose"]
  ),

  "world.pose": T(
    "Pose",
    `<p>Six numbers: <code>x y z</code> in metres and <code>roll pitch yaw</code> in radians —
     always radians, everywhere inside Gazebo. The editor shows the angles in degrees and converts
     on write, because a spawn heading is a thing humans think about in degrees.</p>
     <p>Gazebo is ENU: X forward, Y left, Z up, yaw positive counter-clockwise from X. WPILib
     shares the yaw convention but measures from the alliance wall and puts its origin in the
     alliance corner. The bridge does the whole conversion, so nothing inside the world needs to
     know which alliance you are.</p>`,
    ["protocol.axes"]
  ),

  "world.props": T(
    "Props",
    `<p>Loose objects in the world: boxes, cylinders, spheres or meshes. Game pieces, obstacles,
     ramps, a wall to drive into.</p>
     <p>A <strong>static</strong> prop is immovable and costs the solver nothing — that is what you
     want for scenery. A dynamic prop takes part in the physics and needs a sensible mass.</p>
     <p>Their inertia is computed from the bounding box, which is an approximation and a declared
     one: a prop is an obstacle, not a mechanism, and an exact inertia tensor would not change
     anything you are testing with it.</p>`,
    ["world.props.mass", "world.pose"]
  ),

  "world.props.mass": T(
    "Prop mass",
    `<p>Kilograms. It matters more than it looks: mass ratios drive solver stability.</p>
     <p class="warn">A very light dynamic object in contact with a very heavy one is the classic
     way to make a physics solver jitter or explode. If a 20 g game piece under a 60 kg robot
     misbehaves, raise its mass before you touch anything else — you are simulating a robot, not
     the game piece.</p>`,
    ["world.props"]
  ),

  "world.fuel": T(
    "FUEL",
    `<p>How many <strong>FUEL</strong> — the scoring element of REBUILT — are seeded into the
     world <em>with physics</em>: a 15.0 cm, 0.215 kg high-density foam ball, both numbers from
     the game manual.</p>
     <p class="warn">These are not the balls you already see on the field. The 2026 field mesh has
     456 FUEL baked into the glTF as decoration — no collision, no mass, nothing to pick up. This
     count is independent of them, and a world can perfectly well show 456 painted balls and
     simulate three real ones.</p>
     <p>Each one is another dynamic body in the solver's loop, so this is also the cheapest knob
     you have when the real-time factor sags. Below ~0.95 sustained, the control loop stops being
     representative of the real robot; cut the count before you touch the step size.</p>
     <p><strong>They do not bounce, and that is measured, not assumed.</strong> This build of
     gz-physics ignores <code>&lt;bounce&gt;</code> entirely: dropped from 1 m, 0.5 m and 2.5 m a
     FUEL comes back with e = 0.000 under both DART and Bullet. It lands and stays. For a foam
     ball on carpet that is close enough to real life, but it means this world cannot tell you
     anything about a shot that rebounds off the HUB rim.</p>
     <p>Friction is set to μ = 0.85, which is a starting point and not a measurement — it is what
     decides whether a FUEL rolls or drags when a robot pushes it, and whether an intake grabs it
     or spins against it. <code>worlds/fuel-drop.sdf</code> exists to calibrate it against the
     real thing.</p>`,
    ["world.fuel.zone", "world.props", "world.physics.rtf"]
  ),

  "world.fuel.zone": T(
    "FUEL staging zone",
    `<p>The box the FUEL are seeded into: its size in X and Y, its centre in Gazebo coordinates
     (0, 0 is the middle of the field), and how high above the floor they start.</p>
     <p>The default is the <strong>NEUTRAL ZONE</strong> of the manual, 206.0 × 72.0 in, centred
     on the field — where the game stages them.</p>
     <p>They are placed on a grid, not at random, for two reasons. A grid is reproducible, so two
     runs of the same world start identical and an autonomous routine is worth comparing; and it
     guarantees no ball is born inside another. Two overlapping bodies at step zero is the classic
     way to make a solver invent energy and fire them across the field.</p>
     <p>If more FUEL are asked for than fit in one layer, they stack in layers and settle. The
     count field tells you the grid and the number of layers before you save.</p>
     <p>A <strong>drop height</strong> above zero lets them fall in. Useful to see them scatter
     into a real pile; the settling costs a moment of simulation time at the start.</p>`,
    ["world.fuel", "world.pose"]
  ),

  // --- robots ------------------------------------------------------------
  "robots.map": T(
    "Robot map",
    `<p><code>models/&lt;robot&gt;/robot-map.json</code> is the contract between your robot code
     and the simulated machine. It declares, per robot: which SDF implements it, the profile it
     uses, and the lists of actuators, encoders and IMU.</p>
     <p>It is the only file that differs between robots. Everything else in the protocol is
     shared.</p>`,
    ["robots.actuators", "robots.profiles"]
  ),

  "robots.actuators": T(
    "Actuators",
    `<p>One entry per motor: the joint it drives, the motor model, the gear ratio, whether it is
     inverted, and its control mode.</p>
     <p class="warn">The order of this list is the index into the <code>gz.msgs.Actuators</code>
     message the bridge sends. It must match the order of the <code>&lt;actuator&gt;</code> tags
     inside the SDF's MarsLink plugin block. If they diverge, every motor gets somebody else's
     command and nothing reports an error. <code>protocol/check.py</code> verifies this
     specifically.</p>`,
    ["robots.control-mode", "robots.gear-ratio"]
  ),

  "robots.control-mode": T(
    "Control mode: duty vs. position",
    `<p>Declared per actuator in the SDF and repeated in the robot map, and checked for agreement.</p>
     <ul>
       <li><code>duty</code> — the engine reads <code>normalized</code> and applies torque. For
       anything you command open-loop.</li>
       <li><code>position</code> — the engine reads <code>position</code> and <strong>closes a PD
       loop at the physics rate</strong>, the way a real TalonFX closes its loop at about 1 kHz.</li>
     </ul>
     <p><strong>Position mode is mandatory for swerve steering, not a convenience.</strong> A
     12.8:1 steering stage on a Kraken puts 90 N·m across 0.008 kg·m², which is 10 700 rad/s².
     Closing that loop from robot code does not work, and it was measured: 269° of deviation at
     50 Hz, 145° at 250 Hz. With the loop inside the engine: 0.6°.</p>`,
    ["robots.actuators", "robots.profiles"]
  ),

  "robots.gear-ratio": T(
    "Gear ratio",
    `<p><code>gearRatio</code> is a <em>reduction</em>: motor turns per output turn. A 6.75:1
     drivetrain is <code>6.75</code>.</p>
     <p>Encoders report on the motor shaft, before the reduction, exactly as the integrated
     encoders of a Falcon or Kraken do.</p>
     <p class="note">Two modelling gaps that bite on any geared mechanism, and they are the reason
     a naive SDF diverges. Reflected rotor inertia scales with n² and must be in the SDF — without
     it the solver has almost no inertia to work against at the joint and blows up. And adding it
     to the joint axis alone violates the triangle inequality of the inertia tensor, at which
     point Gazebo rejects the world outright.</p>`,
    ["robots.actuators"]
  ),

  "robots.encoders": T(
    "Encoders",
    `<p>What the simulation reports back as position and velocity, per joint, with a counts-per-
     revolution figure.</p>
     <p class="note">Wheel radius is deliberately <strong>not</strong> in the robot map. It comes
     from the collision geometry in the SDF, which is the only radius the physics actually
     respects. Duplicating it here would guarantee that one day the two diverge, and the simulated
     robot drives differently from what its own odometry claims.</p>`,
    ["robots.map"]
  ),

  "robots.imu": T(
    "IMU",
    `<p>An IMU entry requires two things to line up: a <code>&lt;sensor type="imu"&gt;</code> on
     the robot's chassis link in the SDF, and the <strong>IMU system plugin</strong> enabled on the
     world.</p>
     <p>Miss either and the gyro reads a constant zero — which looks exactly like a robot that
     never turns, and is a genuinely confusing thing to debug from the dashboard.</p>`,
    ["world.plugins"]
  ),

  "robots.profiles": T(
    "Profiles: hal vs. vendor",
    `<p>This is the distinction that shapes the whole project. <strong>The HALSim WebSocket
     protocol does not cover CAN motors.</strong> It covers PWM, DIO, AnalogIn, Encoder, Relay,
     SimDevice and DriverStation — everything native to the roboRIO. A TalonFX or a SparkMax is
     simulated by its vendor's own sim API, which lives inside the robot's process and never
     appears on the wire.</p>
     <h4>hal — transparent</h4>
     <p>For mechanisms on PWM and sensors wired to the RIO. Zero changes to robot code: load the
     extension and go. Use it whenever you can.</p>
     <h4>vendor — with glue</h4>
     <p>For CAN drivetrains, which is where nearly all of FRC is today. It needs about 50 lines in
     <code>simulationPeriodic</code> that publish what the vendor is asking the motor for, and
     inject the position and velocity coming back. Intrusive, and the price of vendors not
     exposing their sim outside their own process.</p>
     <p>One robot can use both at once: <code>vendor</code> for the swerve, <code>hal</code> for an
     elevator on PWM.</p>`,
    ["robots.control-mode", "protocol.topics"]
  ),

  // --- guides and reference ----------------------------------------------
  "guide.sdf-model": T(
    "Importing an SDF model",
    `<p>The full walkthrough is on the <strong>Import Guide</strong> page — folder layout, mesh
     URIs, inertia, and the actuator plugin block that makes a model controllable.</p>
     <p>The short version: a model is a directory with a <code>model.config</code> and a
     <code>model.sdf</code>, it goes somewhere on <code>GZ_SIM_RESOURCE_PATH</code>, and it is
     referenced as <code>model://&lt;directory-name&gt;</code>.</p>`
  ),

  "protocol.topics": T(
    "Topics",
    `<p><code>sim/protocol/topics.toml</code> is the single source of truth for topic names and
     field dimensions. It is not aspirational: the bridge's <code>build.rs</code> reads it at
     compile time and emits the constants, so renaming a topic there breaks the bridge's build
     rather than breaking the simulation at runtime.</p>`,
    ["protocol.axes"]
  ),

  "protocol.axes": T(
    "Axes and units",
    `<p><strong>Axes.</strong> Gazebo is ENU: Z up, yaw counter-clockwise positive measured from
     X. WPILib uses the same yaw sense but measures from the axis pointing at the far wall, with
     its origin at the alliance corner. The bridge converts both origin and rotation, so neither
     the engine nor the glue ever needs to know which alliance you are on.</p>
     <p><strong>Units.</strong> Inside gz-transport, everything is SI and radians, always. The
     conversion to degrees and to WPILib conventions happens exactly once, at the bridge's NT4
     edge. A value in degrees inside the engine is a bug.</p>`,
    ["world.pose", "protocol.topics"]
  ),
};

// --- the button and its popover -------------------------------------------

let open = null;

/**
 * The "?" placed next to a title.
 *
 * `id` has to exist in HELP: a button that opens an empty topic is worse than
 * no button, so in development it warns on the console.
 */
export function helpButton(id) {
  if (!HELP[id]) console.warn(`[help] no such topic: ${id}`);
  return el(
    "button.help-btn",
    {
      type: "button",
      title: "What is this?",
      "aria-label": `Help: ${HELP[id]?.title ?? id}`,
      onclick: (e) => {
        e.stopPropagation();
        openHelp(id, e.currentTarget);
      },
    },
    "?"
  );
}

/** Opens topic `id`, anchored to the element that asked for it. */
export function openHelp(id, anchor) {
  closeHelp();
  const topic = HELP[id];
  if (!topic) return;

  const pop = el(
    "div.help-pop",
    { role: "dialog", "aria-label": topic.title },
    el(
      "div.head",
      icon("help.svg", 13),
      el("span.label", topic.title),
      el("button.btn.btn-sm", { type: "button", onclick: closeHelp, title: "Close" }, "✕")
    ),
    el("div.doc", { html: topic.body + seeAlso(topic.see) })
  );

  // The "see also" links jump between topics without closing the popover,
  // which is how a help index is navigated.
  pop.querySelectorAll("a[data-help]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openHelp(a.dataset.help, anchor);
    })
  );

  document.body.appendChild(pop);
  place(pop, anchor);
  anchor?.setAttribute("data-open", "true");
  open = { pop, anchor };

  // A click outside closes it. It is registered on the next tick so as not to
  // swallow the click that just opened it.
  setTimeout(() => document.addEventListener("mousedown", outside), 0);
  document.addEventListener("keydown", escape);
}

function seeAlso(see) {
  const alive = (see || []).filter((v) => HELP[v]);
  if (!alive.length) return "";
  const links = alive
    .map((v) => `<a data-help="${v}" href="#">${escapeHtml(HELP[v].title)}</a>`)
    .join(" · ");
  return `<p style="margin-top:12px;padding-top:9px;border-top:1px solid var(--border-light);font-size:11px">
            <strong>See also:</strong> ${links}
          </p>`;
}

/** Below the anchor if it fits, above if not, and always inside the window. */
function place(pop, anchor) {
  const r = anchor?.getBoundingClientRect() ?? { left: 40, bottom: 60, top: 60 };
  const box = pop.getBoundingClientRect();
  const margin = 8;

  let left = r.left - 10;
  left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

  let top = r.bottom + 6;
  if (top + box.height > window.innerHeight - margin) {
    const above = r.top - box.height - 6;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - box.height - margin);
  }

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function outside(e) {
  if (open && !open.pop.contains(e.target)) closeHelp();
}
function escape(e) {
  if (e.key === "Escape") closeHelp();
}

export function closeHelp() {
  if (!open) return;
  open.pop.remove();
  open.anchor?.removeAttribute("data-open");
  open = null;
  document.removeEventListener("mousedown", outside);
  document.removeEventListener("keydown", escape);
}

/**
 * The full index, for the Help Topics page. Returns the topics grouped by
 * their prefix, which is how they are named.
 */
export function topicsByGroup() {
  const names = {
    app: "The application",
    launch: "Running a simulation",
    console: "Logs",
    diagnostics: "Diagnostics",
    worlds: "World library",
    world: "World properties",
    robots: "Robots",
    guide: "Guides",
    protocol: "Protocol",
  };
  const groups = new Map();
  for (const [id, topic] of Object.entries(HELP)) {
    const g = id.split(".")[0];
    if (!groups.has(g)) groups.set(g, { name: names[g] ?? g, topics: [] });
    groups.get(g).topics.push({ id, ...topic });
  }
  return [...groups.values()];
}

/** Renders a full topic inside a node (for the help page). */
export function renderTopic(node, id) {
  const topic = HELP[id];
  if (!topic) return node;
  fill(node, el("div.doc", { html: topic.body + seeAlso(topic.see) }));
  node.querySelectorAll("a[data-help]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      renderTopic(node, a.dataset.help);
    })
  );
  return node;
}
