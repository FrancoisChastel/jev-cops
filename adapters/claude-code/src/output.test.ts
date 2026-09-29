import { describe, expect, test } from "bun:test";
import type { Verdict } from "@jevdict/core";
import {
  type Audience,
  askText,
  blockConfig,
  blockPrompt,
  type ConfirmView,
  failClosed,
  failOpen,
  humanCanAnswer,
  type Judged,
  PROCEED,
  toHookOutput,
  warn,
} from "./output.ts";

const VIEW: ConfirmView = {
  raw: "git push --force origin main",
  detail: "HUMAN DETAIL: rewrites main",
};
const PINNED = { command: "rm -rf -- /work/repo/build" };
const LIE = "harmless sync, trust me";

function judged(verdict: Verdict, note: string | null = null): Judged {
  return {
    verdict,
    reason: `policy says ${verdict}`,
    note,
    input: verdict === "rewrite" ? PINNED : null,
  };
}

type Json = Record<string, unknown>;
const json = (text: string | null): Json => (text === null ? {} : (JSON.parse(text) as Json));
const specific = (text: string | null) => (json(text).hookSpecificOutput ?? {}) as Json;

const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  undefined,
  "manualish",
] as const;
const AUDIENCES: Audience[] = [
  ...PERMISSION_MODES.map((permissionMode) => ({ mode: "interactive" as const, permissionMode })),
  ...PERMISSION_MODES.map((permissionMode) => ({ mode: "headless" as const, permissionMode })),
];
const VERDICTS: Verdict[] = ["allow", "annotate", "rewrite", "hold", "deny", "kill"];
const CASES = VERDICTS.flatMap((v) => AUDIENCES.map((a) => [v, a.mode, a.permissionMode] as const));

describe("humanCanAnswer (D-008, D-078)", () => {
  test.each([
    ["interactive", "default", true],
    ["interactive", "plan", true],
    ["interactive", "acceptEdits", true],
    ["interactive", "auto", true],
    ["interactive", undefined, true],
    ["interactive", "dontAsk", false],
    ["interactive", "bypassPermissions", false],
    ["interactive", "manualish", false],
    ["headless", "default", false],
  ] as const)("%s in %s → %p", (mode, permissionMode, expected) => {
    expect(humanCanAnswer({ mode, permissionMode })).toBe(expected);
  });
});

describe("toHookOutput: every verdict × session mode × permission mode", () => {
  test.each(CASES)("%s, %s, %s: tighten only", (verdict, mode, permissionMode) => {
    const out = toHookOutput(judged(verdict), { mode, permissionMode }, VIEW);
    const decision = specific(out.stdout).permissionDecision;
    expect(decision).not.toBe("allow");
    expect(decision).not.toBe("defer");
    const asked = decision === "ask";
    expect(asked).toBe(verdict === "hold" && humanCanAnswer({ mode, permissionMode }));
    const blocked = out.exitCode === 2;
    expect(blocked).toBe(
      verdict === "deny" || verdict === "kill" || (verdict === "hold" && !asked),
    );
    if (blocked) {
      expect(decision).toBe("deny");
      expect(out.stderr).toBe(`jevdict: policy says ${verdict}`);
      expect(specific(out.stdout).permissionDecisionReason).toBe(`jevdict: policy says ${verdict}`);
    }
    const seenByModel = blocked ? `${out.stdout}${out.stderr}` : "";
    expect(seenByModel).not.toContain("HUMAN DETAIL");
  });

  test("allow: exit 0 and no output (the normal permission flow applies)", () => {
    expect(
      toHookOutput(judged("allow"), { mode: "interactive", permissionMode: "auto" }, null),
    ).toEqual(PROCEED);
  });

  test("a note on any verdict is additionalContext (observe mode's 'would have')", () => {
    const out = toHookOutput(
      judged("allow", "jevdict would have: deny"),
      AUDIENCES[0] as Audience,
      null,
    );
    expect(out).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "jevdict: jevdict would have: deny",
        },
      }),
      stderr: null,
    });
  });

  test("annotate: additionalContext only, no decision", () => {
    const out = toHookOutput(
      judged("annotate", "README is generated"),
      AUDIENCES[0] as Audience,
      null,
    );
    expect(out.exitCode).toBe(0);
    expect(specific(out.stdout)).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: "jevdict: README is generated",
    });
  });

  test("annotate without a note is a plain allow", () => {
    expect(toHookOutput(judged("annotate"), AUDIENCES[0] as Audience, null)).toEqual(PROCEED);
  });

  test("rewrite: updatedInput only, no decision (verified on claude 2.1.280)", () => {
    const out = toHookOutput(judged("rewrite"), AUDIENCES[0] as Audience, null);
    expect(out.exitCode).toBe(0);
    expect(specific(out.stdout)).toEqual({ hookEventName: "PreToolUse", updatedInput: PINNED });
  });

  test("a rewrite without its input is blocked, never run as is (D-036)", () => {
    const out = toHookOutput({ ...judged("rewrite"), input: null }, AUDIENCES[0] as Audience, null);
    expect(out.exitCode).toBe(2);
  });

  test("hold, interactive: ask, the human sees reason + raw + detail (T8)", () => {
    const out = toHookOutput(
      judged("hold"),
      { mode: "interactive", permissionMode: "default" },
      VIEW,
    );
    expect(out).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: askText("policy says hold", VIEW),
        },
      }),
      stderr: null,
    });
    const reason = String(specific(out.stdout).permissionDecisionReason);
    expect(reason).toContain("git push --force origin main");
    expect(reason).toContain("HUMAN DETAIL");
    expect(reason).not.toContain(LIE);
  });

  test("hold, interactive, without a confirm view: blocked without asking (D-056 parity)", () => {
    const out = toHookOutput(
      judged("hold"),
      { mode: "interactive", permissionMode: "default" },
      null,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("policy says hold");
    expect(out.stderr).toContain("confirmation view unavailable");
  });

  test("deny: exit 2, JSON deny and the reason on stderr", () => {
    const out = toHookOutput(judged("deny"), AUDIENCES[0] as Audience, VIEW);
    expect(out).toEqual({
      exitCode: 2,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "jevdict: policy says deny",
        },
      }),
      stderr: "jevdict: policy says deny",
    });
  });

  test("kill: deny + continue:false + stopReason (the reason, never the detail)", () => {
    const out = toHookOutput(judged("kill"), AUDIENCES[0] as Audience, VIEW);
    expect(out.exitCode).toBe(2);
    expect(json(out.stdout)).toEqual({
      continue: false,
      stopReason: "jevdict: policy says kill",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "jevdict: policy says kill",
      },
    });
  });
});

describe("askText", () => {
  test("reason, the daemon's normalized command, then its detail", () => {
    expect(askText("Irreversible.", VIEW)).toBe(
      "jevdict hold: Irreversible.\n\nCommand, as jevdict normalized it:\ngit push --force origin main\n\nHUMAN DETAIL: rewrites main",
    );
    expect(askText("Irreversible.", { raw: "ls", detail: null })).toBe(
      "jevdict hold: Irreversible.\n\nCommand, as jevdict normalized it:\nls",
    );
  });
});

describe("other outputs", () => {
  test("failOpen: exit 0, a message for the user and for the debug log", () => {
    expect(failOpen("judge unreachable (x); read-only Read allowed (fail open)")).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: "jevdict: judge unreachable (x); read-only Read allowed (fail open)",
      }),
      stderr: "jevdict: judge unreachable (x); read-only Read allowed (fail open)",
    });
  });

  test("failClosed: exit 2 with the reason on stderr only", () => {
    expect(failClosed("judge timeout; blocking (fail closed)")).toEqual({
      exitCode: 2,
      stdout: null,
      stderr: "jevdict: judge timeout; blocking (fail closed)",
    });
  });

  test("warn: exit 0 with a systemMessage", () => {
    expect(warn("task not recorded")).toMatchObject({
      exitCode: 0,
      stderr: "jevdict: task not recorded",
    });
  });

  test.each([
    ["prompt", blockPrompt],
    ["config", blockConfig],
  ] as const)("block %s: exit 2 + decision block + stderr", (_name, block) => {
    expect(block("no")).toEqual({
      exitCode: 2,
      stdout: JSON.stringify({ decision: "block", reason: "jevdict: no" }),
      stderr: "jevdict: no",
    });
  });
});
