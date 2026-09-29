import { readFile } from "node:fs/promises";
import {
  type Answer,
  type ContextConfigInput,
  err,
  eventSchema,
  ok,
  type PolicyConfigInput,
  preEventSchema,
  type Result,
  verdictSchema,
} from "@jevdict/core";
import { z } from "zod";

/**
 * The `*.fixtures.json` format (spec: "every policy ships with a `*.fixtures.json` file
 * of events and expected verdicts; fixtures replace Jev answers with recorded ones").
 * JSON is canonical so `jevdict test` and `jevdict replay` can read the files without
 * running TypeScript; {@link defineFixtures} is the typed TypeScript alternative.
 */

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability).default({});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

const plainObject = z.custom<Record<string, unknown>>(isPlainObject, {
  error: "expected a JSON object",
});

/** A recorded judge answer: the core `Answer` shapes, `probabilities` optional. */
export const fixtureAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("noul"), p: probability, confidence: probability }),
  z.strictObject({
    kind: z.literal("choice"),
    choice: z.string().min(1),
    p: probability,
    confidence: probability,
    probabilities,
  }),
  z.strictObject({
    kind: z.literal("score"),
    score: z.number().min(0),
    level: z.string().min(1),
    confidence: probability,
    probabilities,
  }),
]);

/** Expected outcome of one case; only `verdict` is required. */
export const fixtureExpectSchema = z
  .strictObject({
    verdict: verdictSchema,
    /** Policies that must have matched: `name` or `name@version`. */
    policies: z.array(z.string().min(1)).optional(),
    riskMin: probability.optional(),
    riskMax: probability.optional(),
    /** Deep-equal to the decision's `updated_input` (a `rewrite`). */
    updatedInput: plainObject.optional(),
  })
  .refine((x) => x.riskMin === undefined || x.riskMax === undefined || x.riskMin <= x.riskMax, {
    error: "riskMin must not exceed riskMax",
  });

/** Context and policy config overrides for one case; objects merge, scalars replace. */
export const fixtureConfigSchema = z.strictObject({
  context: plainObject.optional(),
  policy: plainObject.optional(),
});

/** One case: history fed to the case file in order, then the judged pre event. */
export const fixtureCaseSchema = z.strictObject({
  name: z.string().min(1),
  /** The judged event: a `jevdict.event/1` pre event. */
  event: preEventSchema,
  /** Earlier pre and post events, fed in order before `event`. */
  history: z.array(eventSchema).optional(),
  /** Sets the case-file task before any history (the first user prompt). */
  task: z.string().min(1).optional(),
  /**
   * Recorded judge answers by question name. A bare name belongs to the fixture's
   * policy; `policy/name` or `jevdict:serves_task` are used verbatim. Absent → the
   * judge is disabled, as with the semantic layer switched off.
   */
  answers: z.record(z.string().min(1), fixtureAnswerSchema).optional(),
  config: fixtureConfigSchema.optional(),
  /** Clock step between consecutive events, in ms (default 1 000). */
  stepMs: z.int().nonnegative().optional(),
  expect: fixtureExpectSchema,
});

function uniqueNames(cases: ReadonlyArray<{ name: string }>): boolean {
  return new Set(cases.map((c) => c.name)).size === cases.length;
}

/** A whole `*.fixtures.json` file for one policy. */
export const fixtureFileSchema = z.strictObject({
  $schema: z.string().optional(),
  policy: z.string().min(1),
  cases: z
    .array(fixtureCaseSchema)
    .min(1)
    .refine(uniqueNames, { error: "case names must be unique" }),
});

/** A validated recorded answer. */
export type FixtureAnswer = z.output<typeof fixtureAnswerSchema> & Answer;
/** A validated expectation. */
export type FixtureExpect = z.output<typeof fixtureExpectSchema>;
/** A validated case. */
export type FixtureCase = z.output<typeof fixtureCaseSchema>;
/** A case before defaults are applied, as authored. */
export type FixtureCaseInput = z.input<typeof fixtureCaseSchema>;
/** A validated fixture file. */
export type FixtureFile = z.output<typeof fixtureFileSchema>;
/** What {@link defineFixtures} accepts: the file before defaults are applied. */
export type FixtureFileInput = z.input<typeof fixtureFileSchema>;

/** Typed views of a case's config overrides. */
export interface FixtureConfig {
  context?: ContextConfigInput;
  policy?: PolicyConfigInput;
}

/**
 * Validates an unknown value as a fixture file. Never throws: problems come back as one
 * line each, prefixed with the dotted path (`cases.0.expect.verdict: …`).
 */
export function parseFixtures(value: unknown): Result<FixtureFile, string[]> {
  const parsed = fixtureFileSchema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(
    parsed.error.issues.map((i) => {
      const path = i.path.map(String).join(".");
      return path === "" ? i.message : `${path}: ${i.message}`;
    }),
  );
}

/** Reads and validates a `*.fixtures.json` file; an unreadable file is an error value. */
export async function loadFixtures(path: string): Promise<Result<FixtureFile, string[]>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return err([`cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`]);
  }
  try {
    return parseFixtures(JSON.parse(text));
  } catch (cause) {
    return err([
      `${path}: invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }
}

/**
 * Fixtures authored in TypeScript instead of JSON: validates at definition time and
 * throws a TypeError listing every problem, like `definePolicy`.
 */
export function defineFixtures(file: FixtureFileInput): FixtureFile {
  const parsed = parseFixtures(file);
  if (!parsed.ok) throw new TypeError(`defineFixtures: ${parsed.error.join("\n")}`);
  return parsed.value;
}
