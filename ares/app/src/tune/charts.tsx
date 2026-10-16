import { ReactNode, useEffect, useRef, useState } from "react"
import type { Candidate, HistoryPoint, Param, World } from "./model"
import { PARAM_INFO } from "./model"

// The Tune tab's three charts. One measure per chart (the score, in meters
// equivalent), one axis each, a legend when there is more than one series,
// and a tooltip on hover.

export const BEST = "#e95420"
export const GEN = "#2f6fdb"
const GRID = "rgba(0,0,0,0.08)"
const INK = "var(--text-secondary)"

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(300)
  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref as React.RefObject<HTMLDivElement>, w]
}

function ticks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo]
  const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / n)))
  const m = [1, 2, 5, 10].find(k => (hi - lo) / (step * k) <= n) ?? 10
  const s = step * m
  const out: number[] = []
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-12; v += s) out.push(+v.toFixed(10))
  return out
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3))

function Frame({ title, legend, children, tip }: { title: string; legend?: ReactNode; children: ReactNode; tip?: ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-light)", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px 0", fontSize: 11 }}>
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{title}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 10, color: INK }}>{legend}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>{children}</div>
      {tip}
    </div>
  )
}

export function Key({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 14, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }} />{label}
    </span>
  )
}

function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div style={{ position: "absolute", left: x + 12, top: y + 8, pointerEvents: "none", background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", padding: "5px 8px", fontSize: 10.5, lineHeight: 1.5, whiteSpace: "nowrap", zIndex: 5 }}>
      {children}
    </div>
  )
}

const PAD = { l: 44, r: 54, t: 10, b: 24 }

/** The best score so far and each generation's spread, generation by generation. */
export function TrainingChart({ history, baseline }: { history: HistoryPoint[]; baseline: number | null }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const h = 170
  const pts = history.filter(p => Number.isFinite(p.best))
  const gens = pts.map(p => p.generation)
  const x0 = Math.min(0, ...gens), x1 = Math.max(1, ...gens)
  const ys = pts.flatMap(p => [p.best, p.genMedian]).filter(Number.isFinite)
  const yTop = Math.max(...ys, baseline ?? 0, 1e-6)
  const sx = (g: number) => PAD.l + (g - x0) / (x1 - x0) * (width - PAD.l - PAD.r)
  const sy = (v: number) => PAD.t + (1 - v / (yTop * 1.05)) * (h - PAD.t - PAD.b)
  const line = (k: "best" | "genMedian") => pts.filter(p => Number.isFinite(p[k])).map((p, i) => `${i ? "L" : "M"}${sx(p.generation)},${sy(p[k])}`).join("")
  const band = pts.length > 1
    ? `M${pts.map(p => `${sx(p.generation)},${sy(Math.min(p.genWorst, yTop * 1.05))}`).join("L")}L${[...pts].reverse().map(p => `${sx(p.generation)},${sy(p.genBest)}`).join("L")}Z`
    : ""
  const last = pts[pts.length - 1]
  const hp = hover !== null ? pts.find(p => p.generation === hover) : null
  return (
    <Frame title="Training" legend={<><Key color={BEST} label="best so far" /><Key color={GEN} label="generation median" /></>}
      tip={hp && <Tip x={sx(hp.generation)} y={sy(hp.best)}>
        <b>Generation {hp.generation}</b><br />
        best so far <b>{fmt(hp.best)}</b><br />
        this generation: {fmt(hp.genBest)} best · {fmt(hp.genMedian)} median · {fmt(hp.genWorst)} worst
      </Tip>}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }}>
        <svg width={width} height={h} onMouseLeave={() => setHover(null)}
          onMouseMove={e => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            const g = x0 + (e.clientX - r.left - PAD.l) / (width - PAD.l - PAD.r) * (x1 - x0)
            const near = pts.reduce<HistoryPoint | null>((a, p) => (!a || Math.abs(p.generation - g) < Math.abs(a.generation - g) ? p : a), null)
            setHover(near?.generation ?? null)
          }}>
          {ticks(0, yTop * 1.05).map(v => (
            <g key={v}>
              <line x1={PAD.l} x2={width - PAD.r} y1={sy(v)} y2={sy(v)} stroke={GRID} />
              <text x={PAD.l - 6} y={sy(v) + 3} textAnchor="end" fontSize={9.5} fill={INK}>{fmt(v)}</text>
            </g>
          ))}
          {ticks(x0, x1, 6).filter(Number.isInteger).map(g => (
            <text key={g} x={sx(g)} y={h - 8} textAnchor="middle" fontSize={9.5} fill={INK}>{g}</text>
          ))}
          <path d={band} fill={GEN} opacity={0.1} />
          <path d={line("genMedian")} stroke={GEN} strokeWidth={2} fill="none" strokeLinejoin="round" />
          <path d={line("best")} stroke={BEST} strokeWidth={2} fill="none" strokeLinejoin="round" />
          {baseline !== null && (
            <g>
              <line x1={PAD.l} x2={width - PAD.r} y1={sy(baseline)} y2={sy(baseline)} stroke="var(--text-muted)" strokeDasharray="4 4" />
              <text x={width - PAD.r + 4} y={sy(baseline) + 3} fontSize={9.5} fill={INK}>now</text>
            </g>
          )}
          {last && <text x={sx(last.generation) + 6} y={sy(last.best) + 3} fontSize={10} fontWeight={600} fill="var(--text-primary)">{fmt(last.best)}</text>}
          {hp && <line x1={sx(hp.generation)} x2={sx(hp.generation)} y1={PAD.t} y2={h - PAD.b} stroke="var(--text-muted)" />}
          {hp && <circle cx={sx(hp.generation)} cy={sy(hp.best)} r={4} fill={BEST} stroke="var(--bg-page)" strokeWidth={2} />}
        </svg>
      </div>
    </Frame>
  )
}

/** The best's score in each world, with the gains you have now as a tick. */
export function WorldsChart({ best, baseline, worlds, hovered, onHover }: {
  best: Candidate | null; baseline: Candidate | null; worlds: World[]; hovered: number | null; onHover: (i: number | null) => void
}) {
  const [ref, width] = useWidth()
  const h = 170
  const n = best?.perEnv.length ?? 0
  const top = Math.max(1e-6, ...(best?.perEnv ?? []), ...(baseline?.perEnv ?? []))
  const bw = n ? (width - PAD.l - 12) / n : 0
  const sy = (v: number) => PAD.t + (1 - v / (top * 1.08)) * (h - PAD.t - PAD.b)
  const worst = best ? best.perEnv.indexOf(Math.max(...best.perEnv)) : -1
  const w = hovered !== null ? worlds[hovered] : null
  return (
    <Frame title="Cost in each world" legend={<><Key color={GEN} label="best gains" /><Key color="var(--text-muted)" label="gains now" dashed /></>}
      tip={w && best && hovered !== null && <Tip x={PAD.l + (hovered + 0.5) * bw} y={sy(best.perEnv[hovered])}>
        <b>World {hovered === 0 ? "0 (nominal)" : hovered}</b>: best {fmt(best.perEnv[hovered])}{baseline ? ` · now ${fmt(baseline.perEnv[hovered])}` : ""}<br />
        {w.massKg.toFixed(1)} kg · μ {w.mu.toFixed(2)} · {w.batteryV.toFixed(1)} V, {(w.batteryROhm * 1000).toFixed(0)} mΩ<br />
        wheel {(w.wheelRadiusM * 1000).toFixed(1)} mm · motor ×{w.motorScale.toFixed(2)} · {(w.latencyS * 1000).toFixed(0)} ms<br />
        placed off {(w.startOffsetXM * 100).toFixed(1)}, {(w.startOffsetYM * 100).toFixed(1)} cm, {(w.startOffsetRad * 180 / Math.PI).toFixed(1)}°
      </Tip>}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }}>
        <svg width={width} height={h} onMouseLeave={() => onHover(null)}>
          {ticks(0, top * 1.08).map(v => (
            <g key={v}>
              <line x1={PAD.l} x2={width - 12} y1={sy(v)} y2={sy(v)} stroke={GRID} />
              <text x={PAD.l - 6} y={sy(v) + 3} textAnchor="end" fontSize={9.5} fill={INK}>{fmt(v)}</text>
            </g>
          ))}
          {best?.perEnv.map((c, i) => {
            const x = PAD.l + i * bw
            const bh = Math.max(1, sy(0) - sy(c))
            return (
              <g key={i} onMouseEnter={() => onHover(i)}>
                <rect x={x} y={PAD.t} width={bw} height={h - PAD.t - PAD.b} fill="transparent" />
                <path d={`M${x + 1},${sy(0)} V${sy(c) + Math.min(4, bh)} q0,-4 4,-4 H${x + bw - 5} q4,0 4,4 V${sy(0)} Z`}
                  fill={GEN} opacity={hovered === null || hovered === i ? 1 : 0.45} />
                {baseline && <line x1={x + 1} x2={x + bw - 1} y1={sy(baseline.perEnv[i])} y2={sy(baseline.perEnv[i])} stroke="var(--text-muted)" strokeWidth={2} strokeDasharray="3 2" />}
              </g>
            )
          })}
          {worst >= 0 && best && <text x={PAD.l + (worst + 0.5) * bw} y={sy(best.perEnv[worst]) - 5} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--text-primary)">worst</text>}
          <text x={PAD.l} y={h - 8} fontSize={9.5} fill={INK}>world 0 (nominal) →</text>
        </svg>
      </div>
    </Frame>
  )
}

/** This generation's gain sets on two of the tuned gains, darker the better. */
export function PopulationChart({ population, best, params }: { population: Candidate[]; best: Candidate | null; params: Param[] }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const h = 170
  const tuned = params.map((p, i) => ({ p, i })).filter(q => q.p.tune)
  const [a, b] = [tuned[0], tuned[1] ?? tuned[0]]
  if (!a) return <Frame title="Population"><div style={{ padding: 12, fontSize: 11, color: INK }}>Tune at least one gain.</div></Frame>
  const scale = (q: { p: Param }) => (v: number) => {
    const u = q.p.log && q.p.min > 0 ? (Math.log(v) - Math.log(q.p.min)) / (Math.log(q.p.max) - Math.log(q.p.min)) : (v - q.p.min) / (q.p.max - q.p.min || 1)
    return Math.min(1, Math.max(0, u))
  }
  const ux = scale(a), uy = scale(b)
  const sx = (v: number) => PAD.l + ux(v) * (width - PAD.l - 16)
  const sy = (v: number) => PAD.t + (1 - uy(v)) * (h - PAD.t - PAD.b)
  const ranked = [...population].sort((p, q) => p.score - q.score)
  const shade = (rank: number) => {
    // One hue, light (worse) to dark (better).
    const f = ranked.length > 1 ? 1 - rank / (ranked.length - 1) : 1
    const l = 82 - f * 47
    return `hsl(217 70% ${l}%)`
  }
  const hp = hover !== null ? ranked[hover] : null
  return (
    <Frame title="Population" legend={<span>darker = better · <span style={{ color: BEST }}>●</span> best so far</span>}
      tip={hp && <Tip x={sx(hp.values[a.i])} y={sy(hp.values[b.i])}>
        score <b>{fmt(hp.score)}</b>{hp.aborts ? ` · ${hp.aborts} runs lost the path` : ""}<br />
        {tuned.map(q => <span key={q.i}>{PARAM_INFO[q.p.key].label} {fmt(hp.values[q.i])}<br /></span>)}
      </Tip>}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }}>
        <svg width={width} height={h} onMouseLeave={() => setHover(null)}>
          <line x1={PAD.l} x2={width - 16} y1={h - PAD.b} y2={h - PAD.b} stroke={GRID} />
          <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={h - PAD.b} stroke={GRID} />
          <text x={width - 16} y={h - 8} textAnchor="end" fontSize={9.5} fill={INK}>{PARAM_INFO[a.p.key].label} → {fmt(a.p.max)}</text>
          <text x={PAD.l} y={h - 8} fontSize={9.5} fill={INK}>{fmt(a.p.min)}</text>
          <text x={8} y={PAD.t + 8} fontSize={9.5} fill={INK}>{fmt(b.p.max)}</text>
          <text x={8} y={h - PAD.b} fontSize={9.5} fill={INK}>{fmt(b.p.min)}</text>
          <text x={PAD.l + 4} y={PAD.t + 10} fontSize={9.5} fill={INK}>↑ {PARAM_INFO[b.p.key].label}</text>
          {ranked.map((c, k) => (
            <g key={k} onMouseEnter={() => setHover(k)}>
              <circle cx={sx(c.values[a.i])} cy={sy(c.values[b.i])} r={9} fill="transparent" />
              <circle cx={sx(c.values[a.i])} cy={sy(c.values[b.i])} r={4.5} fill={shade(k)} stroke="var(--bg-page)" strokeWidth={1.5} />
            </g>
          )).reverse()}
          {best && <circle cx={sx(best.values[a.i])} cy={sy(best.values[b.i])} r={6} fill={BEST} stroke="var(--bg-page)" strokeWidth={2} />}
        </svg>
      </div>
    </Frame>
  )
}
