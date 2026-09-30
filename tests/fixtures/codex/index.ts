import { readFileSync } from "node:fs";

/** Names of the documented Codex hook payloads (see README.md in this directory). */
export const CODEX_FIXTURES = [
  "pre-tool-use.bash",
  "pre-tool-use.bash-apply-patch",
  "pre-tool-use.bash-interactive",
  "pre-tool-use.apply-patch",
  "pre-tool-use.apply-patch-config",
  "pre-tool-use.mcp",
  "pre-tool-use.spawn-agent",
  "pre-tool-use.subagent-bash",
  "pre-tool-use.view-image",
  "pre-tool-use.update-plan",
  "post-tool-use.bash",
] as const;

export type CodexFixtureName = (typeof CODEX_FIXTURES)[number];

/**
 * Loads a payload as the text Codex writes to a command hook's stdin. Each call reads the
 * file again, so a test that derives a variant can never leak into another test.
 */
export function codexPayloadText(name: CodexFixtureName): string {
  return readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8");
}

/** Loads a payload as a fresh JSON object. */
export function codexPayload(name: CodexFixtureName): Record<string, unknown> {
  return JSON.parse(codexPayloadText(name)) as Record<string, unknown>;
}
