/**
 * Endpoint host patterns as OpenShell v0.1.2 defines them. Sources (the cloned repo at
 * `main` 7caff12): docs/how-it-works/policies/schema.mdx:133-135 (wildcard shapes) and
 * :573-592 (matcher semantics: `.` separator, case-insensitive, `*` inside one label,
 * `**` as a whole first label matching one label or more); the same shape check is
 * `host_wildcard_shape_invalid` in crates/openshell-policy/src/lib.rs:1686-1703.
 */

function labelsOf(host: string): string[] {
  return host.toLowerCase().split(".");
}

function globLabel(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]*");
  return new RegExp(`^${body}$`);
}

function labelMatches(pattern: string, label: string): boolean {
  return pattern.includes("*") ? globLabel(pattern).test(label) : pattern === label;
}

/** `pattern` labels (right-aligned) against `labels`: each pattern label matches its label. */
function suffixMatches(pattern: readonly string[], labels: readonly string[]): boolean {
  const n = Math.min(pattern.length, labels.length);
  for (let i = 1; i <= n; i++) {
    if (!labelMatches(pattern[pattern.length - i] ?? "", labels[labels.length - i] ?? "")) {
      return false;
    }
  }
  return true;
}

/** Why `host` is not a valid endpoint host, or null. */
export function hostPatternProblem(host: string): string | null {
  if (host === "") return "the host is empty";
  if (/[\s/]/.test(host)) return `host "${host}" contains whitespace or '/'`;
  if (!host.includes("*")) return null;
  const labels = host.split(".");
  if (labels.length < 3) return `wildcard host "${host}" must have at least three DNS labels`;
  const [first = "", ...later] = labels;
  if ((first.includes("**") && first !== "**") || later.some((l) => l.includes("**"))) {
    return `wildcard host "${host}": \`**\` is allowed only as the whole first label`;
  }
  if (later.some((l) => l.includes("*") && l !== "*")) {
    return `wildcard host "${host}": \`*\` must be the whole label in a later label`;
  }
  return null;
}

/** Whether the host `pattern` matches the concrete DNS `name`. */
export function hostMatches(pattern: string, name: string): boolean {
  const p = labelsOf(pattern);
  const n = labelsOf(name);
  if (p[0] === "**") {
    const rest = p.slice(1);
    return n.length > rest.length && suffixMatches(rest, n);
  }
  return p.length === n.length && suffixMatches(p, n);
}

/**
 * Whether `pattern` can match `domain` itself or any name under it: the T13 test for a
 * judge provider host (an endpoint for `eu.openrouter.ai` or `*.openrouter.ai` reaches
 * the provider as surely as `openrouter.ai`).
 */
export function coversDomain(pattern: string, domain: string): boolean {
  const p = labelsOf(pattern);
  const d = labelsOf(domain);
  if (p[0] === "**") return suffixMatches(p.slice(1), d);
  return p.length >= d.length && suffixMatches(p, d);
}

function labelsCompatible(a: string, b: string): boolean {
  if (a.includes("*") && b.includes("*")) return true;
  if (a.includes("*")) return labelMatches(a, b);
  if (b.includes("*")) return labelMatches(b, a);
  return a === b;
}

/**
 * Whether two host patterns can match the same name (schema.mdx:223-226: such endpoints
 * on one port must agree on `tls` and `allowed_ips`). Conservative for two wildcards.
 */
export function hostsOverlap(a: string, b: string): boolean {
  const x = labelsOf(a);
  const y = labelsOf(b);
  const xDeep = x[0] === "**";
  const yDeep = y[0] === "**";
  const xs = xDeep ? x.slice(1) : x;
  const ys = yDeep ? y.slice(1) : y;
  if (!xDeep && !yDeep && x.length !== y.length) return false;
  if (xDeep && !yDeep && y.length <= xs.length) return false;
  if (yDeep && !xDeep && x.length <= ys.length) return false;
  const n = Math.min(xs.length, ys.length);
  for (let i = 1; i <= n; i++) {
    if (!labelsCompatible(xs[xs.length - i] ?? "", ys[ys.length - i] ?? "")) return false;
  }
  return true;
}
