/**
 * finance-generic: the analyst's default domain pack, i.e. its behaviour before packs existed (decoupling Phase 3).
 * Every value below was moved unchanged from services/analyst/src/profile.ts (KINDS, NAME_HINTS, KIND_HINTS, FLOW_ORDER,
 * DEFAULT_MEASURE, the party priority in proposeFile, the "adjustments" flow exclusion and the "other" fallback), so a recipe
 * with no pack behaves exactly as before. Child packs (finance/rcm, finance/rcm/dental) extend it explicitly.
 */
import type { DomainPack } from "../../core/ports.ts";

export const FINANCE_GENERIC: DomainPack = {
  id: "finance-generic",
  title: "Finance (generic): production, billing, income, collections, deposits, ledger, tax",
  kinds: ["production", "billing", "income", "collections", "deposits", "ledger", "tax", "adjustments", "other"],
  nameHints: [
  ["date", /date|posted|dos\b|day|time|period/i],
  ["debit", /debit|withdraw|money ?out|\bdr\b/i],
  ["credit", /credit|money ?in|\bcr\b/i],
  ["amount", /amount|amt|total|paid|payment|charge|fee|deposit|value|balance|net|gross|price|sum/i],
  ["reference", /ref|check|cheque|claim|invoice|inv\b|txn|transaction ?id|\bid\b|number|no\b|#|confirmation|batch/i],
  ["party", /payer|patient|vendor|customer|client|name|payee|merchant|counterparty|description|memo|narration|details/i],
  ["category", /category|type|code|class|cpt|method|account|gl|department|service/i],
],
  kindHints: [
  ["production", /prod|charge|service|encounter|visit/i],
  ["billing", /bill|claim|invoice(?!.*paid)/i],
  ["collections", /collect|payment|receipt|remit|era|paid/i],
  ["deposits", /bank|deposit|statement|stmt/i],
  ["ledger", /erp|ledger|\bgl\b|journal|quickbooks|qbo|xero|books/i],
  ["adjustments", /adjust|write.?off|refund|void/i],
  ["tax", /tax|1040|1120|return|itr/i],
  ["income", /income|revenue|sales|p&l|pnl|profit/i],
],
  partyPriority: [/payer|insur|plan|customer|client|vendor|supplier|merchant|counterparty|payee/i, /patient|member|name/i, /description|memo|narration|details|particulars/i],
  flowOrder: ["production", "billing", "income", "collections", "deposits", "ledger", "tax"],
  excludeFromFlow: ["adjustments"],
  defaultMeasure: { production: "abs", billing: "abs", income: "abs", collections: "abs", deposits: "inflows", ledger: "net", tax: "abs", adjustments: "abs", other: "net" },
  fallbackKind: "other",
};
