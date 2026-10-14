// Import Guide: how to bring your own model into the simulation.
//
// It is the longest page in the app and that is on purpose. Everything here
// was learned by fighting with it --- meshes that do not load, reflected
// inertia that makes the solver diverge, actuator order that crosses the
// commands without any error --- and none of those things are found by
// reading the SDF documentation, because they are not about SDF: they are
// about this simulation.

import { el } from "./../core.js";
import { navigate } from "./../shell.js";
import { button } from "./../ui.js";

const SECTIONS = [
  {
    id: "shape",
    title: "1 · What a model is",
    svg: "model-file.svg",
    html: `
      <p>In Gazebo a <strong>model</strong> is a directory, not a file. The minimum is two files:</p>
      <pre><code>my-robot/
  model.config      &lt;- metadata: name, version, which SDF to load
  model.sdf         &lt;- the model itself
  meshes/           &lt;- optional: .dae, .stl, .obj
  materials/        &lt;- optional: textures</code></pre>
      <p><code>model.config</code> is small and boring, and Gazebo will not see the directory
      without it:</p>
      <pre><code>&lt;?xml version="1.0"?&gt;
&lt;model&gt;
  &lt;name&gt;my-robot&lt;/name&gt;
  &lt;version&gt;1.0&lt;/version&gt;
  &lt;sdf version="1.11"&gt;model.sdf&lt;/sdf&gt;
  &lt;description&gt;Whatever you want here.&lt;/description&gt;
&lt;/model&gt;</code></pre>
      <p>Put the directory somewhere on <code>GZ_SIM_RESOURCE_PATH</code> and refer to it as
      <code>model://my-robot</code>. Inside this repository the simplest place is
      <code>sim/models/</code>, which already holds the robot maps.</p>
      <div class="note">The two worlds that ship with MARS define their robot <em>inside</em> the
      world file instead. That is deliberate: while you are debugging the control loop it removes
      one environment variable that can be wrong. Split the robot into its own model once the loop
      works.</div>`,
  },
  {
    id: "links",
    title: "2 · Links, joints and frames",
    svg: "joint.svg",
    html: `
      <p>A model is <strong>links</strong> (rigid bodies) connected by <strong>joints</strong>. A
      link that is not connected to anything floats away on the first step.</p>
      <table>
        <tr><th>Joint type</th><th>Use it for</th></tr>
        <tr><td><code>revolute</code></td><td>Anything that rotates within limits: an arm, a swerve
        steering module, a wrist.</td></tr>
        <tr><td><code>continuous</code></td><td>A wheel. A revolute joint with no limits.</td></tr>
        <tr><td><code>prismatic</code></td><td>An elevator stage, a linear slide.</td></tr>
        <tr><td><code>fixed</code></td><td>Two bodies welded together. Costs the solver nothing and
        is the right way to attach non-moving decoration.</td></tr>
      </table>
      <p>Every joint needs an <code>&lt;axis&gt;&lt;xyz&gt;</code>, and that axis is expressed in
      the joint's own frame. Getting it backwards produces a mechanism that moves the wrong way
      and looks like an inverted motor — check the axis before you invert anything in code.</p>
      <p><strong>Poses.</strong> Six numbers, <code>x y z roll pitch yaw</code>, metres and
      <strong>radians</strong>. Radians everywhere inside Gazebo, without exception.</p>`,
  },
  {
    id: "inertia",
    title: "3 · Mass and inertia — where models go wrong",
    svg: "measure.svg",
    html: `
      <p>This is the section that will cost you a day if you skip it. Every dynamic link needs an
      <code>&lt;inertial&gt;</code> block with a mass and an inertia tensor:</p>
      <pre><code>&lt;inertial&gt;
  &lt;mass&gt;2.5&lt;/mass&gt;
  &lt;inertia&gt;
    &lt;ixx&gt;0.012&lt;/ixx&gt;&lt;ixy&gt;0&lt;/ixy&gt;&lt;ixz&gt;0&lt;/ixz&gt;
    &lt;iyy&gt;0.012&lt;/iyy&gt;&lt;iyz&gt;0&lt;/iyz&gt;&lt;izz&gt;0.004&lt;/izz&gt;
  &lt;/inertia&gt;
&lt;/inertial&gt;</code></pre>
      <h4>Reflected rotor inertia</h4>
      <p>A geared motor's rotor inertia appears at the output multiplied by <strong>n²</strong>,
      where n is the reduction. For a Kraken behind 12.8:1 that is a factor of 164 — it is not a
      correction, it is most of the inertia the joint has.</p>
      <p class="warn">Leave it out and the solver has almost nothing to work against at that joint:
      the mechanism jitters, then diverges. This is the single most common reason a hand-written
      FRC model explodes on the first step.</p>
      <h4>...but you cannot just add it to one axis</h4>
      <p>Adding <code>n²·J_rotor</code> to <code>izz</code> alone violates the triangle inequality
      the inertia tensor has to satisfy (<code>ixx + iyy ≥ izz</code>, and its permutations). Gazebo
      checks this and <strong>rejects the world outright</strong>. Distribute it so the tensor stays
      physical — the swerve generator in <code>sim/worlds/gen_swerve.py</code> shows how.</p>
      <h4>Scale</h4>
      <p>SDF is metres. A model exported from CAD in millimetres arrives a thousand times too big,
      with a thousand times the moment arm, and the first step is spectacular. Check one known
      dimension before anything else.</p>`,
  },
  {
    id: "collision",
    title: "4 · Collision vs. visual",
    svg: "part-shape.svg",
    html: `
      <p>Every link can carry two geometries and they do different jobs:</p>
      <ul>
        <li><strong>Visual</strong> — what you see. Use the pretty mesh here.</li>
        <li><strong>Collision</strong> — what the physics touches. Use the simplest primitive that
        is honest: a box for a chassis, a cylinder for a wheel.</li>
      </ul>
      <p class="warn">Do not use a detailed triangle mesh as a collision shape. Mesh-mesh contact
      is the most expensive thing a physics engine does, and it will cost you the real-time factor
      the whole simulation depends on.</p>
      <div class="note"><strong>Wheel radius lives here and nowhere else.</strong> The robot map
      deliberately does not carry it: the collision geometry is the only radius the physics
      respects. Duplicating it guarantees that one day the two diverge and the simulated robot
      drives differently from what its own odometry claims.</div>
      <h4>Friction</h4>
      <p>Wheel friction goes on the wheel's collision surface, the same way ground friction goes on
      the ground:</p>
      <pre><code>&lt;surface&gt;&lt;friction&gt;&lt;ode&gt;
  &lt;mu&gt;1.1&lt;/mu&gt;&lt;mu2&gt;1.1&lt;/mu2&gt;
&lt;/ode&gt;&lt;/friction&gt;&lt;/surface&gt;</code></pre>`,
  },
  {
    id: "meshes",
    title: "5 · Meshes that actually load",
    svg: "part-mesh.svg",
    html: `
      <p>Reference a mesh by URI:</p>
      <pre><code>&lt;visual name="visual"&gt;
  &lt;geometry&gt;
    &lt;mesh&gt;
      &lt;uri&gt;model://my-robot/meshes/chassis.dae&lt;/uri&gt;
      &lt;scale&gt;1 1 1&lt;/scale&gt;
    &lt;/mesh&gt;
  &lt;/geometry&gt;
&lt;/visual&gt;</code></pre>
      <table>
        <tr><th>Format</th><th>Verdict</th></tr>
        <tr><td><code>.dae</code> (COLLADA)</td><td>Best. Carries materials and its own unit
        scale.</td></tr>
        <tr><td><code>.obj</code></td><td>Fine. Materials come from a sidecar <code>.mtl</code> that
        must travel with it.</td></tr>
        <tr><td><code>.stl</code></td><td>Geometry only — no colour, no texture, no units. Usually
        millimetres, so expect to scale by 0.001.</td></tr>
        <tr><td><code>.step</code> / <code>.iges</code></td><td>Not supported. These are CAD
        formats, not meshes. Convert first.</td></tr>
      </table>
      <p class="warn">A mesh that fails to load does not stop the world — the link simply renders
      as nothing while its collision keeps working. If a part is invisible, the reason is in the
      engine log, not on screen.</p>
      <p><strong>Where URIs resolve.</strong> <code>model://</code> goes through
      <code>GZ_SIM_RESOURCE_PATH</code>. A relative path resolves from the working directory the
      engine was launched with, which this app always sets to <code>sim/</code>. When you import a
      world, any <code>meshes/</code> or <code>materials/</code> folder next to it is copied along
      for exactly this reason.</p>`,
  },
  {
    id: "actuators",
    title: "6 · Making it controllable — the MarsLink plugin",
    svg: "gains.svg",
    html: `
      <p>A model with joints is still just furniture. What makes it a robot is the
      <strong>MarsLink</strong> system plugin, declared inside the <code>&lt;model&gt;</code>, with
      one <code>&lt;actuator&gt;</code> per motor:</p>
      <pre><code>&lt;plugin filename="MarsLink" name="mars::MarsLink"&gt;
  &lt;actuator joint="fl_drive_joint" motor="kraken_x60" gearRatio="6.75"
            currentLimit="60"/&gt;
  &lt;actuator joint="fl_steer_joint" motor="kraken_x60" gearRatio="12.8"
            control="position" currentLimit="60" kp="60" kd="3"/&gt;
&lt;/plugin&gt;</code></pre>
      <h4>The order is the protocol</h4>
      <p class="warn">The order of these tags <em>is</em> the index into the
      <code>gz.msgs.Actuators</code> message the bridge publishes. If it disagrees with the order of
      the actuator list in <code>robot-map.json</code>, every motor receives somebody else's
      command and <strong>nothing reports an error anywhere</strong>.
      <code>sim/protocol/check.py</code> exists specifically to catch this — run it.</p>
      <h4>Control mode</h4>
      <p><code>control="duty"</code> (the default) reads the normalized field and applies torque.
      <code>control="position"</code> reads a target angle and closes a PD loop <em>inside the
      engine</em>, at the physics rate, the way a real TalonFX closes its loop at about 1 kHz.</p>
      <p>Position mode is mandatory for swerve steering, and that is a measured claim: a 12.8:1
      steering stage on a Kraken puts 90 N·m across 0.008 kg·m², which is 10 700 rad/s². Closing
      that loop from robot code gives 269° of deviation at 50 Hz and 145° at 250 Hz. With the loop
      in the engine: 0.6°.</p>
      <h4>Current limit</h4>
      <p><code>currentLimit</code> is the stator current limit in amps, and leaving it out is the
      single easiest way to build a robot that drives nothing like yours. Without it the motor
      model delivers its full stall current — 366 A on a Kraken — and a 5.27:1 drive on 2 in wheels
      then pushes 736 N per wheel against roughly 117 N of grip. The simulated robot burns rubber
      off the line every single time, and the real one does not, because its TalonFX has a limit
      configured that nothing in the simulation knew about.</p>
      <p>The number to use is the <strong>slip current</strong> — what CTRE calls
      <code>kSlipCurrent</code> in TunerConstants: the current at which the wheel delivers exactly
      the force the carpet can take.</p>
      <pre><code>I_slip = mu · m · g / wheels · r_wheel / (Kt · gearRatio)</code></pre>
      <p>Measured on the swerve world with <code>bridge/src/bin/swerve-step.rs</code>: without a
      limit, wheel slip off the line is 98% and stays above 45% for a third of a second. With the
      limit at the slip current, it never exceeds 8% after the first sample.</p>
      <p>It clamps braking current too, which matters more than it sounds: at duty zero the motor
      model brakes with its whole back-EMF, about 363 A at top speed. That is a stop no real motor
      delivers, and it reads as a robot that feels heavy the moment you let go of the stick.</p>`,
  },
  {
    id: "map",
    title: "7 · The robot map",
    svg: "manifest.svg",
    html: `
      <p>Last piece: <code>sim/models/&lt;robot&gt;/robot-map.json</code>. It is what tells the
      bridge how to translate between your robot code and the joints of the SDF.</p>
      <pre><code>{
  "protocol": "0.1.0",
  "robot": "my-robot",
  "world": "mars",
  "model": "robot",
  "profile": "vendor",
  "sdf": "worlds/my-world.sdf",

  "actuators": [
    { "name": "fl_drive", "joint": "fl_drive_joint", "motor": "kraken_x60",
      "gearRatio": 6.75, "inverted": false,
      "hal": { "kind": "pwm", "channel": 0 } }
  ],
  "encoders": [
    { "name": "fl_enc", "joint": "fl_drive_joint",
      "countsPerRevolution": 2048,
      "hal": { "kind": "encoder", "index": 0 } }
  ],
  "imu": null
}</code></pre>
      <ul>
        <li><code>world</code> must be <code>mars</code>, and so must the SDF's
        <code>&lt;world name&gt;</code>. Standard gz-sim topics embed it.</li>
        <li><code>model</code> is the <code>&lt;model name&gt;</code> of the robot inside the
        world.</li>
        <li><code>sdf</code> lets <code>check.py</code> verify the actuator order against the plugin
        block. Leaving it out disables the one check that catches crossed motors.</li>
        <li><code>gearRatio</code> is a <em>reduction</em>: motor turns per output turn. Encoders
        report on the motor shaft, before the reduction, like a Falcon or Kraken.</li>
        <li>The <code>hal</code> block is filled in even on the <code>vendor</code> profile, so you
        can migrate a mechanism to PWM later without rewriting the map.</li>
      </ul>`,
  },
  {
    id: "profiles",
    title: "8 · Which profile your robot needs",
    svg: "network.svg",
    html: `
      <p>The distinction that shapes the whole project: <strong>the HALSim WebSocket protocol does
      not cover CAN motors.</strong> It covers PWM, DIO, AnalogIn, Encoder, Relay, SimDevice and
      DriverStation — everything native to the roboRIO. A TalonFX or SparkMax is simulated by its
      vendor's own API, inside the robot's process, where nothing outside can see it.</p>
      <table>
        <tr><th></th><th>hal</th><th>vendor</th></tr>
        <tr><td>For</td><td>PWM mechanisms, RIO-wired sensors</td><td>CAN drivetrains — most of FRC
        today</td></tr>
        <tr><td>Robot code changes</td><td>None. Load the extension.</td><td>~50 lines in
        <code>simulationPeriodic</code></td></tr>
        <tr><td>Channel</td><td>HALSim WebSocket</td><td>NT4, through the glue</td></tr>
        <tr><td>Status</td><td>Not implemented yet</td><td>Implemented and verified</td></tr>
      </table>
      <p>On the <code>vendor</code> profile your <code>simulationPeriodic</code> has to, every
      cycle:</p>
      <ol>
        <li>publish what the vendor is asking the motor for — the duty on
        <code>/MARS/Glue/out/&lt;name&gt;/duty</code>, or the angle on
        <code>/MARS/Glue/out/&lt;name&gt;/setpoint</code> if that actuator closes position;</li>
        <li>read <code>/MARS/Glue/in/&lt;name&gt;/position</code> and <code>/velocity</code> and
        inject them with <code>setRawRotorPosition</code> / <code>setRotorVelocity</code>.</li>
      </ol>
      <p>The ready-made glue for a Tuner X swerve is in <code>sim/glue/java/</code>. It
      <em>replaces</em> the <code>updateSimState()</code> call in the drivetrain's 250 Hz notifier,
      which swaps CTRE's kinematic sim for Gazebo's physics without duplicating a line of swerve
      logic.</p>`,
  },
  {
    id: "checklist",
    title: "9 · Checklist before you press Start",
    svg: "status-ok.svg",
    html: `
      <ol>
        <li>The world declares <code>&lt;world name="mars"&gt;</code>.</li>
        <li>The world carries the physics system and the scene broadcaster.</li>
        <li>Every dynamic link has a mass and a physical inertia tensor, including reflected rotor
        inertia on geared joints.</li>
        <li>Collision geometry is primitives, not meshes.</li>
        <li>The <code>&lt;actuator&gt;</code> order in the SDF matches the actuator order in the
        robot map, and the control modes agree.</li>
        <li><code>python sim/protocol/check.py</code> passes.</li>
        <li>Everything on the <strong>Diagnostics</strong> page is green.</li>
      </ol>
      <p>Then start it, and watch the real-time factor. If it does not hold 1.0, the model is too
      heavy — simplify it. Do not lower the RTF: below about 0.95 your robot code is running its
      20 ms loop against physics that are falling behind, and gains tuned there will not transfer
      to the real robot.</p>`,
  },
];

export function guidePage() {
  const body = el(
    "div.stack",
    el(
      "div.bevel",
      el("div.bevel-title", el("img", { src: "icons/import-model.svg", width: 14, height: 14, alt: "" }), el("span.label", "Contents")),
      el(
        "div",
        ...SECTIONS.map((s, i) =>
          el(
            "div.list-row",
            {
              onclick: () => document.getElementById(`sec-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
            },
            el("img", { src: `icons/${s.svg}`, width: 15, height: 15, alt: "" }),
            el("span", s.title),
            el("span.desc", `§${i + 1}`)
          )
        )
      )
    ),
    ...SECTIONS.map((s) =>
      el(
        "div.panel",
        { id: `sec-${s.id}` },
        el(
          "div.panel-title",
          el("img", { src: `icons/${s.svg}`, width: 14, height: 14, alt: "" }),
          el("span.label", s.title)
        ),
        el("div.panel-body", el("div.doc", { html: s.html }))
      )
    ),
    el(
      "div.panel",
      el("div.panel-title", el("span.label", "Where to go next")),
      el(
        "div.panel-body",
        el(
          "div.row-wrap",
          button("World Library", { svg: "scene.svg", onclick: () => navigate("worlds") }),
          button("Robot Library", { svg: "robot.svg", onclick: () => navigate("robots") }),
          button("Protocol reference", { svg: "network.svg", onclick: () => navigate("protocol") }),
          button("Diagnostics", { svg: "watchdog.svg", onclick: () => navigate("diagnostics") })
        )
      )
    )
  );

  return {
    title: "Import Guide",
    meta: "Bringing your own SDF model into the simulation",
    help: "guide.sdf-model",
    width: "narrow",
    body,
  };
}
