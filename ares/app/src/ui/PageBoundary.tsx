import { Component, ReactNode } from "react"

// An error in one tab stays in that tab: it shows what broke, and the menu,
// the rail and the other tabs keep working. Without it, React takes the whole
// window down and leaves it blank.

interface State { error: Error | null }

export default class PageBoundary extends Component<{ name: string; children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`The ${this.props.name} tab broke:`, error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="ares-fade" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-page)", padding: 24 }}>
        <div style={{ maxWidth: 640, width: "100%", border: "1px solid var(--border-dark)", background: "var(--bg-panel)", padding: "16px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600 }}>
            <i className="ti ti-alert-triangle" style={{ color: "#c21c1c", fontSize: 18 }} />
            The {this.props.name} tab hit an error
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "8px 0", lineHeight: 1.5 }}>
            Nothing was lost: the other tabs work, and what is saved is saved. Try again, and if it happens again, send this to whoever keeps Ares.
          </div>
          <pre style={{ fontSize: 10.5, background: "var(--bg-page)", border: "1px solid var(--border-light)", padding: 8, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", margin: "0 0 10px" }}>
            {String(error.stack ?? error.message)}
          </pre>
          <button onClick={() => this.setState({ error: null })}
            style={{ height: 28, padding: "0 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--ares-accent)", background: "var(--ares-accent)", color: "#ffffff", borderRadius: 2 }}>
            <i className="ti ti-refresh" /> Try again
          </button>
        </div>
      </div>
    )
  }
}
