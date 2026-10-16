import { ReactNode } from "react"

interface Props {
  children: ReactNode
  onClick?: () => void
}

// Full-width ghost button for destructive/reset actions
// ("RESET SESSION STATS", "CLEAR ALL FILTERS"), repeated identically in
// WatchDogPage, ManifestPage, ProjectVariablesPage and TelemetryPage.
export default function DangerButton({ children, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 0", background: "var(--status-error-bg)",
        border: "1px solid var(--status-error-border)", borderRadius: 3,
        color: "var(--status-error)", fontSize: 11, fontWeight: 600, cursor: "pointer",
        width: "100%",
      }}
    >
      {children}
    </button>
  )
}
