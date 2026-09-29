import { bareHost } from "./net.ts";
import { absolutize } from "./paths.ts";
import type { PathAccess, PathRef } from "./types.ts";
import type { RawRedirect } from "./words.ts";

const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const READ_OPS = new Set(["<"]);
const DUP_OPS = new Set([">&", "<&"]);
const FD_TARGET = /^(?:\d+-?|-)$/;
const DEVICE = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;
const NET_DEVICE = /^\/dev\/(?:tcp|udp)\/([^/]+)\/[^/]+$/;

function accessOf(op: string, target: string): PathAccess | null {
  const core = op.replace(/^\d+/, "");
  if (DUP_OPS.has(core)) return FD_TARGET.test(target) ? null : "write";
  if (WRITE_OPS.has(core)) return "write";
  return READ_OPS.has(core) ? "read" : null;
}

/**
 * File paths named by redirects, resolved against `cwd`: `>`, `>>`, `&>`, `>|`, `<>`
 * write, `<` reads. fd duplications (`2>&1`), devices (`/dev/null`, `/dev/tcp/…`) and
 * non-literal targets are not paths.
 */
export function redirectRefs(redirects: ReadonlyArray<RawRedirect>, cwd: string): PathRef[] {
  return redirects.flatMap((r) => {
    const target = r.target.value;
    const access = accessOf(r.op, target);
    const device = DEVICE.test(target) || NET_DEVICE.test(target);
    if (access === null || !r.target.literal || device) return [];
    const path = absolutize(target, cwd);
    return path === null ? [] : [{ raw: r.target.raw, path, access }];
  });
}

/**
 * Hosts reached through bash's `/dev/tcp/HOST/PORT` and `/dev/udp/HOST/PORT` redirects,
 * which open a socket instead of a file. Only literal targets count.
 */
export function redirectHosts(redirects: ReadonlyArray<RawRedirect>): string[] {
  return redirects.flatMap((r) => {
    const host = r.target.literal ? NET_DEVICE.exec(r.target.value)?.[1] : undefined;
    const bare = host === undefined ? null : bareHost(host);
    return bare === null ? [] : [bare];
  });
}
