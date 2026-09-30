/**
 * What the fake model answers to one request, from the script and the conversation alone
 * (stateless: a retried request gets the same answer, and parallel sessions never mix).
 *
 * - The last user prompt (a user turn without tool results) carries a `SCENARIO:<name>`
 *   marker: the scenario, at the step after the tool calls the assistant made since that
 *   prompt (step 0 when the prompt is the last turn).
 * - Anything else (the last prompt has no marker, a request without the step's tool):
 *   the script's default text.
 */
import type { Conversation, Turn } from "./conversation.ts";
import type { Script } from "./script.ts";

/** The answer, with why it was chosen (the request log records both). */
export type Reply =
  | {
      readonly kind: "call";
      readonly tool: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly scenario: string;
      readonly step: number;
    }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly scenario: string | null;
      readonly step: number | null;
      readonly why: "no-scenario" | "unknown-scenario" | "tool-not-offered" | "done" | "scripted";
    };

const MARKER = /SCENARIO:([a-z0-9][a-z0-9-]{0,63})/g;

/** The last scenario name a turn's texts mark, or null. */
export function markedScenario(turn: Turn): string | null {
  let found: string | null = null;
  for (const text of turn.texts) for (const m of text.matchAll(MARKER)) found = m[1] ?? found;
  return found;
}

function text(
  t: string,
  why: Extract<Reply, { kind: "text" }>["why"],
  scenario: string | null = null,
  step: number | null = null,
): Reply {
  return { kind: "text", text: t, scenario, step, why };
}

/** The index of the latest user prompt (no tool result) when it marks a scenario, else -1. */
function markedPrompt(turns: readonly Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.role !== "user" || t.toolResults > 0) continue;
    return markedScenario(t) === null ? -1 : i;
  }
  return -1;
}

/** Plans the reply to one request. */
export function planReply(script: Script, conv: Conversation): Reply {
  const at = markedPrompt(conv.turns);
  if (at === -1) return text(script.defaultText, "no-scenario");
  const name = markedScenario(conv.turns[at] as Turn) ?? "";
  const steps = script.scenarios.get(name);
  if (steps === undefined) return text(`unknown scenario ${name}`, "unknown-scenario", name);
  const later = conv.turns.slice(at + 1);
  const index = later.filter((t) => t.role === "assistant" && t.toolCalls > 0).length;
  const step = steps[index];
  if (step === undefined) return text(script.doneText, "done", name, index);
  if (step.kind === "text") return text(step.text, "scripted", name, index);
  const offered = step.alternatives.find((a) => conv.tools.includes(a.tool));
  if (offered === undefined) return text(script.defaultText, "tool-not-offered", name, index);
  return { kind: "call", tool: offered.tool, input: offered.input, scenario: name, step: index };
}
