/**
 * The fake model API's script file (`jev-cops.fake-api-script/1`): what the "model"
 * answers, scenario by scenario. A user message containing `SCENARIO:<name>` starts a
 * scenario; every later request of that turn (the last user message carries tool results)
 * gets the scenario's next step. A step is one tool call (the first alternative whose tool
 * the request offers) or a text answer. Nothing else in the conversation steers it.
 */
import { readFileSync } from "node:fs";

export const SCRIPT_SCHEMA = "jev-cops.fake-api-script/1";

/** One way to make a tool call: the tool's name as the harness offers it, and its input. */
export interface CallAlternative {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** A step: call a tool (first alternative the request offers), or answer with text. */
export type Step =
  | { readonly kind: "call"; readonly alternatives: readonly CallAlternative[] }
  | { readonly kind: "text"; readonly text: string };

/** A validated script. */
export interface Script {
  /** Answer when no scenario applies (a fresh prompt, a side request without tools). */
  readonly defaultText: string;
  /** Answer once a scenario has no step left. */
  readonly doneText: string;
  /** Model ids `GET /v1/models` lists. */
  readonly models: readonly string[];
  readonly scenarios: ReadonlyMap<string, readonly Step[]>;
}

/** A scenario name as it appears after `SCENARIO:` in a prompt. */
export const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(where: string, what: string): never {
  throw new Error(`fake-api script: ${where}: ${what}`);
}

function alternative(v: unknown, where: string): CallAlternative {
  if (!isObject(v)) fail(where, "must be an object with tool and input");
  if (typeof v.tool !== "string" || v.tool === "") fail(where, "tool must be a non-empty string");
  if (!isObject(v.input)) fail(where, "input must be an object");
  return { tool: v.tool, input: v.input };
}

function step(v: unknown, where: string): Step {
  if (!isObject(v)) fail(where, "must be an object");
  if (typeof v.text === "string") return { kind: "text", text: v.text };
  const call = v.call;
  const list = Array.isArray(call) ? call : [call];
  if (call === undefined || list.length === 0) fail(where, "needs call or text");
  return { kind: "call", alternatives: list.map((a, i) => alternative(a, `${where}.call[${i}]`)) };
}

function strings(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    fail(where, "must be an array of strings");
  }
  return v as string[];
}

/** Validates a parsed script file; throws with the offending path. */
export function parseScript(raw: unknown): Script {
  if (!isObject(raw)) fail("root", "must be an object");
  if (raw.schema !== SCRIPT_SCHEMA) fail("schema", `must be "${SCRIPT_SCHEMA}"`);
  if (!isObject(raw.scenarios)) fail("scenarios", "must be an object");
  const scenarios = new Map<string, readonly Step[]>();
  for (const [name, value] of Object.entries(raw.scenarios)) {
    if (!SCENARIO_NAME.test(name)) fail(`scenarios.${name}`, "name must match [a-z0-9-]");
    const steps = isObject(value) ? value.steps : undefined;
    if (!Array.isArray(steps) || steps.length === 0) {
      fail(`scenarios.${name}.steps`, "must be a non-empty array");
    }
    scenarios.set(
      name,
      steps.map((s, i) => step(s, `scenarios.${name}.steps[${i}]`)),
    );
  }
  const text = (key: string, fallback: string) => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (typeof v !== "string") fail(key, "must be a string");
    return v;
  };
  return {
    defaultText: text("default_text", "ok"),
    doneText: text("done_text", "Noted the tool result."),
    models: strings(raw.models, "models"),
    scenarios,
  };
}

/** Reads and validates a script file. */
export function loadScript(path: string): Script {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(path, cause instanceof Error ? cause.message : String(cause));
  }
  return parseScript(raw);
}
