/**
 * T13 — Jev exfil path (spec §Threat model).
 *
 * Attack: Command text reaches Jev over the agent's network
 * Required outcome: Jev is called only by the daemon outside the sandbox; sandbox policy has no route to the Jev endpoint
 *
 * Status: todo. Milestone: M2 (OpenShell policy compilation).
 */
import { describe, test } from "bun:test";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Jev is called only by the daemon outside the sandbox; sandbox policy has no route to the Jev endpoint";

describe("T13 Jev exfil path", () => {
  test.todo(REQUIRED_OUTCOME, pending("M2 (OpenShell policy compilation)"));
});
