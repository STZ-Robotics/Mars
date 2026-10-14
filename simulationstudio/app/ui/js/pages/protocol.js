// Protocol: the reference for the contract between the three processes.
//
// The text is summarized from sim/protocol/README.md, and topics.toml is read
// from disk instead of copied: it is the single source of truth for topic
// names, and the bridge's build.rs reads it at compile time. A copy here
// would drift on day one.

import { el, invoke } from "./../core.js";
import { navigate, report } from "./../shell.js";
import { button, panel } from "./../ui.js";

const HOPS = `  robot code                     bridge (Rust)              engine (C++)
  ──────────                     ─────────────              ────────────
  simulateJava / roboRIO                                    gz-sim headless

       │  (2) HALSim WS               │  (1) gz-transport        │
       │  ws://localhost:3300         │  protobuf, local IPC     │
       │  JSON, robot = client   ◄────┤  bridge = subscriber ◄───┤
       │                              │                          │
       │  (3) NT4 :5810               │                          │
       └──► robot = SERVER     ◄──────┤                          │
                   ▲                  │
                   │                  │
             MARS Desktop (client) ───┘`;

export function protocolPage() {
  const toml = el("pre.log", { style: { height: "300px" } }, "Reading protocol/topics.toml…");
  invoke("sim_read_text", { path: "protocol/topics.toml" })
    .then((t) => (toml.textContent = t))
    .catch((e) => (toml.textContent = `Could not read protocol/topics.toml:\n${e.message}`));

  const body = el(
    "div.stack",

    panel(
      "The three hops",
      { svg: "network.svg", help: "protocol.topics" },
      el("div.doc", { html: "<p>A running simulation is three processes and three channels between them.</p>" }),
      el("pre.log", { style: { height: "auto" } }, HOPS),
      el("div.doc", {
        html: `
          <h4>Three role decisions worth not revisiting lightly</h4>
          <p><strong>The bridge is the WebSocket server, not the client.</strong> Robot code loads
          <code>halsim_ws_client</code> and connects towards us. It works the other way too, but
          robot code restarts every time the team compiles and the app is the long-lived process —
          having the ephemeral one connect means restarting robot code does not tear down the
          simulation.</p>
          <p><strong>The NT4 server is not ours.</strong> Robot code brings it up on
          <code>:5810</code>, like a real robot. Bridge and dashboard are both clients. This is what
          keeps a simulated match indistinguishable from a real one on the dashboard side — the same
          NT4 client code serves both, with no "simulation mode" branch.</p>
          <p><strong>The engine speaks neither NT4 nor WebSocket.</strong> Only gz-transport. All the
          glue lives in the bridge, so the engine can be tested on its own with a script that
          publishes actuators and reads joints, without standing up any of WPILib.</p>`,
      })
    ),

    panel(
      "Who owns the clock",
      { svg: "loop-timing.svg", help: "world.physics.rtf" },
      el("div.doc", {
        html: `
          <p><strong>Nobody, and you need to know that.</strong> The wpilibws protocol has no clock
          message: there is no way for the simulation to impose its time on the robot's HAL. The two
          clocks run on wall time, in parallel, unsynchronised.</p>
          <p>In practice it works if and only if Gazebo holds a real-time factor of 1.0. That is why
          the RTF is published on <code>/MARS/Sim/realTimeFactor</code> and is not decorative — it is
          the validity metric of the whole loop. Held below about 0.95, robot code is running its
          20 ms cycle against physics that are falling behind, and any PID gain tuned there will not
          transfer to the real robot.</p>
          <p>This puts a hard ceiling on model detail: if the robot is too heavy to simulate at 1.0,
          simplify the robot. Do not lower the RTF.</p>`,
      })
    ),

    panel(
      "Conventions that bite",
      { svg: "axes.svg", help: "protocol.axes" },
      el("div.doc", {
        html: `
          <table>
            <tr><th>Thing</th><th>Rule</th></tr>
            <tr><td>Axes</td><td>Gazebo is ENU: Z up, yaw CCW-positive from X. WPILib shares the yaw
            sense but measures from the far-wall axis, origin at the alliance corner. The bridge
            converts both origin and rotation, so neither engine nor glue knows which alliance you
            are.</td></tr>
            <tr><td>Units</td><td>SI and radians inside gz-transport, always. Conversion to degrees
            and WPILib conventions happens once, at the bridge's NT4 edge. A value in degrees inside
            the engine is a bug.</td></tr>
            <tr><td>Gear ratios</td><td>A reduction: motor turns per output turn. Encoders report on
            the motor shaft, before the reduction, like Falcon and Kraken integrated
            encoders.</td></tr>
            <tr><td>Wheel radius</td><td>Not in the robot map. It comes from the SDF collision
            geometry, the only radius the physics respects.</td></tr>
          </table>`,
      })
    ),

    panel(
      "Out of scope in 0.1.0",
      { svg: "status-unknown.svg" },
      el("div.doc", {
        html: `
          <ul>
            <li><strong>Cameras and vision.</strong> Needs <code>gz-sensors</code> with rendering and
            OGRE2. The environment already has them; the engine does not load those plugins. When it
            lands it is a new profile, not a protocol change.</li>
            <li><strong>Game pieces and scoring.</strong> The world is the robot and the floor — props
            you add in the editor are geometry, not game logic.</li>
            <li><strong>Multiple robots.</strong> The <code>/mars/</code> namespace carries no robot
            index yet. Adding one is a major version change.</li>
            <li><strong>Dynamic message introspection.</strong> The conda-forge
            <code>gz-msgs12.gz_desc</code> descriptor does not parse here (protobuf mismatch), so
            <code>gz topic --echo</code> on arbitrary types does not work in this environment. The
            protocol sticks to standard <code>gz.msgs</code> types, whose static C++ pub/sub never
            touches the descriptor.</li>
          </ul>`,
      })
    ),

    panel(
      "topics.toml",
      {
        svg: "model-file.svg",
        help: "protocol.topics",
        actions: button("Reveal", {
          sm: true,
          svg: "open-folder.svg",
          onclick: () => invoke("sim_reveal", { path: "protocol/topics.toml" }).catch(report),
        }),
      },
      el("div.doc", {
        html: `<p>The single source of truth for topic names and field dimensions. Not aspirational:
               the bridge's <code>build.rs</code> reads it at compile time and emits the constants, so
               renaming a topic here breaks the bridge's build rather than the simulation at
               runtime.</p>`,
      }),
      toml
    )
  );

  return {
    title: "Protocol",
    meta: "The contract between engine, bridge and robot code",
    help: "protocol.topics",
    width: "narrow",
    actions: [button("Import guide", { svg: "import-model.svg", sm: true, onclick: () => navigate("guide") })],
    body,
  };
}
