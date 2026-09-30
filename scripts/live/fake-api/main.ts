#!/usr/bin/env bun
/**
 * Starts the fake model API from the environment (the `jev-cops-live-fake-api` container):
 * `FAKE_API_SCRIPT` (required), `FAKE_API_LOG_DIR`, `FAKE_API_BODIES=1`,
 * `FAKE_API_EXPECTED_KEY`, `FAKE_API_HOST` (default 0.0.0.0), `FAKE_API_PORT` (default 8080).
 * Prints the port it listens on.
 */
import { createFakeApi, optionsFromEnv } from "./server.ts";

const api = createFakeApi(optionsFromEnv(process.env));
const server = Bun.serve({
  hostname: process.env.FAKE_API_HOST ?? "0.0.0.0",
  port: Number(process.env.FAKE_API_PORT ?? 8080),
  idleTimeout: 120,
  fetch: (req) => api.fetch(req),
});
console.log(`fake-api listening on ${server.hostname}:${server.port}`);
