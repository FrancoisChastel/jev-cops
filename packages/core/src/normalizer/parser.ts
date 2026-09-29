import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";

let cached: Promise<Parser> | undefined;

function grammarPath(): string {
  return fileURLToPath(import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
}

async function load(): Promise<Parser> {
  await Parser.init();
  const language = await Language.load(grammarPath());
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
