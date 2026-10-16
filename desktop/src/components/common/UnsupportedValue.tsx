interface Props {
  message: string
}

// Identical placeholder repeated in StructWidget, StructArrayWidget,
// StructArraySingleWidget and RotationWidget for structs with no decoder.
export default function UnsupportedValue({ message }: Props) {
  return (
    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
      {message}
    </span>
  )
}
