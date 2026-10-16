import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react"

// In-app notifications, stacked in the bottom-right corner: what finished,
// what was stopped, what failed. They go away on their own (errors stay
// longer) or with their ×.

export type ToastKind = "success" | "stopped" | "error" | "info"

export interface Toast { id: number; kind: ToastKind; title: string; body?: string }

const STYLE: Record<ToastKind, { icon: string; color: string; ms: number }> = {
  success: { icon: "ti-circle-check", color: "#16a34a", ms: 5000 },
  stopped: { icon: "ti-player-stop", color: "#d97706", ms: 5000 },
  error: { icon: "ti-alert-triangle", color: "#c21c1c", ms: 10000 },
  info: { icon: "ti-info-circle", color: "#2f6fdb", ms: 5000 },
}

const Ctx = createContext<(t: Omit<Toast, "id">) => void>(() => {})

export function useToast() {
  return useContext(Ctx)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = next.current++
    // At most five on screen: the oldest goes first.
    setToasts(list => [...list, { ...t, id }].slice(-5))
  }, [])
  const close = (id: number) => setToasts(list => list.filter(t => t.id !== id))
  return (
    <Ctx.Provider value={push}>
      {children}
      <div style={{ position: "fixed", right: 16, bottom: 36, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end", pointerEvents: "none" }}>
        {toasts.map(t => <ToastCard key={t.id} toast={t} onClose={() => close(t.id)} />)}
      </div>
    </Ctx.Provider>
  )
}

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const s = STYLE[toast.kind]
  const [leaving, setLeaving] = useState(false)
  const [hover, setHover] = useState(false)
  useEffect(() => {
    if (hover) return
    const t = setTimeout(() => setLeaving(true), s.ms)
    return () => clearTimeout(t)
  }, [hover, s.ms])
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(onClose, 220)
    return () => clearTimeout(t)
  }, [leaving])
  return (
    <div
      role="status"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        pointerEvents: "auto", width: 340, background: "var(--bg-page)", border: "1px solid var(--border-dark)", borderLeft: `4px solid ${s.color}`,
        boxShadow: "0 6px 18px rgba(0,0,0,0.18)", padding: "9px 10px 9px 12px", display: "flex", gap: 10, alignItems: "flex-start",
        transition: "opacity 200ms ease, transform 200ms ease", opacity: leaving ? 0 : 1, transform: leaving ? "translateX(20px)" : "none",
        animation: "ares-toast-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1)",
      }}
    >
      <style>{"@keyframes ares-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }"}</style>
      <i className={`ti ${s.icon}`} style={{ fontSize: 18, color: s.color, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{toast.title}</div>
        {toast.body && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.45, wordBreak: "break-word" }}>{toast.body}</div>}
      </div>
      <button onClick={() => setLeaving(true)} title="Close"
        style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", padding: 0, fontSize: 14 }}>
        <i className="ti ti-x" />
      </button>
    </div>
  )
}
