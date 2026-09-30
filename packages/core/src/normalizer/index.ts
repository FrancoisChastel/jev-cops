/**
 * Bash normalizer: turns a canonical event into the daemon's own reading of it
 * (commands, kinds, verbs, paths, hosts, opaque spans, decoded literals, state hash).
 * Never throws, never touches the filesystem; only the tree-sitter parser is impure.
 */
export {
  APPLY_PATCH_COMMANDS,
  type CarriedCode,
  type Classification,
  COMMAND_KIND_ORDER,
  classifyArgv,
  FILE_RULES,
  HARNESS_CLIS,
  HARNESS_CONFIG_VERB,
  INTERACTIVE_SHELL_VERB,
  INTERPRETER_INLINE_FLAGS,
  type InterpreterInfo,
  maxKind,
  PATCH_VERB,
  REPLS,
  SHELLS,
  SUBCOMMAND_KINDS,
  VERB_KINDS,
  WRAPPERS,
  type WrapperRule,
} from "./classify.ts";
export {
  type CommandOptions,
  eventKind,
  MAX_INTERPRETER_DEPTH,
  normalizeCommand,
} from "./command.ts";
export { decodeLiteral, isDecoder, MAX_DECODE_CHARS } from "./decode.ts";
export { GIT_SUBCOMMAND_KINDS } from "./git.ts";
export { withHarnessEnv } from "./harness.ts";
export { canonicalJson, sha256Hex } from "./hash.ts";
export {
  canonicalTool,
  eventToolRule,
  HARNESS_TOOL_ALIASES,
  HARNESS_TOOL_RULES,
  isInertTool,
  mcpServer,
  type NormalizeOptions,
  normalize,
  stateHash,
  TOOL_ALIASES,
  TOOL_RULES,
  type ToolRule,
  type ToolTable,
  toolRule,
  UNRENDERABLE_INPUT,
} from "./normalize.ts";
export { getParser } from "./parser.ts";
export { type ParsedPatch, type PatchHunk, type PatchOp, parsePatch } from "./patch.ts";
export { absolutize, expandHome, looksLikePath, resolvePath } from "./paths.ts";
export * from "./types.ts";
