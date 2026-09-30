import { describe, expect, test } from "bun:test";
import { coversDomain, hostMatches, hostPatternProblem, hostsOverlap } from "./hosts.ts";

describe("hostPatternProblem (schema.mdx:133-135)", () => {
  test("exact hosts and valid wildcards pass", () => {
    for (const ok of ["api.github.com", "10.0.0.1", "*.example.com", "*-api.example.com"]) {
      expect(hostPatternProblem(ok)).toBeNull();
    }
    expect(hostPatternProblem("api.*.example.com")).toBeNull();
    expect(hostPatternProblem("**.example.com")).toBeNull();
  });

  test("a wildcard needs at least three labels", () => {
    expect(hostPatternProblem("*.com")).toContain("three DNS labels");
    expect(hostPatternProblem("**.com")).toContain("three DNS labels");
    expect(hostPatternProblem("*")).toContain("three DNS labels");
  });

  test("** only as the whole first label, * whole in later labels", () => {
    expect(hostPatternProblem("a**.example.com")).toContain("**");
    expect(hostPatternProblem("api.**.example.com")).toContain("**");
    expect(hostPatternProblem("api.x*.example.com")).toContain("later label");
  });

  test("empty, whitespace and slashes are rejected", () => {
    expect(hostPatternProblem("")).not.toBeNull();
    expect(hostPatternProblem("a b.com")).not.toBeNull();
    expect(hostPatternProblem("a.com/x")).not.toBeNull();
  });
});

describe("hostMatches (schema.mdx:573-592)", () => {
  test("exact names match case-insensitively", () => {
    expect(hostMatches("API.github.com", "api.GitHub.com")).toBe(true);
    expect(hostMatches("api.github.com", "github.com")).toBe(false);
  });

  test("* stays inside one label", () => {
    expect(hostMatches("*.example.com", "a.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "a.b.example.com")).toBe(false);
    expect(hostMatches("*-api.example.com", "eu-api.example.com")).toBe(true);
    expect(hostMatches("api.*.example.com", "api.eu.example.com")).toBe(true);
  });

  test("** as the first label needs at least one label", () => {
    expect(hostMatches("**.example.com", "a.b.example.com")).toBe(true);
    expect(hostMatches("**.example.com", "example.com")).toBe(false);
  });
});

describe("coversDomain", () => {
  test("a pattern that can reach the domain or a subdomain covers it", () => {
    expect(coversDomain("openrouter.ai", "openrouter.ai")).toBe(true);
    expect(coversDomain("eu.openrouter.ai", "openrouter.ai")).toBe(true);
    expect(coversDomain("*.openrouter.ai", "openrouter.ai")).toBe(true);
    expect(coversDomain("**.openrouter.ai", "openrouter.ai")).toBe(true);
    expect(coversDomain("api.*.ai", "openrouter.ai")).toBe(true);
    expect(coversDomain("**.ai.example", "openrouter.ai")).toBe(false);
    expect(coversDomain("notopenrouter.ai", "openrouter.ai")).toBe(false);
    expect(coversDomain("registry.npmjs.org", "openrouter.ai")).toBe(false);
    expect(coversDomain("*.typesafe.ai", "api.typesafe.ai")).toBe(true);
  });
});

describe("hostsOverlap", () => {
  test("exact, wildcard and double wildcard", () => {
    expect(hostsOverlap("a.example.com", "A.example.com")).toBe(true);
    expect(hostsOverlap("a.example.com", "b.example.com")).toBe(false);
    expect(hostsOverlap("*.example.com", "a.example.com")).toBe(true);
    expect(hostsOverlap("a.example.com", "*.example.com")).toBe(true);
    expect(hostsOverlap("*.example.com", "**.example.com")).toBe(true);
    expect(hostsOverlap("*.example.com", "*.other.org")).toBe(false);
  });
});
