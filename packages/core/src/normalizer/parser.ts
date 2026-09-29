import { fileURLToPath } from "node:url";
import grammarFile from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };
import { Language, type Node, Parser } from "web-tree-sitter";
import runtimeFile from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };

let cached: Promise<Parser> | undefined;

/**
 * The bytes of a WASM file. `embedded` is Bun's file import: the real path under
 * `bun run`/`bun test`, a `/$bunfs/` path inside a `bun build --compile` binary. When it
 * cannot be read, the package's own file (`import.meta.resolve`, the dev path) is used.
 */
async function wasmBytes(embedded: string, specifier: string): Promise<Uint8Array> {
  const file = Bun.file(embedded);
  if (await file.exists()) return file.bytes();
  return Bun.file(fileURLToPath(import.meta.resolve(specifier))).bytes();
}

async function load(): Promise<Parser> {
  const runtime = await wasmBytes(runtimeFile, "web-tree-sitter/web-tree-sitter.wasm");
  const binary = runtime.buffer.slice(runtime.byteOffset, runtime.byteOffset + runtime.byteLength);
  await Parser.init({ wasmBinary: binary as ArrayBuffer });
  const grammar = await wasmBytes(grammarFile, "tree-sitter-bash/tree-sitter-bash.wasm");
  const language = await Language.load(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * The process-wide tree-sitter-bash parser. The WASM runtime and grammar are loaded
 * once, on first use; concurrent callers share the same promise. A failed load is
 * not cached, so a later call retries instead of failing forever.
 */
export function getParser(): Promise<Parser> {
  if (cached === undefined) {
    cached = load().catch((cause: unknown) => {
      cached = undefined;
      throw cause;
    });
  }
  return cached;
}

/**
 * Parses `source` and runs `visit` on the root node, then frees the tree. The tree
 * never escapes this call, so WASM memory cannot leak. Returns null when the parser
 * cannot load, produces no tree, or `visit` throws: callers treat null as unparseable.
 */
export async function parseBash<T>(source: string, visit: (root: Node) => T): Promise<T | null> {
  let parser: Parser;
  try {
    parser = await getParser();
  } catch {
    return null;
  }
  const tree = parser.parse(source);
  if (tree === null) return null;
  try {
    return visit(tree.rootNode);
  } catch {
    return null;
  } finally {
    tree.delete();
  }
}
