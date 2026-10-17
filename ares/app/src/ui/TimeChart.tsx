import { useEffect, useRef, useState } from "react"

/** A row of a TimeChart: the time, the series' values, and maybe a label for the hover. */
export type Row = { t: number; active?: string }

/**
 * One measure over time; one or more series, with a legend and a hover
 * readout. With `span`, the last `span` seconds ("now" at the right); without,
 * the whole of `rows`. `marker` draws a vertical line at that time.
 */
export default function TimeChart<R extends Row>({ title, unit, rows, series, symmetric, span, marker, onPick }: {
  title: string; unit: string; rows: R[]; series: [keyof R & string, string, string][]
  symmetric?: boolean; span?: number; marker?: number | null; onPick?: (t: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(300)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = host.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const h = 150, pad = { l: 40, r: 10, t: 8, b: 20 }
  const last = rows.length ? rows[rows.length - 1].t : span ?? 1
  const t0 = span !== undefined ? last - span : rows.length ? rows[0].t : 0
  const width = Math.max(1e-6, span ?? last - t0)
  const num = (r: R, k: keyof R) => { const v: unknown = r[k]; return typeof v === "number" ? v : NaN }
  const vals = rows.flatMap(r => series.map(([k]) => num(r, k))).filter(Number.isFinite)
  const top = Math.max(0.1, ...vals.map(Math.abs)) * 1.15
  const lo = symmetric ? -top : 0
  const sx = (t: number) => pad.l + (t - t0) / width * (w - pad.l - pad.r)
  const sy = (v: number) => pad.t + (1 - (v - lo) / (top - lo)) * (h - pad.t - pad.b)
  const hp = hover !== null ? rows[hover] : null
  const timeAt = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return t0 + (e.clientX - r.left - pad.l) / (w - pad.l - pad.r) * width
  }
  const path = (k: keyof R) => {
    let d = "", pen = false
    for (const r of rows) {
      const v = num(r, k)
      if (!Number.isFinite(v)) { pen = false; continue }
      d += `${pen ? "L" : "M"}${sx(r.t)},${sy(v)}`
      pen = true
    }
    return d
  }
  return (
    <div style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--border-light)", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px 0", fontSize: 11 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 10, color: "var(--text-secondary)" }}>
          {series.length > 1 && series.map(([, color, label]) => (
            <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, borderTop: `2px solid ${color}` }} />{label}</span>
          ))}
        </span>
      </div>
      <div ref={host} style={{ position: "absolute", left: 0, right: 0, top: 24, bottom: 0 }}>
        <svg width={w} height={h} onMouseLeave={() => setHover(null)} style={{ cursor: onPick ? "pointer" : undefined }}
          onClick={e => onPick?.(timeAt(e))}
          onMouseMove={e => {
            const t = timeAt(e)
            let best = -1, d = Infinity
            rows.forEach((r, i) => { const x = Math.abs(r.t - t); if (x < d) { d = x; best = i } })
            setHover(best >= 0 ? best : null)
          }}>
          {[lo, (lo + top) / 2, top].map(v => (
            <g key={v}>
              <line x1={pad.l} x2={w - pad.r} y1={sy(v)} y2={sy(v)} stroke="rgba(0,0,0,0.08)" />
              <text x={pad.l - 5} y={sy(v) + 3} textAnchor="end" fontSize={9.5} fill="var(--text-secondary)">{v.toFixed(Math.abs(top) < 1 ? 2 : 1)}</text>
            </g>
          ))}
          <text x={pad.l} y={h - 5} fontSize={9.5} fill="var(--text-secondary)">{span !== undefined ? `−${span} s` : `${t0.toFixed(1)} s`}</text>
          <text x={w - pad.r} y={h - 5} textAnchor="end" fontSize={9.5} fill="var(--text-secondary)">{span !== undefined ? "now" : `${last.toFixed(1)} s`} · {unit}</text>
          {series.map(([k, color]) => (
            <path key={k} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" d={path(k)} />
          ))}
          {marker != null && <line x1={sx(marker)} x2={sx(marker)} y1={pad.t} y2={h - pad.b} stroke="#1c1c1f" strokeWidth={1.5} />}
          {hp && <line x1={sx(hp.t)} x2={sx(hp.t)} y1={pad.t} y2={h - pad.b} stroke="var(--text-muted)" />}
        </svg>
        {hp && (
          <div style={{ position: "absolute", left: Math.min(sx(hp.t) + 8, w - 150), top: 6, background: "var(--bg-page)", border: "1px solid var(--border-dark)", padding: "3px 7px", fontSize: 10.5, pointerEvents: "none" }}>
            {span === undefined && <div style={{ color: "var(--text-muted)" }}>t = {hp.t.toFixed(2)} s</div>}
            {series.map(([k, , label]) => <div key={label}>{label} {Number.isFinite(num(hp, k)) ? num(hp, k).toFixed(3) : "—"} {unit}</div>)}
            {hp.active && <div style={{ color: "var(--text-muted)" }}>{hp.active}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
