/**
 * The judge route (D-105): the one network rule that lets the adapter inside the sandbox
 * reach copsd's sandbox listener on the gateway host. There is no mounted Unix socket
 * (PLAN-M2 §2 row 8: bind mounts "can bypass workspace isolation and filesystem policy");
 * "A rule for `host.openshell.internal` can still reach services on the gateway host"
 * (schema.mdx:150-151). The rule is REST-inspected and enforced, allows exactly the routes
 * the harness's adapter calls, and lists one binary, hash-pinned by OpenShell
 * (network-rules.mdx:75-76): the agent's own tools, which do not descend from `cops-hook`,
 * get no route to the judge (PLAN-M2 §2 row 9).
 */
import { type Harness, judgeClient, type SandboxLayout } from "../layout.ts";
import type { NetworkRule } from "../schema.ts";
import type { FragmentReport } from "../types.ts";

/** The rule key. */
export const JUDGE_RULE = "jev_cops_judge";
/** The gateway host as the sandbox names it (schema.mdx:150-151). */
export const JUDGE_HOST = "host.openshell.internal";

interface Route {
  readonly method: "GET" | "POST";
  readonly path: string;
}

/**
 * What each adapter calls, and nothing else. Claude Code: adapters/claude-code/src/
 * client.ts:73-77 (judge, observe, session, the hold's confirm view). Pi: adapters/pi/
 * jev-cops.ts:145-198 (explain, resolve, judge, observe). `/v1/budget/*` and the admin
 * routes are the human's, from the host. Four routes each: the T13 gate's "four paths"
 * (PLAN-M2 §1), narrower than D-105's six-route union.
 */
export const JUDGE_ROUTES: Readonly<Record<Harness, readonly Route[]>> = Object.freeze({
  "claude-code": [
    { method: "POST", path: "/v1/judge" },
    { method: "POST", path: "/v1/observe" },
    { method: "POST", path: "/v1/session" },
    { method: "GET", path: "/v1/explain/*" },
  ],
  pi: [
    { method: "POST", path: "/v1/judge" },
    { method: "POST", path: "/v1/observe" },
    { method: "POST", path: "/v1/resolve" },
    { method: "GET", path: "/v1/explain/*" },
  ],
});

/** The judge rule (keyed by {@link JUDGE_RULE}), or none. */
export interface JudgeRouteFragment extends FragmentReport {
  readonly rules: Readonly<Record<string, NetworkRule>>;
}

const MAX_PORT = 65_535;

/** The judge route for `harness`, on copsd's sandbox listener `judge.port`; null: no route. */
export function judgeRouteFragment(
  harness: Harness,
  layout: SandboxLayout,
  judge: { readonly port: number } | null,
): JudgeRouteFragment {
  const empty = { rules: {}, gaps: [] };
  if (judge === null) {
    const why = "no judge route requested: the adapter cannot reach copsd and fails closed (T2)";
    return { ...empty, absent: [{ host: JUDGE_HOST, why }], refusals: [] };
  }
  const client = judgeClient(harness, layout);
  const refusals = [
    ...(client === null ? [`the ${harness} layout names no judge client binary`] : []),
    ...(Number.isInteger(judge.port) && judge.port >= 1 && judge.port <= MAX_PORT
      ? []
      : [`judge port ${judge.port} is not a TCP port`]),
  ];
  if (client === null || refusals.length > 0) return { ...empty, absent: [], refusals };
  const rule: NetworkRule = {
    endpoints: [
      {
        host: JUDGE_HOST,
        port: judge.port,
        protocol: "rest",
        enforcement: "enforce",
        rules: JUDGE_ROUTES[harness].map((r) => ({ allow: { method: r.method, path: r.path } })),
      },
    ],
    binaries: [{ path: client }],
  };
  return { ...empty, rules: { [JUDGE_RULE]: rule }, absent: [], refusals: [] };
}
