/**
 * @jevdict/sdk — the published API for policy authors: `definePolicy`, the `jev`
 * question builders, the `*.fixtures.json` format and its runner, and the core types a
 * policy needs. Policies import from here only, never from `@jevdict/core` internals.
 * The `bun:test` adapter lives at `@jevdict/sdk/test` so loading a policy never pulls in
 * the test runner.
 */
export type {
  Answer,
  AnswersFor,
  ChoiceAnswer,
  ChoiceQuestion,
  DurationInput,
  NoulAnswer,
  NoulQuestion,
  PolicyContext,
  PolicyDefinition,
  PolicyEvent,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  Verdict,
} from "@jevdict/core";
export { VERDICTS } from "@jevdict/core";
export { definePolicy } from "./define.ts";
export { choice, jev, type NoulCriteria, noul, score } from "./jev.ts";
