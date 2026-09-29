import { readFileSync } from "node:fs";

/** Names of the canonical `jevdict.event/1` fixtures shared across packages. */
export const EVENT_FIXTURES = ["pre-bash", "post-bash", "pre-edit", "pre-webfetch"] as const;

export type EventFixtureName = (typeof EVENT_FIXTURES)[number];

/**
 * Loads a fixture as raw, unvalidated JSON. Each call returns a fresh object, so a
 * test that derives a variant from it can never leak into another test.
 */
export function loadEventFixture(name: EventFixtureName): unknown {
  const url = new URL(`./${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}
