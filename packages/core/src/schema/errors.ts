import type { z } from "zod";
import { err, ok, type Result } from "../result.ts";

/** One validation failure, located by a dotted path such as `call.cwd` or `jev.0.p`. */
export interface SchemaIssue {
  /** Dotted path to the offending field; the empty string means the value itself. */
  path: string;
  message: string;
}

/**
 * Why an untrusted value was rejected. `message` is a single line safe to log;
 * `issues` lists every failure so an adapter can report all of them at once.
 */
export interface SchemaError {
  message: string;
  issues: SchemaIssue[];
}

type ZodIssue = z.core.$ZodIssue;

const CONTROL_CHARS = /\p{Cc}+/gu;

function singleLine(text: string): string {
  return text.replace(CONTROL_CHARS, " ");
}

function dotted(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment) => String(segment)).join(".");
}

function toIssues(issue: ZodIssue): SchemaIssue[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: dotted([...issue.path, key]),
      message: "unknown key",
    }));
  }
  return [{ path: dotted(issue.path), message: issue.message }];
}

function summarise(subject: string, issues: ReadonlyArray<SchemaIssue>): string {
  const parts = issues.map(({ path, message }) => `${path || "<root>"}: ${message}`);
  return singleLine(`invalid ${subject}: ${parts.join("; ")}`);
}

function schemaError(subject: string, issues: SchemaIssue[]): SchemaError {
  return { message: summarise(subject, issues), issues };
}

/**
 * Validates `input` against `schema` without ever throwing: zod failures and any
 * exception raised while reading a hostile input both become a {@link SchemaError}.
 */
export function safeParse<S extends z.ZodType>(
  schema: S,
  input: unknown,
  subject: string,
): Result<z.output<S>, SchemaError> {
  try {
    const parsed = schema.safeParse(input);
    if (parsed.success) return ok(parsed.data);
    return err(schemaError(subject, parsed.error.issues.flatMap(toIssues)));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unreadable input";
    return err(schemaError(subject, [{ path: "", message: reason }]));
  }
}
