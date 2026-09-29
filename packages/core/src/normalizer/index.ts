/**
 * Bash normalizer: turns a canonical event into the daemon's own reading of it
 * (commands, kinds, verbs, paths, hosts, opaque spans, decoded literals, state hash).
 * Never throws, never touches the filesystem; only the tree-sitter parser is impure.
 */
export {
  type Classification,
  COMMAND_KIND_ORDER,
  classifyArgv,
  FILE_RULES,
  INTERPRETER_INLINE_FLAGS,
  type InterpreterInfo,
  maxKind,
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
export { canonicalJson, sha256Hex } from "./hash.ts";
export {
  type NormalizeOptions,
  normalize,
  stateHash,
  TOOL_RULES,
  type ToolRule,
  UNRENDERABLE_INPUT,
} from "./normalize.ts";
export { getParser } from "./parser.ts";
export { absolutize, expandHome, looksLikePath, resolvePath } from "./paths.ts";
export * from "./types.ts";
