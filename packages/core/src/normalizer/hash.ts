import { createHash } from "node:crypto";

const CIRCULAR = "[Circular]";

function canonical(value: unknown, ancestors: ReadonlySet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return CIRCULAR;
  const inner = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map((item: unknown) => canonical(item, inner));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key], inner)]),
  );
}

/**
 * JSON with object keys sorted at every level, so equal values always serialize the
 * same way. Cycles become `"[Circular]"`; functions, symbols and undefined become null.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value, new Set())) ?? "null";
}

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `JSON.stringify(value)` in the input's own key order, for the human-facing raw text.
 * Falls back to a cycle-safe rendering instead of throwing on hostile input.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v === null || typeof v !== "object") return v;
      if (seen.has(v)) return CIRCULAR;
      seen.add(v);
      return v;
    });
  }
}
