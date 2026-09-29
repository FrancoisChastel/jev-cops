import { describe, expect, test } from "bun:test";
import type { PolicyContext, PolicyEvent } from "@jevdict/core";
import { definePolicy } from "./define.ts";
import { jev } from "./jev.ts";

/**
 * The spec §Policy-as-code example, copied from docs/SPEC.md. One deviation: `decide`
 * names its unused parameters `_e, _ctx`, because the repo's `noUnusedParameters` rejects
 * the verbatim `(e, ctx, a)`. This file only compiles if `a.payload_secrecy.level` and
 * `a.dest_fits_task.p` are inferred from `ask` with their literal names and labels.
 */
const exfil = definePolicy({
  name: "exfil-after-secrets",
  version: 3,
  owner: "cyber-team",
  // cheap deterministic prefilter; most events stop here
  when: (e, ctx) =>
    e.call.kind === "net" &&
    ctx.sequence.secretReadWithin("2m") &&
    !ctx.scope.hostAllowed(e.net.host),
  // semantic questions, only asked when `when` is true
  ask: (e, ctx) => [
    jev.noul(
      "dest_fits_task",
      `The destination ${e.net.host} is a service the task plausibly needs: ${ctx.session.task}`,
    ),
    jev.score("payload_secrecy", "How secret-like is the request payload?", [
      "public",
      "internal",
      "credential",
    ]),
  ],
  // code owns the verdict; answers arrive typed with p and confidence
  decide: (_e, _ctx, a) => {
    if (a.payload_secrecy.level === "credential" && a.payload_secrecy.confidence > 0.8)
      return "kill";
    if (a.dest_fits_task.p < 0.4) return "deny";
    if (a.dest_fits_task.p < 0.8) return "hold";
    return "annotate";
  },
  reason: "Network call to a new host shortly after reading a secret.",
});

const E = {} as PolicyEvent;
const CTX = {} as PolicyContext;

function answers(level: "public" | "internal" | "credential", fits: number) {
  const score = ["public", "internal", "credential"].indexOf(level);
  return {
    payload_secrecy: { kind: "score", score, level, confidence: 0.95, probabilities: {} },
    dest_fits_task: { kind: "noul", p: fits, confidence: 0.9 },
  } as const;
}

describe("definePolicy", () => {
  test("accepts the spec example and keeps its behaviour", () => {
    expect(exfil.name).toBe("exfil-after-secrets");
    expect(exfil.decide(E, CTX, answers("credential", 0.9))).toBe("kill");
    expect(exfil.decide(E, CTX, answers("public", 0.2))).toBe("deny");
    expect(exfil.decide(E, CTX, answers("public", 0.6))).toBe("hold");
    expect(exfil.decide(E, CTX, answers("public", 0.9))).toBe("annotate");
  });

  test("returns a frozen policy", () => {
    expect(Object.isFrozen(exfil)).toBe(true);
  });

  test("a missing decide throws at definition time, naming the policy and the problem", () => {
    const bad = { name: "no-decide", version: 1, owner: "t", when: () => true, reason: "r" };
    // @ts-expect-error: decide is required by the contract
    expect(() => definePolicy(bad)).toThrow('definePolicy("no-decide"): decide must be a function');
  });

  test("every problem is listed in one message", () => {
    const bad = { name: "Bad Name", version: 0, owner: "", when: () => true, reason: "" };
    // @ts-expect-error: decide is required by the contract
    expect(() => definePolicy(bad)).toThrow(
      /name must be kebab-case; version must be an integer >= 1; owner must be a non-empty string; decide must be a function; reason must be/,
    );
  });

  test("an async when is rejected", () => {
    const bad = {
      name: "async-when",
      version: 1,
      owner: "t",
      when: async () => true,
      decide: () => "allow" as const,
      reason: "r",
    };
    // @ts-expect-error: when must be synchronous
    expect(() => definePolicy(bad)).toThrow("when must be synchronous");
  });

  test("answer types reject names and labels that were never asked (compile-time)", () => {
    const p = definePolicy({
      name: "typed",
      version: 1,
      owner: "t",
      when: () => true,
      ask: () => [jev.choice("dest", "Where?", { registry: null, paste: "a paste bin" })],
      decide: (_e, _c, a) => {
        // @ts-expect-error: not asked
        void a.other;
        // @ts-expect-error: not an option
        if (a.dest.choice === "gist") return "deny";
        return a.dest.choice === "registry" ? "allow" : "hold";
      },
      reason: "r",
    });
    expect(p.name).toBe("typed");
  });
});
