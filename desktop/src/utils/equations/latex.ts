// Serializes the AST to LaTeX to render it with KaTeX.
//
// It is not a literal print of what was typed: divisions become \frac, powers
// superscripts and the temporal operators real calculus notation (d/dt, ∫ … dt).
// That is why the equation looks like a paper's even though it was typed on
// one line.

import { Node } from "./parser"

// Precedence of each node, to decide when parentheses are needed.
const PRECEDENCE = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 4 } as const

function precedenceOf(node: Node): number {
  switch (node.kind) {
    case "binary": return PRECEDENCE[node.op]
    case "unary": return 3
    default: return 5 // literals, matrices, variables and calls group on their own
  }
}

function wrap(latex: string): string {
  return `\\left(${latex}\\right)`
}

// Names longer than one character go upright: "speed" reads as a variable, not
// as s·p·e·e·d.
function variableToLatex(name: string): string {
  const greek = ["alpha", "beta", "gamma", "delta", "theta", "lambda", "mu", "sigma", "omega", "phi", "psi", "tau", "pi"]
  if (greek.includes(name.toLowerCase())) return `\\${name.toLowerCase()}`
  if (name.length === 1) return name

  // An underscore becomes a subscript: v_max → v_{max}
  const underscore = name.indexOf("_")
  if (underscore > 0) {
    const base = name.slice(0, underscore)
    const sub = name.slice(underscore + 1)
    return `${base.length === 1 ? base : `\\mathrm{${base}}`}_{\\mathrm{${sub}}}`
  }
  return `\\mathrm{${name}}`
}

const NAMED_OPERATORS: Record<string, string> = {
  sin: "\\sin", cos: "\\cos", tan: "\\tan",
  asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan",
  sinh: "\\sinh", cosh: "\\cosh", tanh: "\\tanh",
  ln: "\\ln", log: "\\log", exp: "\\exp",
  min: "\\min", max: "\\max",
}

export function toLatex(node: Node): string {
  switch (node.kind) {
    case "number":
      return String(node.value)

    case "variable":
      return variableToLatex(node.name)

    case "unary": {
      const operand = toLatex(node.operand)
      const needsParens = precedenceOf(node.operand) < precedenceOf(node)
      return `${node.op === "-" ? "-" : ""}${needsParens ? wrap(operand) : operand}`
    }

    case "binary": {
      // The fraction already groups visually: no parentheses are needed inside.
      if (node.op === "/") {
        return `\\frac{${toLatex(node.left)}}{${toLatex(node.right)}}`
      }

      // The exponent goes in the superscript's braces, it needs no parentheses either.
      if (node.op === "^") {
        const base = toLatex(node.left)
        const needsParens = precedenceOf(node.left) <= PRECEDENCE["^"] && node.left.kind !== "call"
        return `${needsParens ? wrap(base) : base}^{${toLatex(node.right)}}`
      }

      const own = PRECEDENCE[node.op]
      const left = toLatex(node.left)
      const right = toLatex(node.right)
      // On the right of a subtraction the grouping has to be preserved:
      // a-(b-c) is not the same as a-b-c.
      const leftText = precedenceOf(node.left) < own ? wrap(left) : left
      const rightNeedsParens = precedenceOf(node.right) < own
        || (node.op === "-" && precedenceOf(node.right) === own)
      const rightText = rightNeedsParens ? wrap(right) : right

      const symbol = node.op === "*" ? " \\cdot " : node.op === "%" ? " \\bmod " : ` ${node.op} `
      return `${leftText}${symbol}${rightText}`
    }

    case "call": {
      const args = node.args.map(toLatex)

      switch (node.name) {
        case "sqrt": return `\\sqrt{${args[0]}}`
        case "cbrt": return `\\sqrt[3]{${args[0]}}`
        case "abs": return `\\left|${args[0]}\\right|`
        case "pow": return `${wrap(args[0])}^{${args[1]}}`
        case "log2": return `\\log_{2}${wrap(args[0])}`
        case "hypot": return `\\sqrt{${node.args.map(a => `${toLatex(a)}^{2}`).join(" + ")}}`

        // Temporal operators, in real calculus notation.
        case "d":
        case "derivative":
          return `\\frac{d}{dt}${wrap(args[0])}`
        case "int":
        case "integral":
          return `\\int ${args[0]} \\, dt`

        // Window functions: the window goes as the operator's subscript.
        case "avg": return `\\overline{${args[0]}}_{${args[1]}s}`
        case "rms": return `\\mathrm{RMS}_{${args[1]}s}${wrap(args[0])}`
        case "stddev": return `\\sigma_{${args[1]}s}${wrap(args[0])}`
        case "peak": return `\\mathrm{peak}_{${args[1]}s}${wrap(args[0])}`

        case "deg": return `${wrap(args[0])}^{\\circ}`
        case "rad": return `\\mathrm{rad}${wrap(args[0])}`

        // Matrix algebra, in the usual notation.
        case "det": return `\\left|${args[0]}\\right|`
        case "inv": return `${wrap(args[0])}^{-1}`
        case "T": return `${wrap(args[0])}^{\\mathsf{T}}`
        case "trace": return `\\operatorname{tr}${wrap(args[0])}`
        case "norm": return `\\left\\|${args[0]}\\right\\|`
        case "normP1": return `\\left\\|${args[0]}\\right\\|_{1}`
        case "eye": return `I_{${args[0]}}`
        case "rot2": return `R${wrap(args[0])}`
        case "elemTimes": return `${args[0]} \\odot ${args[1]}`
        case "elemDiv": return `${args[0]} \\oslash ${args[1]}`
        case "elemSum": return `\\sum ${args[0]}`
        case "mean": return `\\overline{${args[0]}}`
        case "diag": return `\\operatorname{diag}${wrap(args[0])}`
        case "chol": return `\\operatorname{chol}${wrap(args[0])}`
        case "mexp": return `e^{${args[0]}}`
        case "msolve": return `${wrap(args[0])}^{-1}${args[1]}`
        case "expm1": return `e^{${args[0]}} - 1`
        case "log1p": return `\\ln\\left(1 + ${args[0]}\\right)`
        case "fma": return `${args[0]} \\cdot ${args[1]} + ${args[2]}`
        case "angleModulus": return `\\operatorname{mod}_{\\pm\\pi}${wrap(args[0])}`
        case "solve": return `\\operatorname{solve}\\left(${args[0]} = 0,\\; ${args[1]}\\right)`
      }

      const operator = NAMED_OPERATORS[node.name]
      if (operator) {
        return `${operator}${wrap(args.join(", "))}`
      }
      return `\\mathrm{${node.name}}${wrap(args.join(", "))}`
    }

    case "matrix": {
      const body = node.rows
        .map(row => row.map(toLatex).join(" & "))
        .join(" \\\\ ")
      return `\\begin{bmatrix}${body}\\end{bmatrix}`
    }
  }
}
