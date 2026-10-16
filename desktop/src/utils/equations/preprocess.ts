// Passes that rewrite the AST BEFORE evaluating it or passing it to LaTeX.
//
// Working by substitution on the tree —instead of resolving in the evaluator—
// makes everything downstream work for free: an equation that references
// another can be differentiated symbolically, put inside d(), and rendered
// expanded with no extra code.

import { Node } from "./parser"
import { derive } from "./symbolic"

export class PreprocessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PreprocessError"
  }
}

/** A named equation others can reference as if it were a variable. */
export interface NamedEquation {
  name: string
  ast: Node
}

function mapChildren(node: Node, fn: (child: Node) => Node): Node {
  switch (node.kind) {
    case "number":
    case "variable":
      return node
    case "unary":
      return { kind: "unary", op: node.op, operand: fn(node.operand) }
    case "binary":
      return { kind: "binary", op: node.op, left: fn(node.left), right: fn(node.right) }
    case "call":
      return { kind: "call", name: node.name, args: node.args.map(fn) }
    case "matrix":
      return { kind: "matrix", rows: node.rows.map(row => row.map(fn)) }
  }
}

/**
 * Replaces the references to other equations with their whole tree.
 * `visiting` detects cycles: if A uses B and B goes back to A, it stops with an
 * error instead of hanging.
 */
export function inlineEquations(
  node: Node,
  definitions: Map<string, Node>,
  visiting: string[] = [],
): Node {
  if (node.kind === "variable") {
    const definition = definitions.get(node.name)
    if (!definition) return node

    if (visiting.includes(node.name)) {
      throw new PreprocessError(`Circular reference: ${[...visiting, node.name].join(" → ")}`)
    }
    return inlineEquations(definition, definitions, [...visiting, node.name])
  }

  return mapChildren(node, child => inlineEquations(child, definitions, visiting))
}

/**
 * Expands diff(f, x) into f's symbolic derivative with respect to x.
 * It is done inside-out so diff(diff(f, x), x) —the second derivative— also
 * works.
 */
export function expandSymbolicDerivatives(node: Node): Node {
  const expanded = mapChildren(node, expandSymbolicDerivatives)

  if (expanded.kind === "call" && (expanded.name === "diff" || expanded.name === "D")) {
    if (expanded.args.length !== 2) {
      throw new PreprocessError("diff() takes 2 arguments: diff(expression, variable)")
    }
    const target = expanded.args[1]
    if (target.kind !== "variable") {
      throw new PreprocessError("The second argument of diff() must be a variable name")
    }
    return derive(expanded.args[0], target.name)
  }

  return expanded
}

/** The whole preprocessing, in the order it has to happen. */
export function preprocess(node: Node, definitions: Map<string, Node>): Node {
  // The references are inlined first, so diff() can differentiate through a
  // named equation and does not run into an opaque variable.
  return expandSymbolicDerivatives(inlineEquations(node, definitions))
}
