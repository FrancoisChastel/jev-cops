/**
 * Report types shared by the fragments and the compiler. OpenShell is allow-only
 * (PLAN-M2 §2 row 1), so what the policy deliberately leaves out is as much a result as
 * what it lists: {@link Absent} records each omission and why.
 */

/** A host or path the policy deliberately does not allow, and why. */
export interface Absent {
  readonly host?: string;
  readonly path?: string;
  readonly why: string;
}

/** What one fragment contributes to the report. */
export interface FragmentReport {
  readonly absent: readonly Absent[];
  /** Known weaknesses the kernel cannot close; printed, never refused. */
  readonly gaps: readonly string[];
  /** Reasons the compiler will not emit a policy at all. */
  readonly refusals: readonly string[];
}

/** `path` equals `root` or lies below it (plain string paths, no normalisation). */
export function isUnder(path: string, root: string): boolean {
  if (root === "/") return path.startsWith("/");
  return path === root || path.startsWith(`${root}/`);
}

/** Why `path` cannot be a policy path (absolute, no `..`, ≤ 4096 bytes: schema.mdx:55-56). */
export function pathProblem(path: string): string | null {
  if (!path.startsWith("/")) return `${path || '""'}: a sandbox path must be absolute`;
  if (path.split("/").includes("..")) return `${path}: a sandbox path must not contain \`..\``;
  if (new TextEncoder().encode(path).length > 4096) return `${path}: longer than 4096 bytes`;
  return null;
}
