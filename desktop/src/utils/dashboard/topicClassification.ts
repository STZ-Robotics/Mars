export interface TopicClassification {
  isArrayType: boolean
  baseType: string
  isStructType: boolean
  structName: string | null
  isBoolean: boolean
  isNumber: boolean
  isString: boolean
  isNumericArray: boolean
  isTextArray: boolean
  /** A WPILib sendable table, not a topic (its value is not read with unpackLiveValue). */
  isField2d: boolean
  isStructSingle: boolean
  isStructArray: boolean
  isRotationSingle: boolean
  hasStyleOptions: boolean
}

const NUMERIC_BASE_TYPES = ["double", "float", "int"]

// Classifies an NT4 topicType into the categories the Dashboard knows how to
// render. We tell loose structs from arrays of structs, and flat numeric arrays
// from everything else.
export function classifyTopic(topicType: string): TopicClassification {
  const isArrayType = topicType.endsWith("[]")
  const baseType = isArrayType ? topicType.slice(0, -2) : topicType
  const isStructType = baseType.startsWith("struct:")
  const structName = isStructType ? baseType.slice("struct:".length) : null

  const isField2d = topicType === "Field2d"
  const isBoolean = !isStructType && !isArrayType && topicType === "boolean"
  const isNumber = !isStructType && !isArrayType && (topicType === "double" || topicType === "int" || topicType === "float")
  const isString = !isStructType && !isArrayType && topicType.includes("string")
  // Before, ANY non-struct array counted as numeric. That only worked because
  // the backend discarded boolean[]/string[]; now that they really arrive,
  // sending them to the numeric widget would blow up in value.toFixed().
  const isNumericArray = !isStructType && isArrayType && NUMERIC_BASE_TYPES.includes(baseType)
  const isTextArray = !isStructType && isArrayType && !isNumericArray
  const isStructSingle = isStructType && !isArrayType
  const isStructArray = isStructType && isArrayType
  const isRotationSingle = isStructSingle && structName === "Rotation2d"

  // Boolean/number/Rotation2d tienen estilos visuales configurables (Bar, Compass, etc.)
  const hasStyleOptions = isBoolean || isNumber || isRotationSingle

  return {
    isArrayType, baseType, isStructType, structName,
    isBoolean, isNumber, isString, isNumericArray, isTextArray, isField2d,
    isStructSingle, isStructArray, isRotationSingle, hasStyleOptions,
  }
}
