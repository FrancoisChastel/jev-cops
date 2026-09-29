import { absolutize } from "./paths.ts";
import type { PathAccess, PathRef } from "./types.ts";
import type { RawRedirect } from "./words.ts";

const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const READ_OPS = new Set(["<"]);
const DUP_OPS = new Set([">&", "<&"]);
const FD_TARGET = /^(?:\d+-?|-)$/;
const DEVICE = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

function accessOf(op: string, target: string): PathAccess | null {
  const core = op.replace(/^\d+/, "");
  if (DUP_OPS.has(core)) return FD_TARGET.test(target) ? null : "write";
  if (WRITE_OPS.has(core)) return "write";
  return READ_OPS.has(core) ? "read" : null;
}

/**
 * File paths named by redirects, resolved against `cwd`: `>`, `>>`, `&>`, `>|`, `<>`
 * write, `<` reads. fd duplications (`2>&1`), devices (`/dev/null`) and non-literal
 * targets are not paths.
 */
export function redirectRefs(redirects: ReadonlyArray<RawRedirect>, cwd: string): PathRef[] {
  return redirects.flatMap((r) => {
    const target = r.target.value;
    const access = accessOf(r.op, target);
    if (access === null || !r.target.literal || DEVICE.test(target)) return [];
    const path = absolutize(target, cwd);
    return path === null ? [] : [{ raw: r.target.raw, path, access }];
  });
}
