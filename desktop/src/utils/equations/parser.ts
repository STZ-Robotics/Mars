// Parser of math expressions: tokenizer + recursive descent.
//
// It was written by hand instead of using a library because the temporal
// operators (d/dt, ∫) have to be applicable to ANY subexpression —not just a
// loose variable—, and that calls for control over the AST.
//
// Precedence, lowest to highest:
//   1. + −
//   2. * / %
//   3. unary −
//   4. ^  (right-associative)
//   5. literals, variables, function calls, parentheses

export type Node =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: "-" | "+"; operand: Node }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%" | "^"; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] }
  /** A matrix literal: [[1,2],[3,4]]. A single row is a row vector. */
  | { kind: "matrix"; rows: Node[][] }

export class ParseError extends Error {
  constructor(message: string, public position: number) {
    super(message)
    this.name = "ParseError"
  }
}

// --- Tokenizador ------------------------------------------------------------

type TokenType = "number" | "identifier" | "operator" | "lparen" | "rparen" | "lbracket" | "rbracket" | "comma" | "end"

interface Token {
  type: TokenType
  text: string
  position: number
}

const OPERATOR_CHARS = new Set(["+", "-", "*", "/", "%", "^"])

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const char = input[i]

    if (/\s/.test(char)) {
      i++
      continue
    }

    // Numbers, with decimals and scientific notation (1.5e-3)
    if (/[0-9.]/.test(char)) {
      const start = i
      while (i < input.length && /[0-9.]/.test(input[i])) i++
      if (i < input.length && /[eE]/.test(input[i])) {
        const expStart = i
        i++
        if (i < input.length && /[+-]/.test(input[i])) i++
        if (i < input.length && /[0-9]/.test(input[i])) {
          while (i < input.length && /[0-9]/.test(input[i])) i++
        } else {
          i = expStart // it was not an exponent, step back
        }
      }
      const text = input.slice(start, i)
      if (isNaN(Number(text))) throw new ParseError(`Invalid number "${text}"`, start)
      tokens.push({ type: "number", text, position: start })
      continue
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = i
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i++
      tokens.push({ type: "identifier", text: input.slice(start, i), position: start })
      continue
    }

    if (OPERATOR_CHARS.has(char)) {
      tokens.push({ type: "operator", text: char, position: i })
      i++
      continue
    }

    if (char === "(") { tokens.push({ type: "lparen", text: char, position: i }); i++; continue }
    if (char === ")") { tokens.push({ type: "rparen", text: char, position: i }); i++; continue }
    if (char === "[") { tokens.push({ type: "lbracket", text: char, position: i }); i++; continue }
    if (char === "]") { tokens.push({ type: "rbracket", text: char, position: i }); i++; continue }
    if (char === ",") { tokens.push({ type: "comma", text: char, position: i }); i++; continue }

    throw new ParseError(`Unexpected character "${char}"`, i)
  }

  tokens.push({ type: "end", text: "", position: input.length })
  return tokens
}

// --- Parser -----------------------------------------------------------------

export function parseExpression(input: string): Node {
  const tokens = tokenize(input)
  let pos = 0

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  const expectOperator = (text: string) => {
    const token = peek()
    if (token.type === "operator" && token.text === text) { pos++; return true }
    return false
  }

  const parseAdditive = (): Node => {
    let left = parseMultiplicative()
    while (peek().type === "operator" && (peek().text === "+" || peek().text === "-")) {
      const op = next().text as "+" | "-"
      left = { kind: "binary", op, left, right: parseMultiplicative() }
    }
    return left
  }

  const parseMultiplicative = (): Node => {
    let left = parseUnary()
    while (peek().type === "operator" && ["*", "/", "%"].includes(peek().text)) {
      const op = next().text as "*" | "/" | "%"
      left = { kind: "binary", op, left, right: parseUnary() }
    }
    return left
  }

  const parseUnary = (): Node => {
    const token = peek()
    if (token.type === "operator" && (token.text === "-" || token.text === "+")) {
      pos++
      return { kind: "unary", op: token.text as "-" | "+", operand: parseUnary() }
    }
    return parsePower()
  }

  // Right-associative, and the exponent allows a unary minus to write 2^-1.
  const parsePower = (): Node => {
    const base = parsePrimary()
    if (expectOperator("^")) {
      return { kind: "binary", op: "^", left: base, right: parseUnary() }
    }
    return base
  }

  const parsePrimary = (): Node => {
    const token = next()

    if (token.type === "number") {
      return { kind: "number", value: Number(token.text) }
    }

    if (token.type === "identifier") {
      if (peek().type === "lparen") {
        pos++ // consume "("
        const args: Node[] = []
        if (peek().type !== "rparen") {
          args.push(parseAdditive())
          while (peek().type === "comma") {
            pos++
            args.push(parseAdditive())
          }
        }
        if (peek().type !== "rparen") {
          throw new ParseError(`Missing ")" after arguments of "${token.text}"`, peek().position)
        }
        pos++ // consume ")"
        return { kind: "call", name: token.text, args }
      }
      return { kind: "variable", name: token.text }
    }

    if (token.type === "lparen") {
      const inner = parseAdditive()
      if (peek().type !== "rparen") {
        throw new ParseError('Missing closing ")"', peek().position)
      }
      pos++
      return inner
    }

    // A matrix literal. [[1,2],[3,4]] is 2×2; [1,2,3] is a 1×3 row vector.
    if (token.type === "lbracket") {
      const isNested = peek().type === "lbracket"
      const rows: Node[][] = []

      if (isNested) {
        while (true) {
          if (peek().type !== "lbracket") {
            throw new ParseError("Expected a matrix row starting with \"[\"", peek().position)
          }
          pos++
          rows.push(parseRowEntries())
          if (peek().type === "comma") { pos++; continue }
          break
        }
      } else {
        rows.push(parseRowEntries(true))
      }

      if (peek().type !== "rbracket") {
        throw new ParseError('Missing closing "]"', peek().position)
      }
      pos++

      const width = rows[0].length
      if (rows.some(row => row.length !== width)) {
        throw new ParseError("All matrix rows must have the same length", token.position)
      }
      return { kind: "matrix", rows }
    }

    if (token.type === "end") {
      throw new ParseError("Unexpected end of expression", token.position)
    }

    throw new ParseError(`Unexpected "${token.text}"`, token.position)
  }

  // A row's entries, up to the "]" that closes it. For the flat vector
  // ([1,2,3]) the closing "]" is consumed by the caller.
  function parseRowEntries(isFlatVector = false): Node[] {
    const entries: Node[] = []
    if (peek().type !== "rbracket") {
      entries.push(parseAdditive())
      while (peek().type === "comma") {
        pos++
        entries.push(parseAdditive())
      }
    }
    if (!isFlatVector) {
      if (peek().type !== "rbracket") {
        throw new ParseError('Missing "]" at the end of a matrix row', peek().position)
      }
      pos++
    }
    if (entries.length === 0) throw new ParseError("Matrix rows cannot be empty", peek().position)
    return entries
  }

  const result = parseAdditive()
  if (peek().type !== "end") {
    throw new ParseError(`Unexpected "${peek().text}"`, peek().position)
  }
  return result
}

// Names of every variable that appears in the tree (without repeats).
export function collectVariables(node: Node, out: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case "variable": out.add(node.name); break
    case "unary": collectVariables(node.operand, out); break
    case "binary": collectVariables(node.left, out); collectVariables(node.right, out); break
    case "call": node.args.forEach(arg => collectVariables(arg, out)); break
    case "matrix": node.rows.forEach(row => row.forEach(entry => collectVariables(entry, out))); break
  }
  return out
}
