import { readFileSync } from "node:fs";

/** Names of the documented Claude Code hook payloads (see README.md in this directory). */
export const CLAUDE_CODE_FIXTURES = [
  "pre-tool-use.bash",
  "pre-tool-use.subagent",
  "pre-tool-use.mcp",
  "pre-tool-use.windows-write",
  "post-tool-use.write",
  "post-tool-use-failure.bash",
  "user-prompt-submit",
  "config-change",
  "session-start",
  "session-end",
] as const;

export type ClaudeCodeFixtureName = (typeof CLAUDE_CODE_FIXTURES)[number];

/**
 * Loads a payload as the text Claude Code writes to a hook's stdin. Each call reads the
 * file again, so a test that derives a variant can never leak into another test.
 */
export function claudeCodePayloadText(name: ClaudeCodeFixtureName): string {
  return readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8");
}

/** Loads a payload as a fresh JSON object. */
export function claudeCodePayload(name: ClaudeCodeFixtureName): Record<string, unknown> {
  return JSON.parse(claudeCodePayloadText(name)) as Record<string, unknown>;
}
