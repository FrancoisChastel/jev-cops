/**
 * Which tools may run while the daemon cannot be asked (spec T2: "observe-only events log
 * locally and continue"; D-055 parity): reads (`Read`, `Glob`, `Grep`) and Claude Code's
 * bookkeeping tools that change nothing jev-cops judges (core's inert tools, D-071). Both
 * lists come from their one source (the daemon's post mapper and core's tool table); every
 * other tool, MCP tools included, fails closed.
 */
import { isInertTool } from "@jev-cops/core/normalizer/tools";
import { kindOf } from "@jev-cops/daemon/claude-code/post";

/**
 * True when `tool` proceeds (with a warning) while the daemon is unavailable. Inert names
 * are Claude Code's own: another harness's bookkeeping name (`todowrite`, `update_plan`)
 * is an unknown tool here and fails closed.
 */
export function failsOpen(tool: string): boolean {
  return kindOf(tool) === "fs.read" || isInertTool(tool, "claude-code");
}
