import { describe, expect, test } from "bun:test";
import type { NoulAnswer, NoulQuestion, Question, ScoreAnswer } from "../judge/types.ts";
import type { AnswersFor, PolicyContext, PolicyDefinition, PolicyEvent } from "./types.ts";

/**
 * Type-level tests: this file only compiles (`bun run typecheck`) if the contract types
 * accept the spec's example policy verbatim and reject misuse. The runtime asserts are a
 * smoke check that the example's `decide` behaves as written.
 */

const secrecy = {
  kind: "score",
  name: "payload_secrecy",
  text: "How secret-like is the request payload?",
  rubric: ["public", "internal", "credential"],
} as const;
type DestFits = NoulQuestion<"dest_fits_task">;
type ExfilQuestions = readonly [DestFits, typeof secrecy];

/** The spec §Policy-as-code example, typed against the contract. */
const exfilAfterSecrets: PolicyDefinition<ExfilQuestions> = {
  name: "exfil-after-secrets",
  version: 3,
  owner: "cyber-team",
  when: (e, ctx) =>
    e.call.kind === "net" &&
    ctx.sequence.secretReadWithin("2m") &&
    !ctx.scope.hostAllowed(e.net.host),
  ask: (e, ctx) => [
    {
      kind: "noul",
      name: "dest_fits_task",
      text: `The destination ${e.net.host} is a service the task plausibly needs: ${ctx.session.task}`,
    },
    secrecy,
  ],
  decide: (_e, _ctx, a) => {
    const secret = a.payload_secrecy;
    if (secret.level === "credential" && secret.confidence > 0.8) return "kill";
    if (a.dest_fits_task.p < 0.4) return "deny";
    if (a.dest_fits_task.p < 0.8) return "hold";
    return "annotate";
  },
  reason: "Network call to a new host shortly after reading a secret.",
};

/** What the SDK's `definePolicy` will be: a const-generic identity. */
function define<const Q extends readonly Question[]>(p: PolicyDefinition<Q>): PolicyDefinition<Q> {
  return p;
}

const inferred = define({
  name: "inferred",
  version: 1,
  owner: "t",
  when: () => true,
  ask: () => [
    { kind: "noul", name: "fits", text: "t" },
    { kind: "choice", name: "dest", text: "t", options: { registry: null, paste: "a paste bin" } },
  ],
  decide: (_e, _c, a) => (a.fits.p > 0.5 && a.dest.choice === "registry" ? "allow" : "hold"),
  reason: (_e, _c, a) => `dest ${a.dest.choice}`,
});

// A specific policy is assignable to the list the loader and engine hold.
const registry: PolicyDefinition[] = [exfilAfterSecrets, inferred];

const noAsk: PolicyDefinition = {
  name: "no-ask",
  version: 1,
  owner: "t",
  when: (e) => e.kind === "fs.delete",
  decide: () => "hold",
  reason: "Deletes need a look.",
  range: ["hold", "deny"],
  fallback: "hold",
};

const wrong: PolicyDefinition<ExfilQuestions> = {
  ...exfilAfterSecrets,
  decide: (_e, _ctx, a) => {
    // @ts-expect-error: a question name that was never asked
    void a.not_asked;
    // @ts-expect-error: a level outside the rubric
    if (a.payload_secrecy.level === "secret") return "deny";
    // @ts-expect-error: a noul answer has no level
    void a.dest_fits_task.level;
    return "allow";
  },
};

describe("policy contract types", () => {
  test("the spec example's decide routes answers as written", () => {
    // Arrange
    const e = {} as PolicyEvent;
    const ctx = {} as PolicyContext;
    const answers = (secret: number, fits: number): AnswersFor<ExfilQuestions> => ({
      payload_secrecy: {
        kind: "score",
        score: secret,
        level: secrecy.rubric[secret] ?? "credential",
        confidence: 0.9,
        probabilities: {},
      } satisfies ScoreAnswer<"public" | "internal" | "credential">,
      dest_fits_task: { kind: "noul", p: fits, confidence: 0.9 } satisfies NoulAnswer,
    });
    // Act + Assert
    expect(exfilAfterSecrets.decide(e, ctx, answers(2, 0.9))).toBe("kill");
    expect(exfilAfterSecrets.decide(e, ctx, answers(0, 0.1))).toBe("deny");
    expect(exfilAfterSecrets.decide(e, ctx, answers(0, 0.5))).toBe("hold");
    expect(exfilAfterSecrets.decide(e, ctx, answers(0, 0.95))).toBe("annotate");
  });

  test("policies of different question shapes share one list", () => {
    expect([...registry, noAsk, wrong].map((p) => p.name)).toEqual([
      "exfil-after-secrets",
      "inferred",
      "no-ask",
      "exfil-after-secrets",
    ]);
  });
});
