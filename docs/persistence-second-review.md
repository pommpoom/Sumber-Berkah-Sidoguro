# Second persistence safety review

## Changes and retained business policy

The user explicitly chose **Retain the current permissions**. KASIR remains allowed to override the autofilled retail/wholesale price, apply arbitrary per-unit discounts from zero through the unit price, apply order discounts up to the full subtotal, sell below product cost, and enter zero-price sale lines. No administrator approval, price-list equality rule or cost floor has been introduced. These permissions apply to sales; they do not grant KASIR product-master administration.

Evidence: cashier price and discount fields are editable; addCartItem validates quantity, stock and per-unit discount bounds, without checking price against product cost or the price list. Order calculation clamps nominal discounts to subtotal and percentage discounts to 100%. Normalized commands retain those rules with server-derived totals, stock and cost. The legacy KASIR merge now rejects negative/nonfinite prices and discounts and discounts exceeding price, consistent with valid UI inputs. Missing price/discount defaults remain zero. New legacy tests verify zero, below-cost, full-discount and override acceptance, and reject invalid inputs without changing version or stock. Historical records are not rewritten.

Risks deliberately retained: a cashier can give goods away or produce negative margins; KASIR cannot see the hidden costs and therefore cannot assess margin. Legacy whole-state persistence still trusts some client-derived order totals and administrative payloads; this revision does not expand into a legacy accounting rewrite. These are not new normalized pricing restrictions or unresolved policy questions; the user confirmed retention.

## Cutover

`cashier.enter_normalized_read(sourceVersion, sourceHash)` is an owner/operator-only transition. At READ COMMITTED it locks app_state before control, verifies imported identity and current source version, and activates the legacy fence in the same transaction. In-flight legacy saves either commit first (forcing a source-mismatch rejection), or wait behind transition and are refused after commit. The trigger locks control when checking the fence, so stale transaction snapshots cannot bypass it. app_state is preserved, and normalized writes remain disabled. The service role cannot execute the transition or update mode.

The architecture document was rewritten to remove duplicated/truncated invoice text and correct counter lock ordering. Both rollout documents now require the guarded procedure. Manual client shutdown is operational preparation, not the concurrency safeguard.

## Exact printing and recovery

Printing no longer falls back to the first history row. Normalized preview and all three physical print layouts retrieve the selected invoice through its exact endpoint, verify response identity, and block on failure. Session/selection guards reject out-of-order lookup results and cancel printing if selection changes during lookup or frame loading. Pagination and refresh cannot substitute a different customer's invoice.

Pending recovery filters storage keys by the encoded current actor before parsing. Another actor's malformed record is neither parsed, replayed nor deleted. Tests recover and clear a valid current-user command while retaining the malformed foreign record.

## Validation and remaining gates

- `npm run check`: passed, including syntax checks for the authored PostgreSQL test runner.
- `npm test`: passed. Node test suites contain 19 state-refresh tests, 57 critical-save/browser tests and 7 migration tests, plus HTTP security, Netlify, business API and normalized API contract suites. API/database calls in these suites are stubbed; browser tests use a VM DOM fixture.
- `npm run build`: passed. Missing Supabase browser configuration produced the expected polling-fallback warning. Generated dist passed sensitive-file checks.
- `git diff --check`: passed.

Real PostgreSQL tests are authored but **not executed**. No local psql/PostgreSQL/Docker runtime was available, and no schema or SQL was applied. A separately authorized operator must provision three empty disposable localhost databases, with the reviewed schema, reads, hardening and Supabase-equivalent roles. Set LOCAL_PERSISTENCE_TEST_URL to a direct localhost cashier_test_* database, never a production tunnel. Run separately:

```text
node scripts/normalized-db-test.js --confirm-disposable
node scripts/normalized-db-test.js --confirm-disposable --migration-only
node scripts/normalized-db-test.js --confirm-disposable --cutover-only
```

The cutover suite covers imported-version/hash mismatch, unsupported isolation, an in-flight save before transition, a save queued during transition, writes after transition, a stale REPEATABLE READ snapshot, unchanged-source success, unchanged app_state, idempotent read-only transition and denied application-role mode changes. The other suites cover real command atomicity, financial/stock behavior, price permissions, concurrent sales/payments/invoices and migration reconciliation. Independent SQL review, actual PostgreSQL execution and interactive browser/printer acceptance remain release gates.

Legacy remains the default with its existing persistence path and cashier permissions. The targeted invalid-price validation and missing-invoice safety fixes are intentional changes; it would be inaccurate to describe every legacy error path as byte-for-byte unchanged. Normalized mode blocks full-state writes in both browser and server. No production Supabase access, SQL application, deployment, commit or push occurred. Existing uncommitted work is retained. This is not a production-readiness claim.

## PostgreSQL 14 quantity runtime correction

The first user-run real PostgreSQL command suite failed in the quantity branch: `cashier_command.subtotal` was interpreted as a missing FROM entry. Successful schema creation and JavaScript tests did not detect that runtime failure.

The source now uses distinct `v_updated_subtotal` and `v_updated_discount_amount` variables for quantity recalculation. Sale subtotal, discount, total and configuration locals were also renamed to avoid column-name overlap. The full command function was inspected for similar references; no other invalid function-qualified locals remain. Calculation formulas, historical discount/tax selection, payment retention, refund derivation, locking and permissions are unchanged.

`scripts/quantity-recalculation-db-test.js`, invoked by the default real database suite, adds assertions for nominal/percentage discounts, tax, fractional reductions/increases, nominal discount capping and subsequent edits, cash tender/change, DP plus settlement retention, refundDue, stored totals, revisions and idempotent retry. These tests are authored, not executed in this source-only correction.

`npm run check`, `npm test` and `git diff --check` passed for the correction. They do not prove the SQL runtime failure is resolved. No SQL or build was executed in this correction, and no production access, deployment, commit or push occurred. Legacy remains default.

Required next local validation: provision a fresh empty disposable PostgreSQL 14 test database with the corrected reviewed source (the failed test left committed fixtures, so simply rerunning against that database will fail the empty-database guard), then rerun `node scripts/normalized-db-test.js --confirm-disposable`. Also rerun `--migration-only` and `--cutover-only` against separate fresh disposable databases. The full schema file is a creation script, not an in-place upgrade script; do not blindly reapply it to an existing database. PostgreSQL runtime confirmation remains outstanding.

## PostgreSQL payment-history response type correction

The next user-run PostgreSQL test reported `'2' !== 2`. Source tracing identifies the matching assertion in `scripts/quantity-recalculation-db-test.js`: `percentRefund.paymentHistory[0].amount` is strictly compared with numeric `2`. The payment request supplies `amount: '2'`; cashier_command validates it into a NUMERIC payment column but retains the raw string in payment JSON. transaction_json previously returned that raw JSON amount unchanged. This is a response reconstruction defect, not an incorrect numeric expectation or a psql scalar-text conversion problem.

transaction_json now overlays payment history `amount` from the authoritative `transaction_payments.amount` NUMERIC column, alongside the existing typed date override. PostgreSQL JSON construction emits that value as a JSON number, which JSON.parse produces as a JavaScript number, consistent with canonical transaction money, item quantities and revisions. Invoice identifiers remain strings. Raw request JSON and quantity-edit request audit snapshots retain their original input representation; they are not canonical monetary response fields. No money formula, precision policy, payment balance, or storage value was changed, and no blanket Number coercion was introduced. Existing JavaScript-number precision limits are unchanged.

The runner now prints `error.stack` with a message fallback. A no-flag preflight invocation verified a stack is printed before any database command can execute. Quantity tests now check the payment command's history amount immediately and label the original post-edit assertion. A new `scripts/payment-history-db-test.js`, invoked by the default database suite, asserts numeric integer/fractional history for string and numeric requests, unchanged raw input, numeric quantities/money/revisions, string invoices, idempotent responses, exact detail/history reads and typed-column precedence over stale raw JSON. Existing stored operation receipts are not rewritten by this source change.

For this correction, `npm run check`, `npm test` and `git diff --check` passed. No SQL was executed and no production connection, deployment, commit or push occurred; legacy remains default. Real PostgreSQL tests remain unexecuted here. Rerun `node scripts/normalized-db-test.js --confirm-disposable` with this corrected schema on a fresh disposable local database; the runner requires empty fixtures. The earlier independently gated migration and cutover suites also remain pending unless separately confirmed by the operator. JavaScript success does not establish PostgreSQL success.
