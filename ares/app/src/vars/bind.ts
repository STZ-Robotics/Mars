// Ties a numeric field of an object to an input that takes numbers or
// formulas: what Q and QInput need, from the object, the field's name and a
// way to apply an updated object.

import type { Bindable } from "../ui/controls"
import { dimOf, withField } from "./variables"

type WithExprs = { exprs?: Record<string, string> }

function read(obj: unknown, key: string): number | undefined {
  const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj)
  return typeof v === "number" ? v : undefined
}

/**
 * `{ value, onChange, expr, onSet, exprDim }` for field `key` of `obj`.
 * `update` receives a function from the current object to the new one, so
 * it composes with state setters that work on the latest value.
 */
export function bindField<T extends WithExprs>(
  obj: T, key: string, update: (f: (o: T) => T) => void,
): { value: number | undefined; onChange: (v: number) => void } & Bindable {
  return {
    value: read(obj, key),
    expr: obj.exprs?.[key],
    exprDim: dimOf(key),
    onChange: v => update(o => withField(o, key, v)),
    onSet: (v, e) => update(o => withField(o, key, v, e)),
  }
}
