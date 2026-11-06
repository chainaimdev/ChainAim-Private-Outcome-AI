/**
 * fanOutJoins per scope (2026-11-06): joining two aggregates on the column they were grouped by repeats no row, so it is not
 * flagged; a join of the raw tables, or through a WITH body / subquery that passes the rows through unchanged, still is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fanOutJoins, type RelationLike } from "../src/index.ts";

const terms: RelationLike[] = [{ a: { table: "ap_open_bills", column: "Terms" }, b: { table: "ar_open_invoices", column: "Terms" }, link: "category", cardinality: "many-to-many" }];
const receipts: RelationLike[] = [{ a: { table: "receipts", column: "Customer ID" }, b: { table: "sales_orders", column: "Customer ID" }, link: "category", cardinality: "many-to-many" }];

// The SQL the model wrote for smb-fin-1 "Receivables vs payables" (ui-smoke report 2026-11-06T17-53-01-174Z): correct, was warned.
const SMB = `WITH ar_agg AS (
    SELECT "Terms", SUM("Amount") AS total_amount, SUM("Open Balance") AS total_open_balance FROM "ar_open_invoices" GROUP BY "Terms"
), ap_agg AS (
    SELECT "Terms", SUM("Amount") AS total_amount, SUM("Open Balance") AS total_open_balance FROM "ap_open_bills" GROUP BY "Terms"
)
SELECT COALESCE(ar."Terms", ap."Terms") AS "Terms", COALESCE(ar.total_open_balance, 0) AS "AR", COALESCE(ap.total_open_balance, 0) AS "AP"
FROM ar_agg ar FULL OUTER JOIN ap_agg ap ON upper(trim(ar."Terms")) = upper(trim(ap."Terms")) ORDER BY "Terms"`;

test("aggregates joined on their grouping column: no warning (the smb Receivables vs payables query)", () => {
  assert.deepEqual(fanOutJoins(SMB, terms), []);
  assert.deepEqual(fanOutJoins(`SELECT * FROM (SELECT "Customer ID", sum("Amount") a FROM receipts GROUP BY 1) r
    JOIN (SELECT DISTINCT "Customer ID" FROM sales_orders) s ON r."Customer ID" = s."Customer ID"`, receipts), [], "grouped and DISTINCT subqueries");
});

test("still warned: raw tables, a pass-through WITH body, an ungrouped subquery, a fan-out inside a WITH body", () => {
  const hit = ['receipts."Customer ID" = sales_orders."Customer ID" is many-to-many: each row is repeated, so counts and sums are multiplied'];
  assert.deepEqual(fanOutJoins(`SELECT sum(r."Amount") FROM receipts r JOIN sales_orders s ON r."Customer ID" = s."Customer ID"`, receipts), hit);
  assert.deepEqual(fanOutJoins(`WITH r AS (SELECT * FROM receipts WHERE "Amount" > 0) SELECT sum(r."Amount") FROM r JOIN sales_orders s ON r."Customer ID" = s."Customer ID"`, receipts), hit, "WITH passes rows through");
  assert.deepEqual(fanOutJoins(`SELECT sum(x."Amount") FROM (SELECT * FROM receipts) x JOIN sales_orders s ON x."Customer ID" = s."Customer ID"`, receipts), hit, "subquery passes rows through");
  assert.deepEqual(fanOutJoins(`WITH t AS (SELECT r."Customer ID", sum(r."Amount") a FROM receipts r JOIN sales_orders s ON r."Customer ID" = s."Customer ID" GROUP BY 1) SELECT * FROM t`, receipts), hit,
    "the fan-out happens inside the WITH body, before its GROUP BY");
});

test("parentheses in strings and function calls do not open a scope", () => {
  assert.deepEqual(fanOutJoins(`SELECT sum(r."Amount") FROM receipts r JOIN sales_orders s ON r."Customer ID" = s."Customer ID" WHERE r."Memo" <> '(select x)'`, receipts).length, 1);
});
