// Startup.
//
// The order matters: first the error handler, then everything else. The first
// version of this app died reading `window.__TAURI__` --- it was turned off in
// tauri.conf.json --- and since the handler was installed further down, the
// window stayed on "looking for the simulation" saying absolutely nothing. A
// dead UI that does not explain why is worse than one that does not open.

import { invoke, migratePrefs, state, tauriReady } from "./core.js";
import { mount, navigate, refreshStatus, setSimPath } from "./shell.js";
import { Progress, closeSplash } from "./splash.js";
import { openWelcome } from "./welcome.js";

window.addEventListener("error", (e) => {
  console.error(e.error ?? e.message);
  const box = document.getElementById("splash-error");
  if (box && !document.querySelector(".app-root")) {
    box.textContent = `The interface failed to start: ${e.message}`;
    box.style.display = "block";
  }
});
window.addEventListener("unhandledrejection", (e) => console.error(e.reason));

async function start() {
  const p = new Progress();

  try {
    // The first step is checking the bridge, not using it: if
    // `withGlobalTauri` is off, every other step would fail with the same
    // useless error.
    await p.run("bridge", async () => {
      if (!tauriReady) {
        throw new Error(
          "window.__TAURI__ is undefined — withGlobalTauri must be true in tauri.conf.json."
        );
      }
    });

    state.options = await p.run(
      "options",
      () => invoke("sim_options"),
      (o) => o.sim_dir
    );

    state.prefs = await p.run(
      "prefs",
      async () => migratePrefs((await invoke("sim_prefs")) ?? {}),
      (prefs) => (Object.keys(prefs).length ? "restored" : "first run")
    );

    state.worlds = await p.run(
      "worlds",
      () => invoke("sim_worlds"),
      (m) => `${m.length} found`
    );

    state.robots = await p.run(
      "robots",
      () => invoke("sim_robots"),
      (r) => `${r.length} found`
    );

    // Fields are loaded at startup and not only when their page opens: the
    // world editor needs the list to be able to offer them.
    state.fields = await p.run(
      "fields",
      () => invoke("sim_fields"),
      (c) => {
        const installed = c.filter((x) => x.installed).length;
        return installed ? `${installed} installed` : `${c.length} available`;
      }
    );

    // The checks do not block startup: the app opens anyway with a broken
    // installation, because the Diagnostics page is exactly where it gets
    // fixed. But it is worth knowing before pressing Start, so the result is
    // summarized here.
    const checks = await p.run(
      "checks",
      () => invoke("sim_diagnostics"),
      (c) => {
        const bad = c.filter((x) => x.status === "fail").length;
        return bad ? `${bad} problem${bad > 1 ? "s" : ""}` : "all good";
      }
    );
    state.checks = checks;

    await p.run("ui", async () => {
      mount();
      // After mounting and not before: `setSimPath` writes into a node of the
      // menu bar, and that bar does not exist until here.
      setSimPath(state.options.sim_dir);
      navigate(state.prefs.lastPage ?? "launch", null, true);
    });
  } catch {
    // `Progress` already left the step marked red with its reason. Staying
    // on the loading screen is deliberate: it is where the explanation is.
    return;
  }

  // The poll is the only thing that runs on its own: process status every
  // 700 ms, which is fast enough to notice a crash and slow enough to cost
  // nothing.
  const poll = async () => {
    try {
      const s = await invoke("sim_status");
      refreshStatus(s);
      await state.tick?.(s);
    } catch (e) {
      console.warn(e);
    }
  };
  await poll();
  setInterval(poll, 700);

  closeSplash();

  // The portal opens after the splash, not on top of it: two layers at once
  // over a window nobody has seen yet is disorienting.
  setTimeout(() => openWelcome(), 360);
}

start();
