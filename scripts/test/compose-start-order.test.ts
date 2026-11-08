/**
 * docker-compose.yml start order (owner run 2026-11-07): the gateway gave up after its 120 s Presidio wait while Presidio's
 * gunicorn worker was still loading its models, and stayed down (paywall, model lists and the 8730 page with it). Read as
 * text (no Docker needed): Presidio has a health check on its own /health, and the gateway starts only once it is healthy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
const block = (name: string): string => {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `service ${name}`);
  const next = yml.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
};

test("Presidio has a health check on its own /health (port 3000), with time for its models to load", () => {
  const p = block("presidio");
  assert.match(p, /healthcheck:/);
  assert.match(p, /http:\/\/127\.0\.0\.1:3000\/health/);
  assert.match(p, /start_period: \d+s/);
  assert.match(p, /retries: \d+/);
});

test("the gateway starts only once Presidio is healthy, and restarts if its own Presidio wait still times out", () => {
  const g = block("gateway");
  assert.match(g, /depends_on:\s*\n\s+presidio: \{ condition: service_healthy \}/);
  assert.match(g, /restart: on-failure:\d+/);
  assert.ok(!/depends_on: \[presidio\]/.test(g), "not the old start-only dependency");
});
