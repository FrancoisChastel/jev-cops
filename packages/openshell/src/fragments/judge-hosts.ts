/**
 * T13 (the judge exfil path): the semantic judge's provider endpoints are for copsd, on the
 * host, never for the sandbox (spec §OpenShell complement "Protection": "The Jev API
 * endpoint is allowlisted for the daemon's host, not for the sandbox"). OpenShell denies
 * every host no rule allows, so the compiler keeps these hosts out of every rule it writes
 * and asserts, on the finished policy, that no endpoint can reach one of them or a name
 * under it (PLAN-M2 §7 row "T13 judge exfil path").
 */
import { JEV_DEFAULT_BASE_URL, OPENROUTER_DEFAULT_BASE_URL } from "@jev-cops/judge";
import { coversDomain } from "../hosts.ts";
import type { OpenShellPolicy } from "../schema.ts";

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/**
 * The default endpoints of `@jev-cops/judge`'s providers (TypeSafe Jev, OpenRouter). The
 * Vercel AI SDK provider takes a caller-built model with no base URL of its own, so its
 * host comes from the operator (`--judge-host`), like any configured base URL.
 */
export const JUDGE_PROVIDER_HOSTS: readonly string[] = Object.freeze(
  [hostOf(JEV_DEFAULT_BASE_URL), hostOf(OPENROUTER_DEFAULT_BASE_URL)].sort(),
);

/** The judge host `host` can reach (itself or a parent domain of it), or null. */
export function judgeHostReached(host: string, judgeHosts: readonly string[]): string | null {
  return judgeHosts.find((j) => coversDomain(host, j)) ?? null;
}

/** One refusal per endpoint of `policy` that can reach a judge provider host. */
export function t13Refusals(policy: OpenShellPolicy, judgeHosts: readonly string[]): string[] {
  return Object.entries(policy.network_policies ?? {}).flatMap(([key, rule]) =>
    (rule.endpoints ?? []).flatMap((e) => {
      const hit = e.host === undefined ? null : judgeHostReached(e.host, judgeHosts);
      return hit === null
        ? []
        : [`network_policies.${key}: ${e.host} reaches judge provider ${hit} (T13)`];
    }),
  );
}
