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
  OpaqueReason,
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
export {
  defineFixtures,
  type FixtureAnswer,
  type FixtureCase,
  type FixtureCaseInput,
  type FixtureConfig,
  type FixtureExpect,
  type FixtureFile,
  type FixtureFileInput,
  fixtureAnswerSchema,
  fixtureCaseSchema,
  fixtureExpectSchema,
  fixtureFileSchema,
  loadFixtures,
  parseFixtures,
} from "./fixtures.ts";
export { choice, jev, type NoulCriteria, noul, score } from "./jev.ts";
export {
  type ActualOutcome,
  type CaseResult,
  DEFAULT_STEP_MS,
  FIXTURE_EPOCH,
  FIXTURE_HOME,
  FIXTURE_WHEN_BUDGET_MS,
  type FixtureReport,
  mismatches,
  qualifyAnswers,
  type RunFixturesOptions,
  runFixtureCase,
  runFixtures,
} from "./runner.ts";
