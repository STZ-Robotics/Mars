import React from "react"
import ReactDOM from "react-dom/client"
import "@tabler/icons-webfont/dist/tabler-icons.min.css"
import "@desktop/styles/global.css"
import "./styles/ares.css"
import App from "./App"
import { applyMotion } from "./settings/settings"

applyMotion()

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// The app driving itself (harness/selftest.sh): development only, never in a build.
if (import.meta.env.DEV && import.meta.env.VITE_ARES_SELFTEST === "1") import("../harness/selftest")
