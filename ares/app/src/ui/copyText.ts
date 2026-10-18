/**
 * Copies text: the clipboard API, or the older way when the webview refuses
 * it. True only when it was copied, so nobody is told "Copied" for nothing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;opacity:0;left:-9999px"
    document.body.appendChild(area)
    area.select()
    let ok = false
    try { ok = document.execCommand("copy") } catch { /* refused too */ }
    area.remove()
    return ok
  }
}
