/**
 * A zod mirror of the OpenShell v0.1.2 sandbox policy schema, so a policy jev-cops emits
 * is checked here before any gateway sees it (PLAN-M2 §2 row 6: a rejected revision
 * blacks out the sandbox's network under `fail_closed`). Every field and constraint comes
 * from the cloned OpenShell repo at `main` 7caff12:
 * docs/how-it-works/policies/schema.mdx (cited as `schema.mdx:<line>`), and the serde
 * structs of crates/openshell-policy-schema/src/lib.rs:179-500 where the docs name a
 * field without its shape. Strict objects throughout: OpenShell "rejects a policy that
 * contains unknown fields or duplicate keys" (schema.mdx:11-13). Cross-field rules are in
 * schema-checks.ts.
 */
import { err, ok, type Result } from "@jev-cops/core";
import { z } from "zod";
import { policyProblems } from "./schema-checks.ts";

/** At most 4096 bytes per path, 256 paths per policy (schema.mdx:55-56). */
export const MAX_PATH_BYTES = 4096;
/** Combined `read_only` + `read_write` entries (schema.mdx:56; lib.rs:1016). */
export const MAX_PATHS = 256;
/** Request-inspection protocols and `tcp` (schema.mdx:157). */
export const PROTOCOLS = ["rest", "websocket", "graphql", "mcp", "json-rpc", "tcp"] as const;
/** MCP revisions accepted in `mcp.versions` (schema.mdx:429-430). */
export const MCP_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;

const MAX_UID = 4_294_967_294;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

const policyPath = z
  .string()
  .refine((p) => byteLength(p) <= MAX_PATH_BYTES, `a path must not exceed ${MAX_PATH_BYTES} bytes`)
  .refine((p) => p.startsWith("/"), "a path must be absolute")
  .refine((p) => !p.split("/").includes(".."), "a path must not contain `..`");

/** `read_write` cannot contain `/` (schema.mdx:56); repeated slashes are still `/` (lib.rs:1382). */
const writablePath = policyPath.refine(
  (p) => p.replace(/\/+$/, "") !== "",
  "read_write cannot contain `/`",
);

const filesystemPolicy = z.strictObject({
  include_workdir: z.boolean().optional(),
  read_only: z.array(policyPath).optional(),
  read_write: z.array(writablePath).optional(),
});

/** schema.mdx:67-69. */
const landlock = z.strictObject({
  compatibility: z.enum(["best_effort", "hard_requirement"]).optional(),
});

/** `sandbox` or a numeric id from 1 through 4294967294 (schema.mdx:88-91). */
const identity = z
  .string()
  .refine(
    (v) => v === "sandbox" || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_UID),
    "must be `sandbox` or a numeric id from 1 through 4294967294",
  );

const processPolicy = z.strictObject({
  run_as_user: identity.optional(),
  run_as_group: identity.optional(),
});

/** A glob or `{ any: [globs] }` (schema.mdx:266, :341). */
const globOrAny = z.union([z.string(), z.strictObject({ any: z.array(z.string()) })]);

/** MCP `params` matchers may nest (lib.rs:403-409). */
export type ParamMatcher = string | { any: string[] } | { [key: string]: ParamMatcher };
const paramMatcher: z.ZodType<ParamMatcher> = z.lazy(() =>
  z.union([globOrAny, z.record(z.string(), paramMatcher)]),
);

/** Matcher fields of every protocol (schema.mdx:262-519); which apply depends on `protocol`. */
const matcher = z.strictObject({
  method: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  query: z.record(z.string(), globOrAny).optional(),
  operation_type: z.enum(["query", "mutation", "subscription"]).optional(),
  operation_name: z.string().optional(),
  fields: z.array(z.string()).optional(),
  tool: globOrAny.optional(),
  params: z.record(z.string(), paramMatcher).optional(),
});

/** Allow rules wrap their matcher in `allow`; deny rules list it directly (schema.mdx:243-246). */
const allowRule = z.strictObject({ allow: matcher });

/** A persisted GraphQL operation (lib.rs:370-378). */
const graphqlOperation = z.strictObject({
  operation_type: z.string().optional(),
  operation_name: z.string().optional(),
  fields: z.array(z.string()).optional(),
});

const port = z.int().min(1).max(65_535);
const bodyBytes = z.int().positive();

/** Destination, inspection, credential and protocol-option fields (schema.mdx:125-209). */
const endpoint = z.strictObject({
  host: z.string().optional(),
  port: port.optional(),
  ports: z.array(port).min(1).optional(),
  path: z.string().optional(),
  allowed_ips: z.array(z.string().min(1)).optional(),
  protocol: z.enum(PROTOCOLS).optional(),
  tls: z
    .literal("skip", { error: "tls accepts only `skip` (omit it for automatic TLS)" })
    .optional(),
  enforcement: z.enum(["enforce", "audit"]).optional(),
  access: z.enum(["read-only", "read-write", "full"]).optional(),
  rules: z.array(allowRule).optional(),
  deny_rules: z.array(matcher).optional(),
  allow_encoded_slash: z.boolean().optional(),
  credential_binding: z.strictObject({ provider: z.string().min(1) }).optional(),
  request_body_credential_rewrite: z.boolean().optional(),
  websocket_credential_rewrite: z.boolean().optional(),
  allow_uninspected_credentials: z.boolean().optional(),
  credential_signing: z.enum(["sigv4", "sigv4:body", "sigv4:no_body"]).optional(),
  signing_service: z.string().min(1).optional(),
  signing_region: z.string().min(1).optional(),
  persisted_queries: z.enum(["deny", "allow_registered"]).optional(),
  graphql_persisted_queries: z.record(z.string(), graphqlOperation).optional(),
  graphql_max_body_bytes: bodyBytes.optional(),
  mcp: z
    .strictObject({
      versions: z.array(z.enum(MCP_VERSIONS)).min(1, "mcp.versions must not be empty").optional(),
      max_body_bytes: bodyBytes.optional(),
      strict_tool_names: z.boolean().optional(),
      allow_all_known_mcp_methods: z.boolean().optional(),
    })
    .optional(),
  json_rpc: z.strictObject({ max_body_bytes: bodyBytes.optional() }).optional(),
});

/** An executable path or glob (schema.mdx:523-525). */
const binary = z.strictObject({ path: z.string().min(1) });

/** A named rule: every binary may reach every endpoint (schema.mdx:106-117). */
const networkRule = z.strictObject({
  name: z.string().optional(),
  endpoints: z.array(endpoint).optional(),
  binaries: z.array(binary).optional(),
});

/** schema.mdx:540-552. */
const middleware = z.strictObject({
  middleware: z.string().min(1),
  endpoints: z.strictObject({
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)).optional(),
  }),
  order: z.int().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  on_error: z.enum(["fail_closed", "fail_open"]).optional(),
  name: z.string().optional(),
});

/** The top-level fields (schema.mdx:26-33); `version` must be 1. */
const policyShape = z.strictObject({
  version: z.literal(1, { error: "version must be 1" }),
  filesystem_policy: filesystemPolicy.optional(),
  landlock: landlock.optional(),
  process: processPolicy.optional(),
  network_policies: z.record(z.string(), networkRule).optional(),
  network_middlewares: z.record(z.string(), middleware).optional(),
});

/** An OpenShell sandbox policy, as the documented YAML/JSON schema spells it. */
export type OpenShellPolicy = z.infer<typeof policyShape>;
/** One entry of `network_policies`. */
export type NetworkRule = z.infer<typeof networkRule>;
/** One endpoint of a network rule. */
export type Endpoint = z.infer<typeof endpoint>;
/** An L7 matcher (a deny rule, or the body of an allow rule). */
export type Matcher = z.infer<typeof matcher>;
/** `filesystem_policy`. */
export type FilesystemPolicy = z.infer<typeof filesystemPolicy>;
/** One entry of `network_middlewares`. */
export type Middleware = z.infer<typeof middleware>;

/** The whole mirror: shapes, then the documented cross-field rules. */
export const policySchema = policyShape.superRefine((policy, ctx) => {
  for (const message of policyProblems(policy)) ctx.addIssue({ code: "custom", message });
});

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");
}

/** Validates an already-parsed value (JSON from `policy get --output json`, or an object). */
export function parsePolicy(value: unknown): Result<OpenShellPolicy, string[]> {
  const parsed = policySchema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(
    parsed.error.issues.map((i) => `${issuePath(i.path).slice(1) || "policy"}: ${i.message}`),
  );
}

/**
 * Parses one YAML document and validates it. Bun's YAML parser keeps the last of two
 * duplicate keys, which OpenShell rejects; the emitter serializes an object, so it never
 * writes one.
 */
export function parsePolicyYaml(text: string): Result<OpenShellPolicy, string[]> {
  let value: unknown;
  try {
    value = Bun.YAML.parse(text);
  } catch (cause) {
    return err([`invalid YAML: ${(cause as Error).message}`]);
  }
  if (Array.isArray(value)) return err(["a policy file must hold exactly one YAML document"]);
  return parsePolicy(value);
}
