import { parseArgs } from "node:util";
import { FEATURE_NAMES, gitSchema } from "@jevdict/core";
import { type AuditLine, readAudit } from "@jevdict/daemon";
import { isLatchedLine, latchedView } from "../audit-session.ts";
import { type JudgePayload, judgeView } from "../audit-view.ts";
import { configuredPaths } from "../config-paths.ts";
import { EXIT, type Io } from "../io.ts";
import { relatedLines, renderLatched, taskLine } from "./explain-session.ts";

const f2 = (n: number) => n.toFixed(2);

function header(line: AuditLine, p: JudgePayload): string[] {
  const d = p.decision;
  const mapped =
    p.mapping.length === 0 ? "" : ` (${p.mapping.join(", ")}; enforcement ${p.enforcement})`;
  return [
    `event ${line.event_id ?? "?"} · session ${line.session_id ?? "?"} · ${new Date(line.at).toISOString()} · audit seq ${line.seq}`,
    `verdict ${d.verdict} · risk ${f2(d.risk)} · floor ${f2(d.floor)}`,
    `returned to the harness: ${p.returned.verdict}${mapped}`,
    `reason: ${d.reason}`,
  ];
}

/** `env.git` as judged, and where it came from: the adapter, or jevdictd's derivation (D-058). */
function gitLine(p: JudgePayload): string {
  const env = typeof p.event === "object" && p.event !== null ? Reflect.get(p.event, "env") : null;
  const sent = gitSchema.safeParse(typeof env === "object" && env !== null ? env.git : undefined);
  const adapter = sent.success ? sent.data : {};
  const derived = p.derived?.git ?? {};
  const git = { ...derived, ...adapter };
  if (Object.keys(git).length === 0) return "env.git: none (repo and branch unknown)";
  const dirty = git.dirty === undefined ? "unknown" : git.dirty ? "yes" : "no";
  const fields = [
    `repo ${git.repo ?? "unknown"}`,
    `branch ${git.branch ?? "unknown"}`,
    `default ${git.default_branch ?? "unknown"}`,
    `dirty ${dirty}`,
  ];
  const keys = Object.keys(derived);
  const from =
    keys.length === 0 ? "sent by the adapter" : `derived by jevdictd from cwd: ${keys.join(", ")}`;
  return `env.git: ${fields.join(" · ")} (${from})`;
}

function command(p: JudgePayload): string[] {
  const n = p.normalized;
  const opaque = n.opaque.map((o) => o.reason).join(", ") || "none";
  return [
    `command: ${p.raw}`,
    `normalized: kind ${n.kind} · paths ${n.paths.join(", ") || "none"} · hosts ${n.hosts.join(", ") || "none"} · opaque ${opaque}`,
    gitLine(p),
  ];
}

function features(p: JudgePayload): string[] {
  return [
    "features:",
    ...FEATURE_NAMES.map((name) => {
      const value = p.decision.features[name] ?? Number.NaN;
      const why = (p.why[name] ?? []).join("; ");
      return `  ${name.padEnd(13)} ${f2(value)}${why === "" ? "" : `  ${why}`}`;
    }),
  ];
}

function policies(p: JudgePayload): string[] {
  const rows = p.decision.trace.map((t) => {
    const marks = [
      t.asked && "asked",
      t.capped && "capped",
      t.fallbackUsed && "fallback",
      t.waived && "waived by precedent",
      t.degraded && "degraded",
      t.note,
    ].filter((m): m is string => typeof m === "string" && m !== "");
    const outcome = t.matched ? `matched → ${t.verdict ?? "none"}` : "not matched";
    return `  ${t.policy}  ${outcome}${marks.length === 0 ? "" : `  [${marks.join(", ")}]`}`;
  });
  return ["policies:", ...(rows.length === 0 ? ["  (none loaded)"] : rows)];
}

function judge(p: JudgePayload): string[] {
  const flags = p.decision.flags;
  const rows = p.decision.jev.map(
    (j) => `  ${j.question}  ${j.type}  p=${f2(j.p)}  confidence=${f2(j.confidence)}`,
  );
  const status = `judge ${String(flags.judge)} · precedent ${String(flags.precedent)}`;
  return [`jev: ${status}`, ...rows];
}

function tail(p: JudgePayload, related: readonly AuditLine[]): string[] {
  const b = p.decision.budget;
  const warning =
    p.flags?.includes("prompt-like-string") === true
      ? [`WARNING prompt-like string in the judged state: ${(p.prompt_like ?? []).join(", ")}`]
      : [];
  return [
    `budget: ${b.spent}/${b.limit} after this event`,
    ...warning,
    ...relatedLines(related),
    "detail (human only, never sent to the agent):",
    ...p.decision.detail.split("\n").map((l) => `  ${l}`),
  ];
}

/**
 * The human rendering of a judge line (spec: "the agent sees reasons, the human details").
 * `lines` is the whole log, where the session's task is looked up when the event has none.
 */
export function renderExplain(
  line: AuditLine,
  p: JudgePayload,
  related: readonly AuditLine[],
  lines: readonly AuditLine[] = [],
): string[] {
  return [
    ...header(line, p),
    taskLine(p.event, lines),
    ...command(p),
    ...features(p),
    ...policies(p),
    ...judge(p),
    ...tail(p, related),
  ];
}

type Rendered = { ok: true; lines: string[] } | { ok: false; error: string };

/** A judge line rendered for a human: a latched one, or a judged one; malformed → error. */
function render(
  line: AuditLine,
  related: readonly AuditLine[],
  all: readonly AuditLine[],
): Rendered {
  if (isLatchedLine(line)) {
    const latched = latchedView(line);
    if (!latched.ok) return latched;
    return { ok: true, lines: renderLatched(line, latched.payload, related, all) };
  }
  const view = judgeView(line);
  if (!view.ok) return view;
  return { ok: true, lines: renderExplain(line, view.payload, related, all) };
}

/**
 * `jevdict explain <event-id> [--audit path] [--json]`: reads the audit log directly (no
 * daemon needed) and prints the decision for one judged event. Exit 1 when the event is
 * not in the log or its line is malformed; 2 on usage errors.
 */
export async function runExplainCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed: { values: { audit?: string; json?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { audit: { type: "string" }, json: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    io.err(`jevdict explain: ${(cause as Error).message}`);
    return EXIT.usage;
  }
  const [eventId, ...extra] = parsed.positionals;
  if (eventId === undefined || extra.length > 0) {
    io.err("jevdict explain: expected exactly one event id");
    return EXIT.usage;
  }
  const path = parsed.values.audit ?? configuredPaths().audit;
  const all = readAudit(path).lines;
  const related = all.filter((l) => l.event_id === eventId);
  const line = related.findLast((l) => l.kind === "judge");
  if (line === undefined) {
    io.err(`jevdict explain: no judged event ${eventId} in ${path}`);
    return EXIT.failed;
  }
  const others = related.filter((l) => l !== line);
  if (parsed.values.json === true) {
    io.out(JSON.stringify({ line, related: others }, null, 2));
    return EXIT.ok;
  }
  const rendered = render(line, others, all);
  if (!rendered.ok) {
    io.err(`jevdict explain: malformed audit line: ${rendered.error}`);
    return EXIT.failed;
  }
  for (const text of rendered.lines) io.out(text);
  return EXIT.ok;
}
