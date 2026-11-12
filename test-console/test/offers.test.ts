/**
 * privateAI-design-34 ARCH-636 / ARCH-638 (test-console/console/offers.ts): the offer settings (estimate-first is the
 * default and needs the calibrated cost model), sizing a folder without opening a file, the crossask basis, the run-time
 * size check and the offer store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crossaskBasis, folderSize, OfferStore, offerConfig, withinBasis, type HeldOffer } from "../console/offers.ts";

const CM = readFileSync(fileURLToPath(new URL("../../config/cost-model.json", import.meta.url)), "utf8");
const read = (files: Record<string, string>) => (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; };

test("ARCH-636: estimate-first is the default and needs config/cost-model.json; run-hold alone does not; nothing without paid jobs", () => {
  const c = offerConfig({}, true, read({ "config/cost-model.json": CM }))!;
  assert.deepEqual([c.mode, c.modes, c.maxTokens, c.tolerancePct], ["estimate-first", ["estimate-first", "run-hold"], 2048, 10]);
  assert.equal(c.costModel?.machine, "CHAINAIMMAIN", "the committed calibration");
  assert.throws(() => offerConfig({}, true, read({})), /estimate-first offers need the cost model config\/cost-model\.json: run \.\\test-console\\desk\.ps1 -Calibrate/);
  assert.throws(() => offerConfig({}, true, read({ "config/cost-model.json": "{}" })), /is not valid \(cost model version must be 1\)/);
  const hold = offerConfig({ "offer-mode": "run-hold", "offer-modes": "run-hold" }, true, read({}))!;
  assert.deepEqual([hold.mode, hold.modes, hold.costModel], ["run-hold", ["run-hold"], undefined]);
  assert.equal(offerConfig({}, false, read({})), undefined);
  assert.throws(() => offerConfig({ "offer-mode": "estimate-first" }, false, read({})), /need --paid-jobs on/);
  assert.throws(() => offerConfig({ "offer-mode": "later" }, true, read({ "config/cost-model.json": CM })), /--offer-mode must be one of estimate-first, run-hold/);
  assert.throws(() => offerConfig({ "offer-mode": "estimate-first", "offer-modes": "run-hold" }, true, read({})), /must be one of --offer-modes \(run-hold\)/);
  assert.throws(() => offerConfig({ "offer-modes": "estimate-first,maybe" }, true, read({ "config/cost-model.json": CM })), /--offer-modes must list/);
  assert.throws(() => offerConfig({ "offer-max-tokens": "8" }, true, read({ "config/cost-model.json": CM })), /--offer-max-tokens must be a whole number from 16/);
  assert.equal(offerConfig({ "cost-model": "elsewhere.json" }, true, read({ "elsewhere.json": CM }))?.costModel?.version, 1);
});

test("ARCH-636: a folder is sized by stat only (an unreadable file still counts); only usable data files, at most maxFiles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "offer-size-"));
  try {
    writeFileSync(join(dir, "a.csv"), "x".repeat(100));
    writeFileSync(join(dir, "b.csv"), "y".repeat(50));
    writeFileSync(join(dir, "c.pdf"), "z".repeat(999));
    mkdirSync(join(dir, "_answer-key"));
    writeFileSync(join(dir, "_answer-key", "k.csv"), "secret");
    chmodSync(join(dir, "b.csv"), 0o000);
    const usable = (n: string) => n.endsWith(".csv");
    assert.deepEqual(await folderSize(dir, usable, 20), { files: 2, totalBytes: 150 }, "b.csv is not readable, yet sized: nothing is opened");
    assert.deepEqual(await folderSize(dir, usable, 1), { files: 1, totalBytes: 100 });
  } finally { chmodSync(join(dir, "b.csv"), 0o644); rmSync(dir, { recursive: true, force: true }); }
});

test("ARCH-636 ARCH-638: the crossask basis is checked by packages/offer; the run-time size check allows the tolerance, never more files", () => {
  const limits = { maxPromptChars: 40000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 };
  const b = crossaskBasis({ folder: "/d", question: "q", model: "nearai/m", phrase: "llm", sql: "SELECT 1" }, { files: 3, totalBytes: 1000 }, limits);
  assert.deepEqual(b, { kind: "crossask", model: "nearai/m", phrase: "llm", userSql: true, totalBytes: 1000, files: 3, ...limits });
  assert.throws(() => crossaskBasis({ folder: "/d", question: "q", model: "bad", phrase: "llm" }, { files: 1, totalBytes: 1 }, limits), /model must look like provider\/name/);
  assert.equal(withinBasis(b, { files: 3, totalBytes: 1100 }, 10), null, "+10 % allowed");
  assert.equal(withinBasis(b, { files: 2, totalBytes: 10 }, 10), null, "smaller is fine: the price is a ceiling");
  assert.match(withinBasis(b, { files: 3, totalBytes: 1101 }, 10)!, /holds 1101 bytes now, more than the 1000 estimated \(\+10 %\): estimate it again/);
  assert.match(withinBasis(b, { files: 4, totalBytes: 10 }, 10)!, /has 4 data files now, 3 when it was estimated/);
});

test("ARCH-636: the offer store holds until expiry (reported once), and a run drops it", () => {
  let t = 1_000;
  const expired: string[] = [];
  const s = new OfferStore(2, () => t, (o) => expired.push(o.offerId));
  const o = (id: string, expiresAt: number) => ({ offerId: id, expiresAt } as unknown as HeldOffer);
  s.hold(o("a", 2_000)); s.hold(o("b", 5_000));
  assert.equal(s.full(), true);
  assert.equal(s.get("a")?.offerId, "a");
  t = 2_000;
  assert.equal(s.get("a"), undefined);
  assert.deepEqual(expired, ["a"]);
  assert.equal(s.drop("b"), true);
  assert.equal(s.size(), 0);
  assert.deepEqual(expired, ["a"], "a dropped offer is not reported as expired");
});

test("ARCH-636: attested before the run only when every model the job calls is attestable (exact SQL + NEAR AI answer: owner run 2026-11-12, t02 refused)", async () => {
  const { attestedRoute, offerModels } = await import("../console/offers.ts");
  const limits = { maxPromptChars: 40000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 };
  const NEAR = "nearai/deepseek-v4.1-flash", BED = "bedrock/nemotron-nano-3-30b";
  const att = new Set([NEAR]);
  const exactSql = crossaskBasis({ folder: "/d", question: "q", model: BED, answerModel: NEAR, phrase: "llm", sql: "SELECT 1" }, { files: 1, totalBytes: 1 }, limits);
  assert.deepEqual(offerModels(exactSql), [NEAR], "no query model with the template's own SQL");
  assert.equal(attestedRoute(exactSql, att), true);
  const free = crossaskBasis({ folder: "/d", question: "q", model: BED, answerModel: NEAR, phrase: "llm" }, { files: 1, totalBytes: 1 }, limits);
  assert.deepEqual(offerModels(free), [BED, BED, NEAR]);
  assert.equal(attestedRoute(free, att), false, "a Bedrock query call is not attested");
  assert.equal(attestedRoute(crossaskBasis({ folder: "/d", question: "q", model: NEAR, phrase: "llm" }, { files: 1, totalBytes: 1 }, limits), att), true);
  assert.equal(attestedRoute(crossaskBasis({ folder: "/d", question: "q", model: NEAR, phrase: "none", sql: "SELECT 1" }, { files: 1, totalBytes: 1 }, limits), att), false, "no model call: nothing attested");
});

test("ARCH-636: attestableModels reads the catalog: a model is attestable only when every deployment says attest", async () => {
  const { attestableModels } = await import("../console/jobs.ts");
  const cat = { models: [
    { id: "nearai/a", deployments: [{ id: "a@1", attest: "nearai" }] },
    { id: "mixed/b", deployments: [{ id: "b@1", attest: "nearai" }, { id: "b@2" }] },
    { id: "bedrock/c", deployments: [{ id: "c@1" }] },
    { id: "none/d", deployments: [] },
  ] };
  assert.deepEqual([...attestableModels(cat)], ["nearai/a"]);
  assert.equal(attestableModels(null).size, 0);
});
