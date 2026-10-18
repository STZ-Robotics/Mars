import { useField } from "./field"

// A path, or an auto's paths, at a glance in a list: the field's outline at
// its proportions and the way the robot goes, from a green start to a red end.

export interface ThumbLine { points: { x: number; y: number }[]; color?: string }

export default function Thumb({ lines, width = 44, active }: { lines: ThumbLine[]; width?: number; active?: boolean }) {
  const { size } = useField()
  const h = Math.round(width * size.widthM / size.lengthM)
  const sx = (x: number) => 1 + (x / size.lengthM) * (width - 2)
  const sy = (y: number) => h - 1 - (y / size.widthM) * (h - 2)
  const ink = active ? "rgba(255,255,255,0.75)" : "var(--border-dark)"
  const drawn = lines.filter(l => l.points.length > 0)
  const first = drawn[0]?.points[0], lastLine = drawn[drawn.length - 1], last = lastLine?.points[lastLine.points.length - 1]
  return (
    <svg width={width} height={h} style={{ flexShrink: 0, display: "block" }} aria-hidden>
      <rect x={0.5} y={0.5} width={width - 1} height={h - 1} rx={1.5} fill={active ? "rgba(255,255,255,0.12)" : "var(--bg-page)"} stroke={ink} strokeWidth={1} />
      <line x1={width / 2} x2={width / 2} y1={1} y2={h - 1} stroke={ink} strokeWidth={0.5} opacity={0.6} />
      {drawn.map((l, i) => (
        <polyline key={i} fill="none" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round"
          stroke={active ? "#ffffff" : l.color ?? "#2f6fdb"} points={l.points.map(p => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")} />
      ))}
      {first && <circle cx={sx(first.x)} cy={sy(first.y)} r={1.8} fill="#16a34a" stroke={active ? "#ffffff" : "none"} strokeWidth={0.6} />}
      {last && <circle cx={sx(last.x)} cy={sy(last.y)} r={1.8} fill="#c21c1c" stroke={active ? "#ffffff" : "none"} strokeWidth={0.6} />}
    </svg>
  )
}
