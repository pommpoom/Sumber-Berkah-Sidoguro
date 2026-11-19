# Staging browser acceptance plan

Status: plan only. No infrastructure created, cloud connection made, migration run, or deployment performed by this task. The operator reports all three real PostgreSQL suites passed locally (command/concurrency/authorization, migration/reconciliation, and cutover/fencing). These results do not replace staging browser acceptance. Record the source revision/diff hash used for each run.

## Minimum isolated infrastructure

- One dedicated staging Supabase project/database, separate from production, with its own project URL and credentials. Provision it manually under a separate authorization. Local PostgreSQL alone cannot validate the hosted authentication, HTTPS and browser/network path.
- One isolated HTTPS application origin serving the frontend and its existing Node/Netlify API, built from the same source. A single deployment can serve both; no new services, tables, or endpoints are needed for this hardening. Use a separate hosting project/environment rather than an environment that inherits production secrets. No hosting is provisioned or deployed by this task.
- Synthetic catalogue, contacts and historical transactions, including enough records for several history pages, old/custom/leading-zero invoices, DP balances, and both tracked and untracked products. Never copy production data, backups, users, tokens or credentials.
- Two independent browser sessions, separate ADMINISTRATOR and KASIR test accounts, and a mobile device. Include actual 58 mm printer and A4/PDF output for print acceptance. A mobile device needs access to the staging HTTPS origin, not a localhost URL on another computer.
- Access to staging-only server logs, database inspection and browser network tools. Logs must not expose passwords, cookies, keys or full financial/customer payloads. Keep evidence in a restricted test record.

## Environment and preparation

Configure separate staging values for SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_ANON_KEY, JWT_SECRET, INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD. Use a unique JWT secret and disposable strong passwords. Only the project URL and anonymous/public key belong in the browser build; the secret database key, JWT secret and initial password must remain server-side. Check generated assets for secrets and ensure URLs identify staging only.

Set CORS_ORIGIN to the exact staging HTTPS origin, NODE_ENV=production for secure-cookie behavior, and STATE_JSON_LIMIT_KB to an explicitly chosen supported limit. Do not inherit or change production environment values. The repository default PERSISTENCE_MODE remains legacy.

An authorized operator reviews and applies the four schema files (server/schema.sql, legacy-hardening.sql, normalized-schema.sql, normalized-reads.sql) in dependency order to the isolated database. Begin in legacy mode, seed synthetic legacy data, export/import and validate using the migration procedure. Use cashier.enter_normalized_read with the validated source version/hash; never bypass guarded cutover with a direct normalized-read mode update. Test read-only behavior before separately authorizing normalized writes and setting the staging server/database modes consistently. Follow docs/persistence-architecture.md for the transition and rollback restrictions.

Use separate disposable fixtures for destructive legacy checks. Do not switch a database with normalized writes back to legacy without reconciliation. Retain database snapshots and migration/test evidence for the staging run.

## Acceptance matrix

For every case record role, browser/version/device, fixture invoice/operation ID, expected versus observed outcome, network status, persisted result after reload, and pass/fail. Repeat relevant read/print/recovery cases as both roles.

| Area | Procedure | Required result |
| --- | --- | --- |
| Authentication and role boundaries | Sign in/out as ADMINISTRATOR and KASIR; expire session; directly attempt restricted API calls as KASIR. | Server rejects unauthorized calls; logout/session changes cannot apply old results. KASIR cannot see cost/profit or administer configuration. |
| Read-only acceptance | In normalized-read attempt sale, payment, stock or preference changes. | Clear read-only feedback, no optimistic persisted state or database changes. |
| Transaction creation | Sell fractional and multiple lines, repeat products, tracked/untracked goods, price overrides, full discounts, zero price and below-cost lines. | Retained pricing permissions; authoritative totals and stock; one unique invoice; result survives reload. No full-state PUT or growing-history request. |
| DP settlement | Create DP, settle partially and fully, retry same operation, attempt excess settlement. | Numeric payment-history amounts; correct retained payment, balance and status; no duplicate payment. |
| Quantity correction | ADMIN decreases/increases quantities with nominal/percentage discount and tax; include an overpayment. | Historical discount/tax rules preserved, stock delta correct, payments retained, refundDue displayed. KASIR cannot edit quantities. |
| Incoming stock | ADMIN records receipt with weighted cost; retry after response loss. | Exactly one receipt and stock/cost change, survives reload; KASIR denied. |
| Stocktake | ADMIN counts stock; another session changes stock before submission. | Matching expected stock commits once; stale count fails visibly without overwriting new stock. |
| Concurrent users | Two sessions sell the last stock, allocate invoices, settle the same balance, and update configuration from the same revision. | No overselling, duplicate invoice or excess payment; stale configuration rejected without silently overwriting the winner. |
| Lost response and recovery | Allow a command to commit, then drop its response with a controlled staging proxy/devtools; reload and sign in as the same actor. Repeat for print preferences. | Durable same ID/body replay, one effect, confirmed server state. Another actor cannot replay/delete the command. A foreign malformed storage entry cannot block own recovery. |
| Print preferences: ADMIN | Change receipt type and method; throttle response; reject request; lose response; reload/new tab after success. | Existing configuration API only; controls/state show last confirmed preferences while waiting; explicit errors and same-operation retry; preferences survive reload. Current configuration is shared across users/devices. |
| Print preferences: KASIR | Attempt to change receipt type/method in normalized mode. | Clear administrator-only message and original selection restored; no request or local-only settings change. Printing remains permitted. Legacy permission behavior remains unchanged. |
| Exact invoice printing | Search an invoice off the current page, with leading zeros/custom text; change history search/page and refresh; rapidly switch selected invoices; request missing/failed invoice. Test receipt, Invoice A4 and Faktur A4. | Exact endpoint lookup for selected invoice; no first-row fallback. Failure or changed selection/session blocks printing, including during frame loading. Verify customer, lines, amounts and invoice on physical/PDF output. |
| Printer settings | Exercise Dialog Printer and Tidak Mencetak using the primary print button; verify receipt width, margins, fonts and page breaks on supported desktop browsers. | Confirmed preference honored. Explicit individual layout buttons retain their existing behavior. Browser/OS printer controls still require user configuration. |
| Blocked administration | Attempt transaction/incoming/stocktake deletion, product/customer/supplier/reference deletion, reset, restore and backup in normalized and normalized-read modes, including clicks on nested button content. | Clear temporarily-unavailable feedback before confirmation, file picker, mutation or download; no success toast, no full-state request, state/stock unchanged after reload. |
| Export completeness | Try full transaction/incoming CSV export on a paginated history page. Separately export products, suppliers and customers as authorized roles. | History exports blocked explicitly; no partial file represented as complete. Catalogue/contact exports remain available because bootstrap loads full collections and fails rather than truncates above its catalogue limit. |
| Legacy regression | On separate legacy fixtures change print settings, exercise existing administration/backup/export paths, refresh and inspect saved state. | Existing legacy behavior retained; normalized guards do not intercept legacy actions. |
| Mobile | Test Android Chrome and iOS Safari where supported: portrait/landscape, narrow viewport, touch selection, keyboard search, navigation, background/resume, offline/online and reload. | Save/retry/error messages visible and operable; no duplicate submissions or stale selection prints; printable PDF/share behavior documented per OS. |

## Gaps and release blockers

Intentionally unavailable in normalized mode: historical deletion, product/contact/reference deletion, reset/restore, full-state backup, full-history transaction/incoming CSV export. Do not add unsafe local deletion or export a loaded page as a complete history. User administration through its existing server API and complete catalogue/contact exports remain separate supported paths.

Print preferences are shared configuration and the existing API permits ADMINISTRATOR only. KASIR can print but cannot persist shared preferences in normalized mode. Per-user printer preferences would require a separate explicit product/security decision; do not broaden configuration access to achieve parity. Quantity audit inputs retain request representation; canonical monetary/quantity response fields use typed server values. No frontend change in this task alters pricing permissions or the Dashboard.

Release blockers: any failed row above; missing isolated staging/credentials; unverified HTTPS cookies/CORS; no real-browser confirmation of preference persistence and lost-response recovery; wrong or stale invoice output; missing required mobile/printer coverage; unnoticed partial exports; unresolved reconciliation or rollback rehearsal; secrets in assets/logs; or business owners requiring an intentionally unavailable feature for launch. Record acceptance of parity gaps explicitly. None of these gates is waived by passing unit tests or the operator's local PostgreSQL suites.

## Evidence for this source-only hardening

Changes reuse the existing configuration command, its version check, durable operation identity, server acknowledgement and bounded refresh. Unsupported click actions are guarded before side effects; direct backup/restore/history-deletion functions retain their mode guards. No schema changes or new endpoints are needed. Automated regression covers delayed/rejected/malformed acknowledgements, server-authoritative settings, same-actor recovery, simulated fresh-page bootstrap, role/read-only behavior, legacy preferences, blocked actions and permitted catalogue exports. Actual staging browser/printer checks above remain pending.
