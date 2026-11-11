# erpnext-split

Turns CreditSeal ERPNext v16 bundles (`<borrower>.erpnext-data.json`) into one CSV per record type, so tab 03 can ask
questions across a borrower's books (dataset `smb-erp-fin` in `config/datasets.json`). Node built-ins only.

```
node tools/erpnext-split/split.ts --in sample-data/smb-2-erp-fin/erpnext/_source --out sample-data/smb-2-erp-fin/erpnext
```

| Flag | Default | What |
|---|---|---|
| `--in` | (required) | a folder of `*.erpnext-data.json` bundles, or one bundle |
| `--out` | (required) | writes `<out>/<borrower>/<doctype>.csv` |
| `--doctypes` | Customer, Supplier, Item, Sales Order, Sales Invoice, Purchase Invoice, Payment Entry, Bank Transaction | record types to write |
| `--borrowers` | every bundle under `--in` | e.g. `orion,mercury-textiles` |
| `--no-children` | off | skip child tables |
| `--include-drafts` | off | also write documents whose docstatus is not 1 (submitted) |
| `--force` | off | overwrite existing CSVs |
| `--dry-run` | off | print what would be written |

Child tables (items, taxes, references, credit limits) become their own files with ERPNext's link columns `parent`,
`parenttype`, `parentfield`, `idx`, as ERPNext stores them. Only fields present in the bundle are written: computed
fields (`grand_total`, `outstanding_amount`, `status`) are not in the bundle, so an invoice total is
`sum(sales-invoice-item.qty * rate) + sum(sales-taxes-and-charges.tax_amount where parenttype = 'Sales Invoice') - sales-invoice.discount_amount`.
Checked on the three bundles: that total equals every receipt's `allocated_amount` and the reference's `total_amount`.

Keep the source bundles in a folder starting with `_` (e.g. `erpnext/_source`): the console and the analyst hide `_*`.

Tests: `npm run test:erpnext-split` (`node --test tools/erpnext-split/test/*.test.ts`).
