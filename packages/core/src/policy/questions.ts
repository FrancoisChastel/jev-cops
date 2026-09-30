import type { Question } from "../judge/types.ts";
import { validateQuestions } from "../judge/validate.ts";
import type { PolicyConfig } from "./config.ts";
import type { PolicyMatch } from "./evaluate.ts";
import type { PolicyContext, PolicyEvent } from "./types.ts";

/** Name of the engine's own scope question in a batch; `:` never appears in a policy name. */
export const SCOPE_QUESTION = "jev-cops:serves_task";

/** The batch name of a policy's question: `policy/question`, unique across policies. */
export function qualify(policyName: string, questionName: string): string {
  return `${policyName}/${questionName}`;
}

/**
 * Which questions go to the judge for one event. `asked` maps a policy key to its own
 * (unqualified) questions, all present in `batch` under qualified names; `skipped` says
 * why a matched policy with `ask` got no questions in.
 */
export interface QuestionPlan {
  /** Floor in `[ask.min, ask.max]`, both ends inclusive. */
  readonly inBand: boolean;
  readonly batch: readonly Question[];
  readonly asked: ReadonlyMap<string, readonly Question[]>;
  readonly skipped: ReadonlyMap<string, string>;
  readonly scopeAsked: boolean;
}

/** Inputs of {@link planQuestions}. */
export interface PlanInputs {
  matches: ReadonlyArray<PolicyMatch>;
  e: PolicyEvent;
  ctx: PolicyContext;
  floor: number;
  scopeUnsure: boolean;
  /** The case file's task; the scope question needs one. */
  task: string | null;
  config: PolicyConfig;
}

const KINDS = new Set(["noul", "choice", "score"]);

function isQuestion(value: unknown): value is Question {
  if (typeof value !== "object" || value === null) return false;
  const q = value as Record<string, unknown>;
  if (!KINDS.has(q.kind as string) || typeof q.name !== "string" || typeof q.text !== "string") {
    return false;
  }
  if (q.kind === "choice") return typeof q.options === "object" && q.options !== null;
  if (q.kind === "score") return Array.isArray(q.rubric) && q.rubric.length >= 2;
  return true;
}

function askQuestions(m: PolicyMatch, inputs: PlanInputs): Question[] | string {
  try {
    const qs: unknown = m.policy.ask?.(inputs.e, inputs.ctx) ?? [];
    if (!Array.isArray(qs) || !qs.every(isQuestion)) return "ask did not return questions";
    const problems = validateQuestions(qs, inputs.config.judge.maxQuestions);
    return problems.length > 0 ? `ask: ${problems.join("; ")}` : [...qs];
  } catch (cause) {
    return `ask threw: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

function scopeQuestion(task: string): Question {
  return { kind: "noul", name: SCOPE_QUESTION, text: `This action serves the task: ${task}` };
}

/**
 * Plans the one batched request for an event (spec rules 1 and 5). Nothing is asked
 * unless the floor is in the uncertain band. Matched policies with `ask` are taken in
 * load order while their questions fit in the 4-question batch; a policy whose `ask`
 * throws, returns malformed questions, or does not fit is skipped (its floor stands).
 * The engine's own `serves_task` noul goes last, only when deterministic scope is unsure,
 * a task is known and a slot is left.
 */
export function planQuestions(inputs: PlanInputs): QuestionPlan {
  const { config, floor } = inputs;
  const inBand = floor >= config.ask.min && floor <= config.ask.max;
  const max = config.judge.maxQuestions;
  const batch: Question[] = [];
  const asked = new Map<string, readonly Question[]>();
  const skipped = new Map<string, string>();
  for (const m of inputs.matches.filter((x) => x.matched && x.policy.ask !== undefined)) {
    if (!inBand) {
      skipped.set(m.key, `floor ${floor.toFixed(2)} outside the uncertain band`);
      continue;
    }
    const qs = askQuestions(m, inputs);
    if (typeof qs === "string") skipped.set(m.key, qs);
    else if (batch.length + qs.length > max) skipped.set(m.key, `question limit ${max} reached`);
    else {
      asked.set(m.key, qs);
      batch.push(...qs.map((q) => ({ ...q, name: qualify(m.policy.name, q.name) })));
    }
  }
  const wantsScope = inBand && inputs.scopeUnsure && config.ask.scopeQuestion;
  const scopeAsked = wantsScope && inputs.task !== null && batch.length < max;
  if (scopeAsked && inputs.task !== null) batch.push(scopeQuestion(inputs.task));
  return { inBand, batch, asked, skipped, scopeAsked };
}
