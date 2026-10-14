// Startup, and saving and restoring the workspace layout.

import { useEffect, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { MARS_ENABLED } from "@mars"
import { MARS_PRODUCT_NAME } from "../constants/edition"
import type { AppState } from "../store/appStore"
import { loadLayout, saveLayout } from "../store/workspacePersistence"
import { useMarkerStore } from "../store/markerStore"
import { useSysIdStore } from "../store/sysidStore"
import { SplashProgress } from "../utils/splash"

export function useWorkspacePersistence(state: AppState, setState: Dispatch<SetStateAction<AppState>>) {
  // Nothing is autosaved until the saved layout has finished loading:
  // otherwise the first render (with empty openTabs) would overwrite the file
  // before reading it.
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const markers = useMarkerStore(s => s.markers)
  const setMarkers = useMarkerStore(s => s.setMarkers)
  const sysid = useSysIdStore(s => s.config)
  const setSysidConfig = useSysIdStore(s => s.setConfig)
  const saveTimerRef = useRef<number | null>(null)
  const bootRef = useRef<SplashProgress | null>(null)

  // The startup sequence. Each step is a real backend call and moves the
  // splash's bar: the percentage counts finished steps, not made-up time. None
  // is essential -- the app opens anyway with no preferences, no project and
  // no saved layout -- so a failure stays marked red and startup goes on.
  useEffect(() => {
    let cancelled = false
    const boot = new SplashProgress()
    bootRef.current = boot

    // tauri.conf.json knows nothing about editions: the right title is only
    // known from the bundle. In Full this rewrites the same text and nobody
    // notices.
    void getCurrentWindow().setTitle(MARS_PRODUCT_NAME).catch(() => {})

    void (async () => {
      const settings = await boot.run(
        "prefs",
        () => invoke<{ workspace_path: string; team_number: string }>("read_mars_settings"),
        s => s.team_number ? `team ${s.team_number}` : "no team number",
      )

      // With no MARS framework there is no project: the step is not even listed
      // (see splash.ts).
      if (MARS_ENABLED) {
        const projectPath = settings?.workspace_path ?? ""
        if (projectPath) {
          await boot.run("project", () => invoke<string>("validate_mars_project", { path: projectPath }), name => name)
        } else {
          boot.skip("project", "not configured")
        }
      }

      await boot.run(
        "assets",
        () => invoke<unknown[]>("list_asset3d_packs"),
        packs => `${packs.length} pack${packs.length === 1 ? "" : "s"}`,
      )

      const layout = await boot.run(
        "layout",
        () => loadLayout(),
        l => l === null ? "nothing saved" : `${l.openTabs.length} tab${l.openTabs.length === 1 ? "" : "s"}`,
      )
      if (!cancelled && layout !== null) {
        setState(prev => ({ ...prev, openTabs: layout.openTabs, activeTabId: layout.activeTabId }))
        setSidebarCollapsed(layout.sidebarCollapsed)
        setMarkers(layout.markers)
        setSysidConfig(layout.sysid)
      }

      await boot.run(
        "link",
        () => invoke<{ address: string; port: number; connected: boolean }>("get_nt_link_status"),
        s => s.connected ? `${s.address}:${s.port}` : "offline",
      )

      if (!cancelled) setLayoutLoaded(true)
    })()

    return () => { cancelled = true }
  }, [])

  // The splash comes off when the workspace is already restored, not when
  // React mounted: otherwise a frame of empty app shows right before the saved
  // tabs appear, which is worse than a slightly longer splash. The last step
  // ("Build the interface") is closed right here, which is when it really
  // finished.
  useEffect(() => {
    if (layoutLoaded) bootRef.current?.end()
  }, [layoutLoaded])

  // Debounce: dragging a widget fires dozens of updates per second and there
  // is no point writing the file on each one.
  useEffect(() => {
    if (!layoutLoaded) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveLayout({ openTabs: state.openTabs, activeTabId: state.activeTabId, sidebarCollapsed, markers, sysid })
        .catch(err => console.warn("Could not save the layout:", err))
    }, 700)
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    }
  }, [state.openTabs, state.activeTabId, sidebarCollapsed, markers, sysid, layoutLoaded])

  const handleSaveLayoutAs = async () => {
    try {
      const path = await save({
        title: "Save layout",
        defaultPath: "mars-layout.json",
        filters: [{ name: "MARS layout", extensions: ["json"] }],
      })
      if (!path) return
      await saveLayout({ openTabs: state.openTabs, activeTabId: state.activeTabId, sidebarCollapsed, markers, sysid }, path)
    } catch (error) {
      alert(`Could not save layout:\n${error}`)
    }
  }

  const handleOpenLayout = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: "MARS layout", extensions: ["json"] }] })
      if (!path || typeof path !== "string") return
      const layout = await loadLayout(path)
      if (layout === null) {
        alert("That file does not contain a MARS layout.")
        return
      }
      setState(prev => ({ ...prev, openTabs: layout.openTabs, activeTabId: layout.activeTabId }))
      setSidebarCollapsed(layout.sidebarCollapsed)
      setMarkers(layout.markers)
      setSysidConfig(layout.sysid)
    } catch (error) {
      alert(`Could not open layout:\n${error}`)
    }
  }

  const handleResetLayout = () => {
    if (state.openTabs.length > 0 && !window.confirm("Close every tab and reset the layout?")) return
    setState(prev => ({ ...prev, openTabs: [], activeTabId: null }))
  }

  return {
    sidebarCollapsed, setSidebarCollapsed,
    handleSaveLayoutAs, handleOpenLayout, handleResetLayout,
  }
}
