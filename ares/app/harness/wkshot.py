#!/usr/bin/env python3
"""A harness page in WebKitGTK, Tauri's engine on Linux, in an offscreen
window: it waits for the page, runs JS steps, prints the page's JS errors and
saves a snapshot after each step.

    W=1300 H=800 python3 harness/wkshot.py <url> <out-prefix> ['[["js", waitMs], ...]']
"""
import json, os, sys
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

url, out = sys.argv[1], sys.argv[2]
steps = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
win = Gtk.OffscreenWindow(); win.set_default_size(int(os.environ.get("W", 1500)), int(os.environ.get("H", 950)))
view = WebKit2.WebView(); win.add(view); win.show_all()
view.get_user_content_manager().add_script(WebKit2.UserScript.new(
    "window.__errs=[];addEventListener('error',e=>__errs.push('error: '+e.message));"
    "addEventListener('unhandledrejection',e=>__errs.push('rejection: '+(e.reason&&e.reason.stack||e.reason)));"
    "const ce=console.error;console.error=(...a)=>{__errs.push('console: '+a.map(String).join(' ').slice(0,400));ce(...a)};",
    WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
state = {"i": -1}

def snap(name, then):
    def done(v, res):
        try: v.get_snapshot_finish(res).write_to_png(f"{out}-{name}.png")
        except Exception as e: print("snapshot failed", e)
        then()
    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)

def report(then):
    def got(v, res):
        try: print("errors:", v.evaluate_javascript_finish(res).to_string())
        except Exception as e: print("eval failed", e)
        then()
    view.evaluate_javascript("JSON.stringify(window.__errs)", -1, None, None, None, got)

def step():
    state["i"] += 1
    i = state["i"]
    if i >= len(steps):
        report(lambda: snap("final", Gtk.main_quit)); return
    js, wait = steps[i]
    view.evaluate_javascript(js, -1, None, None, None, lambda v, r: GLib.timeout_add(wait, lambda: (report(lambda: snap(f"step{i}", step)), False)[1]))

view.connect("load-changed", lambda v, ev: ev == WebKit2.LoadEvent.FINISHED and GLib.timeout_add(2500, lambda: (report(lambda: snap("loaded", step)), False)[1]))
view.load_uri(url)
GLib.timeout_add(60000, Gtk.main_quit)
Gtk.main()
