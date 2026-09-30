import {
  definePolicy,
  type OpaqueReason,
  type PolicyContext,
  type PolicyEvent,
} from "@jev-cops/sdk";

/**
 * opaque-exec (spec §Starter policy set): interpreters, `eval`, base64 pipes, freshly
 * written executables → annotate; hold when tainted. Deterministic; asks nothing.
 *
 * Matches an event whose normalizer reading has an opaque span for code the judge cannot
 * read as plain commands (interpreter, eval, decoded pipe, heredoc exec, command or process
 * substitution, a command name holding shell syntax, code read from the network), or
 * whose exec runs a file written in the sequence window (write-executable-then-exec).
 *
 * Holds instead of annotating when:
 * - anything in the call came from tool output (taint > 0: the spec's "hold when tainted");
 * - the code arrives through a decoded pipe (`echo … | base64 -d | sh`) or from the network
 *   (`curl … | sh`, a shell on `/dev/tcp`): remote code execution;
 * - the code the normalizer could read inside it (`bash -c`, `eval`, decoded payloads,
 *   `env -S`, ssh's remote command) deletes, reaches the network or escalates privilege,
 *   or a privilege wrapper (`sudo`, `doas`, `su -c`) runs it.
 *
 * Invariant: never below `annotate` once matched, never above `hold`: other policies own
 * `deny` and `kill`. The context note names the opaque reasons.
 */

/** Opaque reasons this policy watches; `dynamic-expansion` and `parse-error` are not. */
const WATCHED: readonly OpaqueReason[] = [
  "interpreter",
  "eval",
  "decoded-pipe",
  "heredoc-exec",
  "command-substitution",
  "process-substitution",
  "dynamic-command",
  "net-pipe",
];
/** Reasons that are remote code execution whatever the content. */
const ALWAYS_HOLD: readonly OpaqueReason[] = ["decoded-pipe", "net-pipe"];
const WRITE_THEN_EXEC = "write-executable-then-exec";

function reasons(e: PolicyEvent): OpaqueReason[] {
  return [...new Set(e.opaque.map((o) => o.reason))].filter((r) => WATCHED.includes(r));
}

/** Commands the normalizer read out of interpreter strings, eval, payloads or carriers. */
function dangerousInner(e: PolicyEvent): boolean {
  return e.commands.some(
    (c) =>
      c.viaInterpreter &&
      (c.kind === "fs.delete" || c.kind === "net" || c.verbs.includes("privilege")),
  );
}

function why(e: PolicyEvent, ctx: PolicyContext): string[] {
  const found = reasons(e);
  return ctx.sequence.matched(WRITE_THEN_EXEC) ? [...found, WRITE_THEN_EXEC] : found;
}

export default definePolicy({
  name: "opaque-exec",
  version: 1,
  owner: "cyber-team",
  when: (e, ctx) => reasons(e).length > 0 || ctx.sequence.matched(WRITE_THEN_EXEC),
  decide: (e, ctx) => {
    if (ctx.taint.fraction > 0) return "hold";
    if (reasons(e).some((r) => ALWAYS_HOLD.includes(r))) return "hold";
    return dangerousInner(e) || e.verbs.includes("privilege") ? "hold" : "annotate";
  },
  reason: "Runs code the judge cannot fully read (interpreter, eval or encoded input).",
  contextNote: (e, ctx) =>
    `jev-cops could not read everything this runs (${why(e, ctx).join(", ")}); it was logged.`,
  detail: (e, ctx) =>
    [
      `opaque: ${why(e, ctx).join(", ")}`,
      `inner delete/net/privilege: ${dangerousInner(e) || e.verbs.includes("privilege")}`,
    ].join("; "),
  range: ["annotate", "hold"],
});
