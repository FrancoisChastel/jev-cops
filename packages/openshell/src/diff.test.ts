import { describe, expect, test } from "bun:test";
import { diffPolicies, renderDiff } from "./diff.ts";
import type { OpenShellPolicy } from "./schema.ts";

const BEFORE: OpenShellPolicy = {
  version: 1,
  filesystem_policy: { include_workdir: false, read_only: ["/usr", "/etc"], read_write: ["/tmp"] },
  landlock: { compatibility: "best_effort" },
  network_policies: {
    kept: { endpoints: [{ host: "a.example.com", port: 443 }] },
    changed: { endpoints: [{ host: "b.example.com", port: 443 }] },
    gone: { endpoints: [{ host: "c.example.com", port: 443 }] },
    _provider_x: { endpoints: [{ host: "api.anthropic.com", port: 443 }] },
  },
};

const AFTER: OpenShellPolicy = {
  version: 1,
  filesystem_policy: {
    include_workdir: false,
    read_only: ["/etc", "/usr", "/app"],
    read_write: [],
  },
  landlock: { compatibility: "hard_requirement" },
  network_policies: {
    kept: { endpoints: [{ port: 443, host: "a.example.com" }] },
    changed: { endpoints: [{ host: "b.example.com", port: 8443 }] },
    added: { endpoints: [{ host: "d.example.com", port: 443 }] },
  },
};

describe("diffPolicies", () => {
  test("rules added, removed, changed; provider rules ignored; order-insensitive", () => {
    const d = diffPolicies(BEFORE, AFTER);
    expect(d.rules).toEqual({ added: ["added"], removed: ["gone"], changed: ["changed"] });
    expect(d.readOnly).toEqual({ added: ["/app"], removed: [] });
    expect(d.readWrite).toEqual({ added: [], removed: ["/tmp"] });
    expect(d.sections).toEqual(["landlock"]);
    expect(d.changed).toBe(true);
  });

  test("identical policies: no change; against nothing: everything added", () => {
    expect(diffPolicies(AFTER, structuredClone(AFTER)).changed).toBe(false);
    const fresh = diffPolicies(null, AFTER);
    expect(fresh.rules.added).toEqual(["added", "changed", "kept"]);
    expect(fresh.readOnly.added).toEqual(["/app", "/etc", "/usr"]);
  });
});

describe("renderDiff", () => {
  test("one line per change, a note when filesystem changes need a new sandbox", () => {
    const text = renderDiff(diffPolicies(BEFORE, AFTER)).join("\n");
    expect(text).toContain("+ rule added");
    expect(text).toContain("- rule gone");
    expect(text).toContain("~ rule changed");
    expect(text).toContain("+ read_only /app");
    expect(text).toContain("- read_write /tmp");
    expect(text).toContain("~ landlock");
    expect(text).toContain("new sandbox");
    expect(renderDiff(diffPolicies(AFTER, AFTER))).toEqual(["no changes"]);
  });
});
