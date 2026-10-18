import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { propertyInputStyle } from "@desktop/styles/pageForm"

// A name asked for inside the app, instead of the webview's native prompt
// (a window of the system's, that can open behind the app and wait there).

/** Asks for a line of text; null when cancelled. */
export function askText(title: string, initial = "", hint?: string): Promise<string | null> {
  return new Promise(resolve => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    const done = (v: string | null) => {
      root.unmount()
      host.remove()
      resolve(v)
    }
    root.render(<Ask title={title} initial={initial} hint={hint} onDone={done} />)
  })
}

function Ask({ title, initial, hint, onDone }: { title: string; initial: string; hint?: string; onDone: (v: string | null) => void }) {
  const [text, setText] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.select() }, [])
  const ok = () => { const v = text.trim(); onDone(v || null) }
  return (
    <div className="ares-fade" onMouseDown={e => { if (e.target === e.currentTarget) onDone(null) }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.18)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "18vh" }}>
      <div className="ares-pop" style={{ width: 380, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "0 12px 32px rgba(0,0,0,0.22)", padding: "14px 16px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: hint ? 4 : 10 }}>{title}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.45 }}>{hint}</div>}
        <input ref={input} autoFocus value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") ok(); if (e.key === "Escape") onDone(null) }}
          style={{ ...propertyInputStyle, width: "100%", height: 26, fontSize: 12.5 }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 12 }}>
          <button onClick={() => onDone(null)} style={{ height: 26, padding: "0 12px", fontSize: 12, cursor: "pointer", border: "1px solid var(--btn-classic-border)", background: "var(--btn-classic-bg)", borderRadius: 2 }}>Cancel</button>
          <button onClick={ok} style={{ height: 26, padding: "0 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--ares-accent)", background: "var(--ares-accent)", color: "#ffffff", borderRadius: 2 }}>OK</button>
        </div>
      </div>
    </div>
  )
}
