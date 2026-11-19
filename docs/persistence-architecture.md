# Persistence architecture: controlled rollout, not executed

## Existing behavior

The default `legacy` mode uses the existing `app_state.payload` snapshot and version compare-and-swap. Authentication checks the current active `app_users` row on every request. Hosting and authentication boundaries remain unchanged. Full history grows with legacy writes; normalized mode uses bounded reads and operation commands, never full-state writes.

Line amount is (price minus per-unit discount) times fractional quantity. Profit uses historical cost. Order discount is nominal or percentage, capped at subtotal; tax applies after discount. Cash tender minus change is retained cash; DP uses downPayment and settlements add retained cash. Quantity corrections adjust stock by the difference, retain payments and expose overpayments. Incoming stock uses weighted-average cost. Historical names and orphan lines remain snapshots.

## Normalized design

A private `cashier` schema holds products, customers, suppliers, transactions, transaction_items, transaction_payments, incoming_stock and stocktakes, plus operation receipts, quantity audits and control/config. Browser roles have no table access. Service-only SECURITY INVOKER RPCs validate commands and recheck roles. Unscaled NUMERIC preserves fractional values. Immutable legacy JSON retains unknown fields; typed columns govern new operations.

Commands lock the control row first, then operation identity, transaction and products in ID order. A receipt binds actor, command and exact JSON body to an operation ID. Same retries return the original response; changed input fails. Business changes and receipt commit or roll back together. Browser storage persists the exact command before sending. Recovery parses only the current actor's namespace, preserving other actors' records, including malformed records.

Invoices use a transactional counter in the already locked control row and a unique constraint. Migration seeds from the maximum historical invoice matching `^[0-9]{1,9}$`, or -1 when none exist. New invoices start at 0 for an empty sequence. Leading zeros and custom historical invoice strings remain unchanged; exact-string collisions are skipped. Allocation rolls back with the command.

New business days use Asia/Jakarta while absolute timestamps remain UTC. Migration reports historical ambiguity and supports explicitly reviewed Jakarta conversion. Bounded reads use a shared expected revision and a STABLE read RPC; conflicts retry a bounded number of complete read sets before publishing. KASIR dashboard responses exclude cost/profit recursively.

Printing requires an explicit selected invoice. Normalized preview and every physical print retrieve that exact invoice through `/transaction-by-invoice`. Missing or mismatched responses block printing. Selection/session changes cancel in-flight prints, including while the frame loads; history page changes cannot substitute another invoice.

## Guarded rollout

1. Independently review SQL and rehearse on an empty disposable PostgreSQL instance. Schema files and tests have not been applied by this task.
2. Arrange maintenance and export the original app_state row, version, timestamps and hash. Retain immutable backups and reconciliation metrics. Stopping clients reduces disruption but is not the correctness mechanism.
3. Apply separately authorized, reviewed schema and legacy hardening. Leave database and server in legacy mode. Never delete app_state.
4. Run the offline migration dry-run, review warnings, generate and review import SQL. Import rejects changed source versions and divergent existing normalized data.
5. Validate the normalized export against the bundle: snapshots, counts, stock, balances, totals, dates and invoices. Any mismatch blocks transition.
6. As the database owner/operator, invoke the guarded transition with the exact validated bundle identity in a READ COMMITTED transaction:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '10s';
-- Substitute the validated bundle's sourceVersion and sourceHash.
SELECT cashier.enter_normalized_read(<sourceVersion>, '<sourceHash>');
COMMIT;
```

The function first takes an EXCLUSIVE table lock on app_state, then locks control. Existing legacy writes finish before that table lock is granted; a fresh source version check rejects any intervening committed save. New saves wait behind the table lock. The function verifies the imported identity and atomically changes only to normalized-read, activating the write fence at commit. The legacy trigger takes a locking control read: waiting saves see the committed fence or fail serialization under stale transaction snapshots. Errors/timeouts roll back the transition. The application service role cannot call the transition or update the mode column. Never replace this procedure with a direct mode UPDATE.

If the source changed, stay in legacy and prepare a new reviewed migration/validation. Do not relabel stale normalized data by changing its recorded source version. After successful transition set server PERSISTENCE_MODE=normalized-read through a separately authorized deployment, reload clients and perform read-only acceptance.

7. Enabling normalized commands requires a separate explicit operator decision after SQL/concurrency/browser/rollback acceptance. The transition never enables writes automatically.
8. Before any normalized writes, an independently reviewed rollback can restore legacy mode because app_state was preserved and fenced. After normalized writes, freeze and back up both stores, reconcile changes into a validated legacy snapshot before any authorized reverse migration. A mode flip alone loses data. Prefer roll-forward and retain receipts.

See [second safety review](persistence-second-review.md) for policy decisions and test limitations. No production readiness claim is made.
