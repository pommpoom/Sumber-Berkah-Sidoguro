# Production review revision — SQL NOT EXECUTED

This revision continues the accepted uncommitted implementation. `PERSISTENCE_MODE=legacy` remains the default. There was no production access, SQL execution, deployment, commit or push. The normalized architecture, write transaction boundaries, locking, receipt idempotency, legacy fence, role checks and blocked destructive operations remain.

## Findings addressed

1. **KASIR Dashboard:** both roles fetch database aggregates irrespective of the ten-row history page. KASIR receives operational sales, cash, receivable and stock information. SQL and Express recursively remove cost/profit fields for KASIR. Only administrators receive/render profit KPI, bars and legend. No stylesheet or Dashboard layout redesign.
2. **Jakarta days:** SQL `cashier.business_day` and frontend date formatting explicitly use Asia/Jakarta. New sale and initial-payment business dates, UI today/time defaults, incoming/stocktake/payment defaults, normalized filters and dashboard dates agree. UTC timestamps remain absolute. New legacy-mode sales also record an explicit Jakarta `businessDate`; old records are not silently reinterpreted. Transaction filters use the returned authoritative businessDate.
3. **Numeric invoices:** migration matches the original `^[0-9]{1,9}$` convention and seeds its maximum, or -1 for no numeric invoices. Allocation increments under the existing control lock and produces numeric strings, with the unique constraint and exact collision skipping retained. `959` continues to `960`; an empty sequence starts at `0`. Leading-zero/custom historical strings stay unchanged and are reported. A committed retry does not advance the counter.
4. **Durable recovery:** each pending command stores only `{actor,id,path,method,body,timestamp}` under an operation-specific localStorage key before HTTP begins. The body is the exact serialized string. No credentials/history are stored. Same-actor normalized login recovers pending entries in timestamp order; another actor cannot execute them. Logout, timeout, malformed acknowledgement, authentication loss and server failure retain the entry. Success or a definitive command rejection removes it. Storage errors block new sending; cleanup failure cannot trigger an automatic loop. New submissions stop when 16 pending entries exist; entries are never evicted to make room. Separate operation keys prevent concurrent tabs overwriting one another’s pending body. An ambiguous retry requires the same ID, never a new one.
5. **Current bounded views:** after confirmed writes, the client reloads bootstrap plus bounded transaction history/dashboard and authorized incoming/stocktake pages. Counts, pages and summaries update with rows. The refresh button performs server reads. The command acknowledgement still controls success/form reset; a subsequent read failure does not resubmit the command. Unsaved drafts are preserved by existing rendering guards.
6. **RPC validation:** missing/NULL/non-array/empty items, malformed quantities, missing IDs, invalid configuration objects/arrays/entries, invalid booleans and malformed dates are rejected by SQL independently of Express. Dates require exact YYYY-MM-DD and a valid calendar date. SQLSTATE 22003/22007/22008/22023/22P02/23502/23514 map to 400, and 23503/23505/40001 to 409; unavailable persistence remains 503.
7. **Consistent reads:** bootstrap returns V. Every subsequent bounded page/aggregate read supplies expectedRevision=V. The STABLE read RPC validates that revision and reads data in the same statement snapshot. On conflict the browser discards the set and retries, at most three total attempts. Metadata is returned alongside the snapshot and published only when that matching state is accepted. No partial read set is rendered. This uses PostgreSQL’s documented [STABLE snapshot semantics](https://www.postgresql.org/docs/current/xfunc-volatility.html).

## Revised migration procedure

Run offline `dry-run` against a later authorized backup. Its `migrationReview` includes the numeric counter seed, custom invoices and a dateReview listing inspected timestamps, every differing legacy/Jakarta day, selected day, decision basis and ambiguous timestamps. Initial payment follows its transaction’s day; explicit payment/incoming/stocktake dates retain their existing date-only values.

Default `historicalDatePolicy=preserve-legacy` keeps the previous timestamp slicing decision explicitly. The report records possible Jakarta changes without applying them. If reviewed and approved later, use `--historical-dates=jakarta` with both dry-run and prepare. UTC-offset-free historical timestamps are reported as ambiguous; Jakarta conversion refuses them unless an explicit authoritative business date already exists. Missing timestamps remain missing. Existing explicit business dates take precedence under either policy.

The import saves this decision in `cashier.control.migration_review`, seeds `invoice_counter`, and verifies source, rows and policy on restart. The export/validator checks this metadata and the actual counter alongside all previous count/financial/stock checks. Different policy on the same imported source is refused. Source timestamps, invoices and money snapshots are not overwritten.

## Files changed in this revision

- `assets/js/app.js`: role-aware aggregates/chart; Jakarta helpers; durable pending requests/recovery; coherent bounded reads and refreshes.
- `server/normalized-schema.sql`: numeric invoices, business-day/date helpers, strict RPC validators, financial redaction helper, migration-review metadata.
- `server/normalized-reads.sql`: STABLE/expectedRevision, Jakarta defaults, KASIR aggregates/redaction.
- `server/normalized.js`: dashboard authorization, recursive financial redaction, expectedRevision forwarding, SQLSTATE mapping.
- `scripts/business-date.js` (new): offset-aware historical Jakarta date conversion.
- `scripts/persistence-migrate.js`: historical day report/policy, counter seed/custom invoice report, metadata validation/restart guard.
- `scripts/critical-save-test.js`, `scripts/persistence-migration-test.js`, `scripts/normalized-api-test.js`, `scripts/normalized-db-test.js`: tests below.
- `docs/persistence-architecture.md`, `docs/persistence-delivery.md`, this report: revised design, migration and blockers.

## Exact added/extended tests

Executed JavaScript/browser tests added to critical-save-test:

- KASIR dashboard uses aggregate totals beyond the history page and hides all profit UI.
- Jakarta business-day boundaries do not depend on the device timezone (23:59, 00:00, 00:30, 06:59, 07:00 WIB).
- Durable command survives lost acknowledgement and fresh-page login, retaining exact ID/body.
- Different actor cannot replay pending command; explicit logout retains ambiguous operation.
- Durable storage failures and credentials block sending; definitive rejection clears pending.
- Failed durable cleanup does not cause an automatic retry loop.
- Incomplete acknowledgement retains the durable command and draft.
- Revision conflict retries the whole bounded read set without publishing mixed metadata.
- Continuous revision conflicts stop after three read attempts.
- Normalized transaction refresh button performs server reads.
- Five parameterized confirmed-write tests: incoming, stocktake, sale, payment and quantity correction refresh bounded rows, summaries and pagination without `/state`.

Migration tests added:

- Jakarta boundaries and explicit historical migration date policy, including ambiguous timestamps and preserved explicit settlement dates.
- Numeric counter seeding with `959`, `000975`, custom/nonconvention values, empty sequence, counter mismatch and deterministic restart output.

HTTP tests extended: both-role dashboard access, full aggregate counts, nested sensitive-key removal, administrator profit retention, expectedRevision forwarding and six normal input/conflict SQLSTATE mappings.

**Authored but not executed PostgreSQL tests:** direct RPC calls bypassing Express for missing/NULL/empty/non-array items, invalid quantities/configuration/IDs/booleans/dates; no receipt/stock changes on rejection; five Jakarta boundaries under a different database session timezone; migrated `959 → 960`; retries leave counter unchanged; concurrent invoices remain unique numeric strings; KASIR SQL dashboard contains no cost/profit keys; admin retains profit; intervening write rejects a stale expectedRevision. Existing atomicity/concurrency/rollback tests remain. No psql, PostgreSQL, Docker or Supabase CLI executable was available locally.

## Verification and remaining cutover gates

Final verification: `npm run check`, `npm test`, `npm run build`, and `git diff --check` all passed. The suite includes 19 state-refresh tests, 46 browser/critical-save tests, seven migration tests, plus the HTTP/security, Netlify adapter, business API and normalized API assertion suites. Build used authorized child-process access outside the sandbox and emitted the expected missing local Supabase configuration/fallback warning. JavaScript tests and stub HTTP contracts are not evidence that unexecuted SQL has compiled or that real PostgreSQL concurrency has passed. All real PostgreSQL tests remain pending.

Production cutover remains blocked on SQL rehearsal, real concurrent database tests, actual-data validation/date-decision review, real-browser multi-tab/recovery acceptance and rollback rehearsal. Browser storage deletion, private-mode eviction or loss of the device requires receipt reconciliation before recreating any uncertain operation; no client storage can survive deliberate deletion. Preserve pending records during a maintenance cutover.

Administrative parity remains incomplete by design. Transaction/incoming/product/contact/reference/stocktake deletion and whole-state restore/reset stay blocked until reviewed archival/reversal workflows exist. Full-history CSV export needs a reviewed complete export route. Backup remains an authorized database export workflow rather than a partial-page browser backup. Normalized print preferences are session-local unless an administrator saves defaults through settings. These are explicit production-cutover blockers, not completed features.
