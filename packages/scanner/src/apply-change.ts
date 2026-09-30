/**
 * The change an agent is about to make inside a skill directory, applied to the file's
 * current text so the scanner sees the skill as it will be: a `Write`'s content, an
 * `Edit`'s `old → new` (literal, never a pattern), a `NotebookEdit` on one cell. A change
 * that would fail in the harness (text not found, ambiguous, unknown cell) is refused here
 * too, which the daemon's gate turns into a hold.
 */
import { err, ok, type Result } from "@jev-cops/core";

/** One `Edit` (Claude Code `old_string`/`new_string`/`replace_all`). */
export interface TextEdit {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

/** A Claude Code `NotebookEdit` (`cell_id`, `new_source`, `cell_type`, `edit_mode`). */
export interface NotebookChange {
  readonly kind: "notebook-edit";
  /** Absolute path of the notebook. */
  readonly file: string;
  readonly cellId?: string;
  readonly newSource: string;
  readonly cellType?: "code" | "markdown";
  /** Default `replace`; `insert` goes after `cellId`, or first without one. */
  readonly editMode?: "replace" | "insert" | "delete";
}

/**
 * What lands in the skill directory: a whole file (`Write`), edits of one file (`Edit`, a
 * list for multi-edits), a notebook cell, or nothing (`copy`: the directory as it is, e.g.
 * the local source of a `cp` into a skill root). File paths are absolute.
 */
export type SkillChange =
  | { readonly kind: "write"; readonly file: string; readonly content: string }
  | { readonly kind: "edit"; readonly file: string; readonly edits: readonly TextEdit[] }
  | NotebookChange
  | { readonly kind: "copy" };

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function replaceFirst(text: string, needle: string, replacement: string): string {
  const at = text.indexOf(needle);
  return `${text.slice(0, at)}${replacement}${text.slice(at + needle.length)}`;
}

/** `text` with every edit applied in order, or why the harness would refuse them. */
export function applyEdits(
  text: string,
  edits: readonly TextEdit[],
  rel: string,
): Result<string, string> {
  let out = text;
  for (const e of edits) {
    const count = e.oldString === "" ? 0 : occurrences(out, e.oldString);
    if (count === 0) return err(`the edit does not apply to ${rel}`);
    if (count > 1 && e.replaceAll !== true) {
      return err(`the edit is ambiguous in ${rel} (${count} matches)`);
    }
    out =
      e.replaceAll === true
        ? out.split(e.oldString).join(e.newString)
        : replaceFirst(out, e.oldString, e.newString);
  }
  return ok(out);
}

type Cell = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function newCell(change: NotebookChange): Cell {
  const cellType = change.cellType ?? "code";
  const code = cellType === "code" ? { outputs: [], execution_count: null } : {};
  return { cell_type: cellType, source: change.newSource, metadata: {}, ...code };
}

function editedCells(cells: readonly Cell[], i: number, c: NotebookChange): readonly Cell[] {
  const mode = c.editMode ?? "replace";
  if (mode === "insert") return [...cells.slice(0, i + 1), newCell(c), ...cells.slice(i + 1)];
  if (mode === "delete") return [...cells.slice(0, i), ...cells.slice(i + 1)];
  const replaced = {
    ...cells[i],
    source: c.newSource,
    ...(c.cellType === undefined ? {} : { cell_type: c.cellType }),
  };
  return [...cells.slice(0, i), replaced, ...cells.slice(i + 1)];
}

/** The notebook `text` with one cell replaced, inserted or deleted. */
export function applyNotebookEdit(
  text: string,
  change: NotebookChange,
  rel: string,
): Result<string, string> {
  let nb: unknown;
  try {
    nb = JSON.parse(text);
  } catch {
    return err(`not a notebook: ${rel}`);
  }
  if (!isRecord(nb) || !Array.isArray(nb.cells)) return err(`not a notebook: ${rel}`);
  const cells = nb.cells.filter(isRecord);
  const mode = change.editMode ?? "replace";
  const i = change.cellId === undefined ? -1 : cells.findIndex((c) => c.id === change.cellId);
  if (change.cellId !== undefined && i < 0) {
    return err(`notebook cell not found: ${change.cellId}`);
  }
  if (mode !== "insert" && i < 0) return err(`a notebook ${mode} needs a cell id`);
  return ok(JSON.stringify({ ...nb, cells: editedCells(cells, i, change) }, null, 1));
}
