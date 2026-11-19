# Persistence delivery and verification

Status: repository implementation for review, **not production-ready**. Legacy remains the default. No database SQL was executed. No production data or credentials were accessed, no environment variables were changed in Netlify, and no deployment, commit or push occurred. Dashboard templates, styles and metrics were not redesigned.

## Architecture and root problem

The growing JSON row couples every sale/payment/stock change to all history. CAS detects conflicting whole-document versions but cannot substitute for database stock/payment invariants. The new API sends one operation to one PostgreSQL transaction. Historical reads are paginated; dashboard queries aggregate on the database side. The existing Express cookie authentication, current-user role lookup and Netlify adapter remain in place.

See [audit, design and rollout](persistence-architecture.md). The final implementation deliberately takes the control row **FOR UPDATE before operation receipts**, serializing short commands. Product locks are also ordered by ID; transaction locks protect payments and corrections. This simplifies safe mode changes and prevents lock-upgrade deadlocks. It sacrifices parallel write throughput; measure contention before rollout. This is a conservative first implementation, not a claim of high-volume scalability.

## Tables and constraints

| Table (`cashier` private schema) | Important columns and invariants |
|---|---|
| products | text PK, name, NUMERIC stock/cost_price, track_stock, record data, timestamps; cost can be NULL for incomplete legacy records |
| customers, suppliers | preserved text PK, name, contact record data, timestamps |
| transactions | preserved text PK, unique invoice, business_date/occurred_at, cashier/customer snapshots, payment method, NUMERIC subtotal/discount/tax/total, revision, record data, timestamps |
| transaction_items | composite transaction/line PK, transaction FK, nullable product FK plus original product ID, historical name/unit/price/discount/cost/quantity/amount/profit snapshots |
| transaction_payments | composite transaction/payment PK, transaction FK, one initial-payment row per transaction, NUMERIC amount, date/method/cashier snapshots, original payment data |
| incoming_stock | preserved PK, nullable product FK, fractional quantity, purchase price, total, date/supplier; original cost and stock snapshots retained in record data |
| stocktakes | preserved PK, nullable product FK, system/physical stock, difference, date and original audit data |
| quantity_edits | operation PK, transaction FK, before/after quantities, actor/date audit |
| operations | globally unique operation ID, actor, kind, exact JSON request, committed response; no automatic expiration |
| control | mode, source hash/version, bounded configuration, revision and transactional invoice counter |

NUMERIC without a fixed scale retains historical decimal values without implicit currency rounding. New input rejects nonfinite, negative and malformed numbers. Positivity/nonnegative checks protect quantities, totals and payments. Historical stock may be negative and is preserved for review. Product/supplier/customer names in old records are not rewritten when master records change. Historical customer/supplier links are names only; no guessed foreign key is manufactured. Deleted product references become NULL while the original ID remains preserved and reported.

Indexes cover transaction date/order, payment method/date, unique invoice, customer, child product/transaction references, payment dates, incoming and stocktake dates. Substring search is bounded/paginated but currently uses a scan; add a measured search index if needed. All private tables enable RLS and revoke browser/PUBLIC privileges. RPCs use SECURITY INVOKER and empty search_path, with service-role-only execution. The legacy fence trigger alone is SECURITY DEFINER with an empty search_path and no dynamic SQL.

## HTTP API

| Method/path (under `/api`) | Purpose |
|---|---|
| GET persistence | Server mode |
| GET bootstrap | Configuration and small product/customer/supplier collections; no history |
| GET sync | Revision only |
| GET products, customers, suppliers | Collections; supplier access administrator-only |
| GET transactions | page/limit, invoice-or-customer search, date, paymentMethod; rows and total/page metadata |
| GET transactions/:id, transaction-by-invoice?invoice= | One complete receipt |
| GET incoming, stocktakes | Bounded pages, text/date filters and filtered aggregate summaries |
| GET dashboard?date= | Existing dashboard metrics, seven-day series, six recent receipts and six top products |
| POST transactions | Atomic sale, lines, initial payment, stock and invoice |
| POST transactions/:id/payments | Atomic remaining payment |
| PATCH transactions/:id/items | Administrator quantity deltas with expected transaction revision |
| POST incoming | Administrator receipt and weighted-average stock/cost update |
| POST stocktakes | Administrator audited correction with expected stock |
| POST products, customers, suppliers | Administrator record upsert with expected global revision |
| PUT configuration | Administrator small configuration update with expected revision |

Mutation limit is 64 KiB, at most 200 sale lines. Read pages cap at 100; UI requests 10 transactions and 20 incoming/stocktake rows. Catalogue collections fail visibly above 10,000 instead of silently truncating. Existing `STATE_JSON_LIMIT_KB` bounds are unchanged. HTTP metadata logging already records request bytes; tests reject history/state fields on normal sale requests. Cashiers cannot call administrative commands; cost/profit fields are removed recursively from cashier responses. Existing user/password APIs retain their role checks.

## Commands, stock, payments and invoices

The receipt insertion and all business changes commit or roll back together. The same operation ID must have the same actor, kind and body. A committed retry returns its stored response before any new stock/invoice action. A reused key with different input fails. The browser freezes the exact operation body and key while acknowledgement is uncertain; manual retry reuses both. No automatic unbounded command retry occurs. Confirmed persistence is required before success/form reset/navigation. Logout aborts requests and stale session results are ignored. Pending normalized commands persist before network access in localStorage with only actor ID, operation ID, path, method, exact body and timestamp. Same-actor normalized login recovers them automatically; another actor and read-only/legacy modes cannot replay them. Ambiguous failures and logout retain the record; acknowledgement or definitive rejection clears it. New submissions stop at 16 pending entries; storage failures block sending. No credentials or transaction history are stored. Browser-storage clearing remains an external recovery risk requiring receipt reconciliation.

Invoices continue the numeric sequence: migration seeds max historical 1?9 digit invoice, or -1 when none exists; allocation increments under the control lock and emits unprefixed digits, skipping exact historical collisions. Custom invoices and leading zeros are reported and preserved. Retries return the same receipt without allocating another number. UNIQUE(invoice) remains the final guard. Quantity edits aggregate per-product deltas (including repeated product lines), check stock, retain historical line prices/costs and existing payments, and keep the current refund-due message. Stale revisions fail rather than overwriting an intervening edit. Stocktake rejects a changed expected stock so it cannot silently overwrite a simultaneous sale.

Payments derive remaining/refund from the sum of initial retained payment plus settlements. Cash tender/change stay in the transaction snapshot. Overpayment and concurrent double settlement are rejected. A legacy-only `dashboard_amount` preserves the existing dashboard fallback when missing `cashIn` made dashboard cash differ from retained receipts; warnings expose this discrepancy. Missing dates, methods, costs and cashiers remain NULL/raw, not invented. Unknown costs prevent new sales until reviewed.

Normalized mode uses the existing 30-second fallback with a revision-only request. A changed revision reloads bounded visible history pages and catalogue/configuration, not all history. Legacy Realtime remains unchanged. Normalized Realtime publication is intentionally not enabled yet; targeted per-table event subscriptions can replace fallback after an authenticated signal design is reviewed. Hidden-tab, abort and session guards remain.

## Migration tools and exact later steps

All commands below are instructions for a **later authorized maintenance rehearsal/cutover**, not actions executed against production here.

1. Complete the blocked acceptance items below on a disposable database. Review SQL and rollback with an independent reviewer.
2. Stop business writes on all devices and all deployments. Resolve pending critical operations. Export the complete `app_state` row as JSON with `payload`, numeric `version`, and timestamps. Retain an immutable original and SHA-256; also back up users/schema/grants. Record row counts and invoice/financial/stock metrics.
3. Apply, in order, `server/normalized-schema.sql`, `server/normalized-reads.sql`, and reviewed `server/legacy-hardening.sql`. **NOT EXECUTED.** Schema files are one-time provisioning, not repeatable migration history files. Do not rerun them blindly. Keep app_state intact.
4. `node scripts/persistence-migrate.js dry-run backup.json` — offline validation and report; no network or credentials.
5. Resolve critical errors and review every warning. Missing dates/costs and historical arithmetic disagreements require explicit reconciliation decisions; do not fill them by guessing. Inspect migrationReview.dateReview for every timestamp whose Jakarta day differs from legacy slicing. Default historical policy is preserve-legacy. Opt into conversion only after review using --historical-dates=jakarta for both dry-run and prepare; explicit existing business dates are always retained. Review migrationReview.invoiceCounter/customInvoices. A restart with a different recorded migration decision fails.
6. `node scripts/persistence-migrate.js prepare backup.json migration-review` — creates a new directory containing bundle.json, import.sql and export.sql. Existing output directories are not overwritten. Report includes original-file SHA-256 plus canonical source hash, version, counts, money sums, stocks, unpaid count, latest chronological invoice and sample IDs.
7. Review generated SQL. Execute import.sql through an authorized database connection with `ON_ERROR_STOP=1` during the frozen window. It locks app_state against updates, verifies both exact payload and version, refuses another source or existing normalized operations, inserts without overwriting conflicts, verifies every imported row/count inside the transaction, and only then records source identity. Same-source restart is idempotent; divergent rows fail. It never deletes or rewrites app_state and never replays historical stock movements.
8. Execute export.sql read-only with headings disabled to save one JSON value as `actual.json`. `node scripts/persistence-migrate.js validate migration-review/bundle.json actual.json`. Decimal columns are exported as strings. All normalized business columns and preserved snapshots are compared, not merely totals. Any mismatch exits nonzero.
9. Use the owner-only `cashier.enter_normalized_read(sourceVersion, sourceHash)` procedure in a READ COMMITTED transaction with the validated import identity; see persistence-architecture.md. It rechecks the live source under the legacy-write table lock and refuses stale imports. Never use a direct mode UPDATE for this transition. Then set server `PERSISTENCE_MODE=normalized-read` through the separately authorized deployment process and reload every device. Both whole-state writes and normalized writes are blocked. SQL fence protects old clients/deployments.
10. Verify complete receipts, histories, filters, products, current dashboard metrics and all role views. A source version change or unreviewed warning blocks advancement.
11. Only after acceptance, change database mode to `normalized`, then server mode to `normalized`, reload sessions and exercise small controlled operations. Monitor latency, byte sizes, rejected requests, stock and payments. No production flag was changed in this task.
12. Before any normalized write, rollback may restore database/server legacy mode since app_state remains frozen. After normalized writes, freeze both writers, back up both stores and reconcile a reviewed reverse export before any rollback. **Switching flags alone after writes loses data.** No automatic reverse migration is provided; rehearse reconciliation/roll-forward before enabling writes.

## Tests and results

Executed successfully:

- `npm run check`: JavaScript syntax and existing frontend-secret/sync protections; expanded to all server/scripts JS.
- `npm test`: existing HTTP/security, Netlify adapter, 19 state-refresh tests, 46 critical-save/browser tests, existing business API tests, seven offline migration tests, normalized HTTP contract/authorization tests.
- `npm run build`: passed after retrying the local esbuild child-process launch outside the sandbox. First sandbox attempt failed with `spawn EPERM`. Build emitted the expected missing local Supabase URL/anon-key warning and used fallback; no credentials were fetched.
- `git diff --check`: passed.

**Not executed:** real PostgreSQL tests, schema/RPC compilation, database rollback/concurrency tests, actual-data migration comparison, visual browser acceptance, production rollback rehearsal. No PostgreSQL/psql/Docker/Supabase CLI executable was found locally. Node/HTTP tests use synthetic data and RPC stubs and do not prove database invariants.

`scripts/normalized-db-test.js` is the additional real-database suite. It requires `--confirm-disposable` and `LOCAL_PERSISTENCE_TEST_URL` targeting only localhost and a `cashier_test_*` database, rejects URL overrides, does not read app credentials, and requires empty preprovisioned tables. It never applies schema. Run it later against three separately provisioned disposable databases: once for command/atomicity/two-connection contention tests, once with `--migration-only` for import/restart/export/mismatch tests, and once with `--cutover-only` for guarded transition, source mismatch, overlapping legacy saves and stale-snapshot tests. Provision PostgreSQL roles equivalent to Supabase (`service_role` BYPASSRLS, anon, authenticated) and existing schema first in that isolated environment. Test fixtures remain for inspection. Do not point it at a tunnel or forwarded production connection.

## Payload estimates

Uncompressed JSON estimates, based on the reported ~1.6+ MB legacy document and synthetic requests; not production measurements. Response sizes vary with line count/snapshots.

| Action | Before | Normalized |
|---|---|---|
| Create transaction | ~1.6+ MB request | ~0.2–3 KB typical request; one receipt plus affected products response |
| History load | ~1.6+ MB full-state response | ~10–30 KB for 10 typical receipts, bounded page; no state download |
| Incoming | ~1.6+ MB request | ~0.15–0.5 KB request; record and one product response |
| Settlement | ~1.6+ MB request | ~0.08–0.3 KB request; one updated receipt response |

The synthetic API sale fixture is 108 bytes. The browser test asserts a one-line sale body below 1 KiB and no `/state` request. Bootstrap adds only small collections/configuration; exact production catalogue and worst-case receipt sizes must be measured later.

## Remaining cutover blockers

- Execute/review SQL and the real database suite; validate migration, concurrency and rollback, including killed connections and lock timeouts. The schema is unexecuted draft code.
- Complete browser acceptance for all normalized pages and overlapping query changes. No visual test was performed.
- Resolve historical missing fields/orphans and any precision discrepancies using a separately authorized export.
- Historical deletion, product/contact/reference deletion, full-history CSV export, whole-state backup/restore/reset are explicitly blocked in normalized mode. Reviewed archival/reversal and streaming export workflows are still needed for full administrative parity. Existing product stock edits must use audited stocktake. Print preferences in normalized mode are local to the current session; administrators can persist defaults via settings.
- Rehearse durable recovery and browser storage loss, catalogue pagination threshold, serialized-write throughput, Realtime signal design and custom invoice/date-policy review.
- Rehearse a reverse-export reconciliation or roll-forward procedure after normalized writes. An automatic post-write rollback is not implemented.

## Files

Added: `server/normalized-schema.sql`, `server/normalized-reads.sql`, `server/legacy-hardening.sql`, `server/normalized.js`; `scripts/persistence-migrate.js`, `scripts/business-date.js`, `scripts/persistence-fixture.js`, `scripts/persistence-migration-test.js`, `scripts/normalized-api-test.js`, `scripts/normalized-db-test.js`; this report and `docs/persistence-architecture.md`.

Changed: `server/app.js` (mode delivery, legacy fence, routes); `assets/js/app.js` (mode adapter, confirmed commands, bounded reads, dashboard data source); `scripts/critical-save-test.js`, `scripts/check.js`, `package.json`, `.env.example` (documents legacy default only). The existing schema, Netlify adapter, CSS and dashboard HTML files remain unchanged. No dependencies were added.

## Production review changes

See [revision findings, exact tests and remaining gates](persistence-review-revision.md). The read RPC now uses a stable statement snapshot and accepts expectedRevision; the client discards conflicted read sets, retries at most three times, and publishes state/metadata together. Every confirmed command reloads a bounded coherent view set, including history totals, incoming/stocktake summaries and both roles? dashboard. The transaction refresh button performs server reads. No full-state request is used.

New sale/initial-payment business dates and UI defaults are explicitly Asia/Jakarta. UTC absolute timestamps are retained. Client date strings are strict YYYY-MM-DD at the database boundary. SQL object/array checks use IS DISTINCT FROM; required identifiers, configuration entries and actual JSON booleans are validated before writes. Normal input/constraint errors map to 400/409. KASIR dashboard uses full database aggregates with cost/profit fields stripped in SQL and Express, and the profit chart/legend are permission-gated. Dashboard styles and layout are unchanged.

The latest safety review and retained cashier pricing decision are recorded in [persistence-second-review.md](persistence-second-review.md).
