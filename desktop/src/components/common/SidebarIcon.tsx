import { useEffect, useState } from "react"

interface Props {
  /** File inside public/icons. If it is missing, `svgFallback` is tried. */
  svg?: string
  /** Second SVG to try before falling back to tabler: lets a tool debut
   *  with its sibling's icon until it has its own. */
  svgFallback?: string
  /** Fallback tabler class (e.g. "ti-home"), for the ones that have no SVG yet. */
  fallback: string
  size?: number
  /** Only applies to the fallback: the SVGs come in color and are not tinted. */
  color?: string
}

/**
 * Files that were already requested and do not exist.
 *
 * It lives in the MODULE and not in the component on purpose. Without this,
 * every mount requests the missing file again, shows a broken `<img>` for a
 * frame and only then falls back. In a list that remounts often that looks
 * like constant flicker, and it also spends a 404 per icon per mount.
 *
 * It is never cleared: the icons are static build files, so one that was
 * missing when the app started will stay missing until it reloads.
 */
const missing = new Set<string>()

// The SVGs in public/icons are in color with their own gradients, so they go
// as <img> and NOT inlined: each gradient defines ids like "a"/"b"/"c" and with
// several in the same document they would overwrite each other, leaving icons
// with another one's gradient.
export default function SidebarIcon({ svg, svgFallback, fallback, size = 16, color }: Props) {
  const chain = [svg, svgFallback].filter((s): s is string => typeof s === "string" && s.length > 0)

  // The first file in the chain not already known to be missing. When they are
  // all missing it falls out of range and the tabler glyph is drawn directly,
  // without going through the broken <img>.
  const firstUsable = () => {
    const index = chain.findIndex(name => !missing.has(name))
    return index === -1 ? chain.length : index
  }

  const [step, setStep] = useState(firstUsable)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setStep(firstUsable()), [svg, svgFallback])

  const current = chain[step]

  if (current) {
    return (
      <img
        key={current}
        src={`/icons/${current}`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
        // If the file is not there (renamed, deleted), the browser would show the
        // broken image glyph. It is noted as missing and the next one in the chain
        // is tried, so the row stays recognizable.
        onError={() => {
          missing.add(current)
          setStep(s => s + 1)
        }}
        style={{ width: size, height: size, objectFit: "contain", flexShrink: 0, display: "block" }}
      />
    )
  }

  return (
    <i
      className={`ti ${fallback}`}
      style={{
        fontSize: size - 2,
        color: color ?? "var(--icon-tree)",
        width: size,
        textAlign: "center",
        flexShrink: 0,
      }}
      aria-hidden
    />
  )
}
