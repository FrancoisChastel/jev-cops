import { describe, expect, test } from "bun:test";
import * as core from "../index.ts";
import * as context from "./index.ts";

describe("context barrel", () => {
  test("exposes the case files, the five features, the budget and the config", () => {
    for (const name of [
      "computeFeatures",
      "openCaseFile",
      "InMemoryCaseFileStore",
      "SqliteCaseFileStore",
      "taintFraction",
      "scopeScore",
      "sequenceScore",
      "environmentScore",
      "reversibilityScore",
      "charge",
      "chargeHold",
      "DEFAULT_CONTEXT_CONFIG",
      "resolveContextConfig",
      "isSecretPath",
      "findSecretPatterns",
      "findPromptLikeStrings",
    ]) {
      expect(context).toHaveProperty(name);
      expect(core).toHaveProperty(name);
    }
  });
});
