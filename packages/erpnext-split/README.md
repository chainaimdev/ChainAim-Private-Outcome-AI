# @chainaim/erpnext-split

The rules that turn an ERPNext bundle (`<borrower>.erpnext-data.json`: one JSON object with a `documents` list of
Frappe doc dicts) into one table per record type, shared by:

- `tools/erpnext-split/split.ts`: the command line that writes those tables as CSV files;
- `services/analyst`: `src/erpnext-bundle.ts` takes `DEFAULT_DOCTYPES` from here, and `test/erpnext-bundle.test.ts`
  checks that DuckDB reading the bundle directly gives exactly the tables these rules give.

Kept in `packages/` because a service may not import a tool (`config/deps/rules.json`, `scripts/check-deps.ts`).

Exports: `BUNDLE_SUFFIX`, `DEFAULT_DOCTYPES`, `Doc`, `SplitOptions`, `Table`, `fileFor`, `csvField`, `toCsv`,
`splitDocuments`. Pure functions, no file access; reading bundles from disk stays in the tool (`readBundle`, `findBundles`).
