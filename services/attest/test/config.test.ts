/**
 * ARCH-409 / ARCH-410: ca-attest flags (no hardcoding: every URL, interval and switch is a flag with a default), the models
 * taken from the gateway's generated catalog, the POST /verify body rules, and the real process refusing to start without
 * its key or without the built official verifier. Node built-ins only.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { attestedModelsFromCatalog, parseCall, parseConfig } from "../src/main.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const KEY = "nearai-config-test-key-0123456789";
const ENV = { NEARAI_API_KEY: KEY };
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const HEX = "a".repeat(64);

describe("ARCH-409 flags", () => {
  it("ARCH-409: defaults follow the plan (port 8770, NEAR AI v1 root, ecdsa, refresh 900 s, retry 30 s, GPU check on)", () => {
    const c = parseConfig(["--models", MODEL], ENV);
    assert.deepEqual(
      [c.host, c.port, c.nearai.baseUrl, c.nearai.signingAlgo, c.refreshMs, c.signatureWindowMs, c.signatureIntervalMs, c.gpuRequired, c.historyKeep, c.maxCalls, c.verifierDir, c.verifierLog, c.allowedHosts],
      ["127.0.0.1", 8770, "https://cloud-api.near.ai/v1", "ecdsa", 900_000, 30_000, 2000, true, 8, 16, "/opt/nearai-cloud-verifier", false, null],
    );
    assert.deepEqual(c.models, [MODEL]);
    assert.equal(c.nearai.apiKey, KEY);
  });

  it("ARCH-409: every setting is a flag", () => {
    const c = parseConfig(["--models", `${MODEL},x/y`, "--port", "9999", "--nearai-base", "http://127.0.0.1:1/v1", "--report-refresh-sec", "60", "--signature-retry-sec", "5", "--signature-retry-ms", "250", "--gpu-check", "off", "--report-history", "3", "--max-calls", "4", "--verifier-dir", "/v", "--verifier-log", "on", "--key-env", "OTHER_KEY"], { OTHER_KEY: KEY });
    assert.deepEqual([c.models, c.port, c.nearai.baseUrl, c.refreshMs, c.signatureWindowMs, c.signatureIntervalMs, c.gpuRequired, c.historyKeep, c.maxCalls, c.verifierDir, c.verifierLog], [[MODEL, "x/y"], 9999, "http://127.0.0.1:1/v1", 60_000, 5000, 250, false, 3, 4, "/v", true]);
  });

  it("ARCH-409: start-up refuses bad values, naming the flag; the key value is never in a message", () => {
    const bad: [string[], NodeJS.ProcessEnv, RegExp][] = [
      [["--models", MODEL], {}, /NEARAI_API_KEY is not set/],
      [[], ENV, /give --models or --catalog/],
      [["--models", MODEL, "--signing-algo", "ed25519"], ENV, /--signing-algo must be ecdsa/],
      [["--models", MODEL, "--gpu-check", "yes"], ENV, /--gpu-check must be on or off/],
      [["--models", MODEL, "--host", "0.0.0.0"], ENV, /loopback/],
      [["--models", MODEL, "--allow-non-loopback", "--host", "attest"], ENV, /IP address/],
      [["--models", MODEL, "--allowed-hosts", "attest"], ENV, /host:port/],
      [["--models", MODEL, "--nearai-base", "ftp://x"], ENV, /--nearai-base/],
      [["--models", MODEL, "--report-refresh-sec", "5"], ENV, /--report-refresh-sec must be a whole number >= 30/],
      [["--models", MODEL, "--key-env", "sk-abc"], ENV, /variable NAME/],
      [["--models", "not a model"], ENV, /provider ids/],
    ];
    for (const [args, env, re] of bad) {
      assert.throws(() => parseConfig(args, env), (e: Error) => re.test(e.message) && !e.message.includes(KEY), String(re));
    }
  });
});

describe("ARCH-409 models from the gateway's catalog", () => {
  it("ARCH-409: --catalog takes the served ids of deployments with attest nearai, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "attest-cat-"));
    const path = join(dir, "catalog.local.json");
    writeFileSync(path, JSON.stringify({ models: [
      { id: "local/qwen2.5-3b", deployments: [{ servedModel: "qwen2.5:3b" }] },
      { id: "bedrock/x", deployments: [{ servedModel: "nvidia.x", apiKeyEnv: "BEDROCK_API_KEY" }] },
      { id: "nearai/deepseek-v4.1-flash", deployments: [{ servedModel: MODEL, attest: "nearai" }] },
    ] }));
    assert.deepEqual(attestedModelsFromCatalog(path), [MODEL]);
    assert.deepEqual(parseConfig(["--catalog", path], ENV).models, [MODEL]);
    writeFileSync(path, JSON.stringify({ models: [{ id: "local/q", deployments: [{ servedModel: "q" }] }] }));
    assert.throws(() => parseConfig(["--catalog", path], ENV), /no catalog deployment has attest nearai/);
  });

  it("ARCH-409: the shipped NEAR AI registry, generated, gives exactly the NEAR AI model", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const out = mkdtempSync(join(tmpdir(), "attest-gen-"));
    const r = spawnSync(process.execPath, ["scripts/local-models.ts", "--in", "config/local-models.cpu-all-nearai.json", "--out-dir", out, "--create-variants", "off", "--check-context", "off"], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(attestedModelsFromCatalog(join(out, "catalog.local.json")), [MODEL]);
  });
});

describe("ARCH-410 POST /verify body", () => {
  const ok = { chatId: "chatcmpl-1", servedModel: MODEL, requestSha256: HEX, responseSha256: HEX, calledAt: "2026-11-06T14:00:00.000Z" };
  it("ARCH-410: a well-formed call is accepted as given; no other field is kept", () => {
    assert.deepEqual(parseCall({ ...ok, question: "never kept" }, 0), ok);
    const { chatId: _c, ...noId } = ok;
    assert.deepEqual(parseCall(noId, 0), noId, "a call without a chat id is accepted and judged unverified later");
  });
  it("ARCH-410: each malformed field is refused with its name", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...ok, chatId: "has spaces" }, /chatId/],
      [{ ...ok, servedModel: "" }, /servedModel/],
      [{ ...ok, requestSha256: HEX.toUpperCase() }, /requestSha256/],
      [{ ...ok, responseSha256: "abc" }, /responseSha256/],
      [{ ...ok, calledAt: "yesterday" }, /calledAt/],
    ];
    for (const [c, re] of cases) assert.match(String(parseCall(c, 2)), re);
    assert.match(String(parseCall("x", 0)), /calls\[0\]: an object/);
  });
});

describe("ARCH-409 the real process", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, ...env } });
  it("ARCH-409: no key -> exit 2 naming the variable", () => {
    const r = run(["--models", MODEL], {});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /NEARAI_API_KEY is not set/);
  });
  it("ARCH-409: the official verifier not built -> exit 2 naming the missing file, the key never printed", () => {
    const r = run(["--models", MODEL, "--verifier-dir", mkdtempSync(join(tmpdir(), "no-verifier-"))], ENV);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the official verifier is not built: .*model_verifier\.js is missing/);
    assert.ok(!(r.stdout + r.stderr).includes(KEY));
  });
});
