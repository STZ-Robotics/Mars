// The robot, drawn as what it is: a swerve chassis from above, a round
// module at each corner with its wheel turned, and an arrow for forward.
// Sized and colored like a Tabler icon.
const MODULES: [number, number][] = [[6, 6], [18, 6], [6, 18], [18, 18]]

export default function SwerveIcon({ size = 20, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", ...style }} aria-hidden>
      {/* The frame, between the modules. */}
      <path d="M9.4 6H14.6M9.4 18H14.6M6 9.4V14.6M18 9.4V14.6" />
      {MODULES.map(([x, y]) => (
        <g key={`${x}${y}`}>
          <circle cx={x} cy={y} r={3.4} />
          <line x1={0} y1={-1.7} x2={0} y2={1.7} strokeWidth={2.3} transform={`translate(${x} ${y}) rotate(30)`} />
        </g>
      ))}
      <path d="M12 10l1.7 2.3h-3.4z" fill="currentColor" stroke="none" />
    </svg>
  )
}
