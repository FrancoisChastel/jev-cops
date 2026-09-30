/**
 * The compile report as plain text: what each fragment stands for, the live updates, what
 * the policy deliberately leaves out, the gaps the kernel cannot close, and the refusals.
 * Deterministic (the goldens store it next to each policy).
 */
import { commandLine, policyUpdateArgs } from "./argv.ts";
import type { CompiledPolicy } from "./compile.ts";
import type { Absent } from "./types.ts";

function absentLine(a: Absent): string {
  const subject =
    a.host !== undefined ? `host ${a.host}: ` : a.path !== undefined ? `path ${a.path}: ` : "";
  return `  - ${subject}${a.why}`;
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [`${title}: none`] : [`${title}:`, ...lines];
}

/** Renders `compiled` for humans (and goldens). */
export function renderReport(compiled: CompiledPolicy): string {
  const fragments = compiled.fragments.map(
    (f) =>
      `  - ${f.name} (${f.section}) backs ${f.backs.length === 0 ? "nothing loaded" : f.backs.join(", ")}`,
  );
  const updates = compiled.updates.map(
    (u) => `  - ${commandLine("openshell", policyUpdateArgs("<sandbox>", u))}`,
  );
  const lines = [
    `inputs: sha256:${compiled.inputsHash}`,
    `result: ${compiled.refusals.length === 0 ? "policy emitted" : "refused, no policy emitted"}`,
    `judge hosts kept out (T13): ${compiled.judgeHosts.join(", ")}`,
    ...section("fragments", fragments),
    ...section("updates at the first prompt", updates),
    ...section("absent", compiled.absent.map(absentLine)),
    ...section(
      "gaps",
      compiled.gaps.map((g) => `  - ${g}`),
    ),
    ...section(
      "refusals",
      compiled.refusals.map((r) => `  - ${r}`),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
