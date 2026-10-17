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
