import { ReactNode, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { useToast } from "./toasts"

// The robot connection the Measure and Live tabs share: one NT4 client in
// the backend (MARS Desktop's), so connecting in one connects both.

const TARGET_KEY = "ares.ntTarget"

export function useNtConnection(): { connected: boolean; address: string; setConnected: (c: boolean) => void; bar: (extra?: ReactNode) => ReactNode } {
  const toast = useToast()
  const [target, setTarget] = useState(() => { try { return localStorage.getItem(TARGET_KEY) ?? "sim" } catch { return "sim" } })
  const [connected, setConnected] = useState(false)
  const [address, setAddress] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const check = () => invoke<{ connected: boolean; address: string }>("nt_status").then(s => { setConnected(s.connected); setAddress(s.address) }).catch(() => {})
    check()
    const t = setInterval(check, 1000)
    return () => clearInterval(t)
  }, [])
  const connect = async () => {
    setBusy(true)
    try { localStorage.setItem(TARGET_KEY, target) } catch { /* not remembered */ }
    try {
      setAddress(await invoke<string>("nt_connect", { target }))
      setConnected(true)
    } catch (e) {
      toast({ kind: "error", title: "Could not connect", body: `${String(e)}. Is the robot (or the simulation) running?` })
    }
    setBusy(false)
  }
  const disconnect = async () => { await invoke("nt_disconnect").catch(() => {}); setConnected(false) }
  const bar = (extra?: ReactNode) => (
    <div style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", background: "var(--bg-menubar)", borderBottom: "1px solid var(--border-main)", fontSize: 12 }}>
      <i className="ti ti-plug-connected" />
      <span>Robot</span>
      <input style={{ ...propertyInputStyle, width: 150 }} value={target} onChange={e => setTarget(e.target.value)} disabled={connected}
        title={'"sim" for the simulation on this computer, a team number (10.TE.AM.2), or an address (172.22.11.2 over USB)'} />
      {connected
        ? <BarButton icon="ti-plug-x" onClick={disconnect}>Disconnect</BarButton>
        : <BarButton icon="ti-plug" onClick={connect} primary disabled={busy}>{busy ? "Connecting…" : "Connect"}</BarButton>}
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)" }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: connected ? "#16a34a" : "#a1a1aa" }} />
        {connected ? `Connected to ${address}` : "Not connected"}
      </span>
      {extra}
    </div>
  )
  return { connected, address, setConnected, bar }
}

export function BarButton({ icon, children, onClick, primary, danger, disabled }: { icon: string; children: ReactNode; onClick: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  const bg = danger ? "#c21c1c" : primary ? "#e95420" : "var(--btn-classic-bg)"
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ display: "flex", alignItems: "center", gap: 5, height: 26, padding: "0 10px", fontSize: 11.5, fontWeight: primary || danger ? 600 : 400, cursor: disabled ? "default" : "pointer",
        border: `1px solid ${danger ? "#a81818" : primary ? "#c2410c" : "var(--btn-classic-border)"}`, borderRadius: 2, background: bg, color: primary || danger ? "#fff" : "var(--text-primary)", opacity: disabled ? 0.45 : 1 }}>
      <i className={`ti ${icon}`} /> {children}
    </button>
  )
}
