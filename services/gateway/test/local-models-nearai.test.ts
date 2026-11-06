/**
 * PLAN-private-ai-nearai-attestation.md ARCH-402 / ARCH-403 (owner choice (a), 2026-11-06): the NEAR AI model lives in its
 * own registry (config/local-models.cpu-all-nearai.json) and mode (test-console/modes/ollama-cpu-8gb-all-nearai.json);
 * config/local-models.cpu-all.json and the ollama-cpu-8gb-all mode are unchanged and need no NEAR AI key. Runs the real
 * generator (scripts/local-models.ts) with Ollama checks off, as local-models-hosted.test.ts does.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateCatalog } from "../src/catalog.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (...p: string[]) => JSON.parse(readFileSync(join(ROOT, ...p), "utf8"));
const generate = (registry: unknown, extra: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), "chainaim-lm-nearai-"));
  const reg = join(dir, "registry.json");
  writeFileSync(reg, JSON.stringify(registry));
  const out = join(dir, "out");
  execFileSync(process.execPath, ["scripts/local-models.ts", "--in", reg, "--out-dir", out, "--create-variants", "off", "--check-context", "off", ...extra], { cwd: ROOT, stdio: "pipe" });
  return { catalog: JSON.parse(readFileSync(join(out, "catalog.local.json"), "utf8")), summary: JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) };
};
const ID = "nearai/deepseek-v4.1-flash";

describe("ARCH-402 the NEAR AI registry entry", () => {
  it("ARCH-402: the generated catalog serves NEAR AI's TEE model id at cloud-api.near.ai, zone private-cloud, priced 0.30 / 1.20, key by NAME", () => {
    const { catalog, summary } = generate(read("config", "local-models.cpu-all-nearai.json"));
    const v = validateCatalog(catalog);
    const m = v.models.find((x) => x.id === ID)!;
    assert.ok(m, "the entry is in the catalog");
    assert.equal(m.zone, "private-cloud", "so --auto-zones local / --phi-zones local keep chainaim/auto and health data off it");
    assert.deepEqual(m.pricing, { inputPerM: 0.3, outputPerM: 1.2 });
    assert.equal(m.capabilities.contextWindow, 1048576);
    assert.equal(m.capabilities.supportsTools, true);
    const d = m.deployments[0];
    assert.deepEqual([d.baseUrl, d.servedModel, d.apiKeyEnv], ["https://cloud-api.near.ai/v1", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "NEARAI_API_KEY"]);
    assert.equal(d.servedModel.startsWith("deepseek/"), false, "never the OpenRouter look-alike (verifiable false)");
    assert.equal(summary.maxOutputTokens, 2048, "the shared output budget is unchanged until V1 measures the reasoning budget (ARCH-405)");
    assert.equal(summary.defaultModel, "local/qwen2.5-3b", "the default stays local");
  });

  it("ARCH-401: every other entry, the defaults and the default model are exactly those of local-models.cpu-all.json", () => {
    const base = read("config", "local-models.cpu-all.json");
    const nearai = read("config", "local-models.cpu-all-nearai.json");
    assert.deepEqual(nearai.models.slice(0, -1), base.models);
    assert.deepEqual([nearai.defaults, nearai.defaultModel, nearai.ollamaUrl], [base.defaults, base.defaultModel, base.ollamaUrl]);
    assert.equal(base.models.some((m: { id: string }) => m.id === ID), false, "the all-in-one registry has no NEAR AI entry");
  });
});

describe("ARCH-407 attest pass-through", () => {
  it("ARCH-407: the NEAR AI deployment carries attest nearai; no other deployment carries attest", () => {
    const { catalog } = generate(read("config", "local-models.cpu-all-nearai.json"));
    const v = validateCatalog(catalog);
    for (const m of v.models) assert.equal(m.deployments[0].attest, m.id === ID ? "nearai" : undefined, m.id);
  });

  it("ARCH-407: an unknown attest value, or attest on an Ollama entry, is refused", () => {
    const reg = read("config", "local-models.cpu-all-nearai.json");
    const nearai = reg.models.at(-1);
    assert.throws(() => generate({ ...reg, models: [...reg.models.slice(0, -1), { ...nearai, attest: "phala" }] }), /attest must be one of nearai/);
    const i = reg.models.findIndex((m: { baseUrl?: string }) => m.baseUrl === undefined);
    assert.ok(i >= 0, "the registry has an Ollama entry");
    const models = reg.models.map((m: Record<string, unknown>, j: number) => (j === i ? { ...m, attest: "nearai" } : m));
    assert.throws(() => generate({ ...reg, models }), /attest needs baseUrl/);
  });
});

describe("ARCH-403 key plumbing", () => {
  it("ARCH-403: the -nearai mode requires NEARAI_API_KEY; ollama-cpu-8gb-all still requires only OpenRouter and Bedrock", () => {
    const mode = read("test-console", "modes", "ollama-cpu-8gb-all-nearai.json");
    const old = read("test-console", "modes", "ollama-cpu-8gb-all.json");
    assert.equal(mode.localModels, "config/local-models.cpu-all-nearai.json");
    assert.deepEqual(mode.secretEnv, ["OPENROUTER_API_KEY", "BEDROCK_API_KEY", "NEARAI_API_KEY"]);
    assert.deepEqual(old.secretEnv, ["OPENROUTER_API_KEY", "BEDROCK_API_KEY"]);
    assert.deepEqual([mode.flags, mode.modelSource, mode.mountConfig, mode.staticEnv], [old.flags, old.modelSource, old.mountConfig, old.staticEnv]);
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    assert.match(compose, /^\s+- NEARAI_API_KEY$/m, "compose passes it to the gateway by name");
    const files = JSON.stringify(read("config", "local-models.cpu-all-nearai.json")) + JSON.stringify(mode) + compose;
    assert.equal(/NEARAI_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}/.test(files), false, "no key value in any of these files");
  });

  it("ARCH-403 (owner option 2, 2026-11-06): ollama-cpu-8gb-all asks for NEARAI_API_KEY as optional; skipping it leaves exactly the five models of local-models.cpu-all.json", () => {
    const all = read("test-console", "modes", "ollama-cpu-8gb-all.json");
    assert.equal(all.localModels, "config/local-models.cpu-all-nearai.json");
    assert.deepEqual(all.optionalSecretEnv, ["NEARAI_API_KEY"]);
    const withKey = generate(read("config", "local-models.cpu-all-nearai.json"));
    assert.ok(withKey.catalog.models.some((m: { id: string }) => m.id === ID), "key given: the NEAR AI model is in");
    const skipped = generate(read("config", "local-models.cpu-all-nearai.json"), ["--skip-key-env", "NEARAI_API_KEY"]);
    const base = generate(read("config", "local-models.cpu-all.json"));
    const strip = (c: { models: unknown[] }) => c.models;
    assert.deepEqual(strip(skipped.catalog), strip(base.catalog), "key skipped: the same models as the old registry");
    assert.deepEqual([skipped.summary.maxOutputTokens, skipped.summary.defaultModel], [base.summary.maxOutputTokens, base.summary.defaultModel]);
  });
});
