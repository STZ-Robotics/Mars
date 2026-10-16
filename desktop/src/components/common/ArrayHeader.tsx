interface Props {
  count: number
  label?: string
}

// The "ARRAY[n]" / "ARRAY[n] · Pose2d" header repeated in StructArrayWidget and
// NumberArrayWidget.
export default function ArrayHeader({ count, label }: Props) {
  return (
    <div style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: 1, padding: "6px 10px 4px", borderBottom: "1px solid var(--border-light)", flexShrink: 0 }}>
      ARRAY[{count}]{label ? ` · ${label}` : ""}
    </div>
  )
}
