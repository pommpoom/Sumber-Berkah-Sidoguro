# Non-dashboard reliability audit — 22 October 2026

Implemented and tested locally. No deployment, commit, push, production database access, environment change, or schema change was performed. Dashboard rendering, cards, chart, and page markup are unchanged. No dependencies were added.

## Findings and changes

The original device-specific incidents were not observed on the users' devices. The findings below distinguish defects demonstrated in code/tests from likely device-dependent contributors.

| Issue | Evidence from the original code | Revision |
| --- | --- | --- |
| 1. Bayar Sisa DP missing | The action depended on `remaining`, sat at the far end of a 19-column table, and Realtime events were discarded while a modal was open. Server settlement merging trusted stored `remaining`, so stale zero could silently discard a payment. Exact affected production records were not inspected. | Calculate eligibility from total minus initial payment and settlements; normalize DP spelling; retain modal/hidden-tab events; place the action beside the sticky invoice column as well as in existing actions/detail. Require a signed-in administrator/cashier. Server derives the real balance and rejects invalid payments instead of silently dropping them. Payments wait for confirmation and use stable IDs. |
| 2. Edit historical quantity | No editing workflow existed. | Administrator-only Edit Qty; validate finite positive quantities, existing products, and aggregate stock deltas across repeated product lines before changing anything. Recompute item amounts/profit, subtotal, discounts, tax, total, balance and payment status. Record before/after quantities, actor, time and operation ID. Commit through the critical-save mechanism. Cashier API attempts to change historical quantities/prices receive 403. |
| 3. Cashier disappears after refresh | `saveTransaction()` called debounced `saveState()`, immediately cleared the cart, displayed success, and navigated to print. The PUT had not necessarily started, much less succeeded. Numeric invoice IDs also collided between devices; generic conflict merging could combine financial fields and stock unsafely. | Success/reset/printing happen only after an acknowledged PUT or a conflict read proving that the same operation was already committed. UUID transaction identity is separate from invoice number. Conflicts retain input, adopt current server state and require review/resubmission. Existing invoice collisions receive a fresh sequential number at submission. Aggregate stock checks cover duplicate product lines. |
| 4. Form reset varies | Reset occurred before persistence; `renderAll()` invoked `renderCashier()`, which overwrote line price, discount and date. Native events on different devices could expose different sequences. The specific reported device failure was not reproduced. | Reset the complete cashier draft only on confirmed success (and initialization of a new session). Shared-data rerenders preserve cashier and incoming input/select values; cashier rendering no longer overwrites a manually entered line price/discount/date. Failed/conflicting saves preserve input. |
| 5. Logout appears slow | Handler checked `event.target.id`, but React renders icon/text children inside the button. Clicking a child did nothing. Logout normalized all transaction data before hiding the UI. Activation and other API responses also lacked complete stale-session guards. | Delegate through `closest`, immediately hide authenticated UI, invalidate the session, stop timers, abort state requests, clear state/drafts, unsubscribe Realtime and cancel critical callbacks. One bounded logout request runs independently; a failed server logout exposes a retry button. Old activation/API responses cannot restore or terminate another session. |
| 6. Cashier password | Cashier navigation/page permissions and backend `requireAdmin` already prohibited password change. The generic `/users/:id/password` route appeared before `/users/me/password`, breaking administrator self-service. React navigation mounting could occur after initial role filtering. | Preserve backend cashier 403, add explicit submit guard, refresh role filtering when React navigation mounts, exclude hidden buttons from keyboard navigation, and order the specific self-password route first. Administrator old-password validation and user password reset are both tested. |
| 7. Incoming search | Delegated input/change handlers already existed; this was not a keyup-only bug. Suggestions relied entirely on native datalist behavior, which differs by browser. No affected physical device was available. | Small explicit filtered suggestion list with normalized names, stable product IDs, delegated input/click handlers and composition-end support. No listeners added during rendering. Native datalist dependency removed from the input. |
| 8. Barang Masuk not saved | Record insertion and stock/cost update were followed by a queued save and immediate reset/success, just like cashier. | One critical operation contains incoming record plus stock/weighted-cost update. Reset only after persistence, preserve input on failure/conflict, and retry the same operation identity after an uncertain response. Administrator-only permission remains. |
| 9. Preview differs from print | Mobile CSS forced the receipt preview to 58 mm while print content was 54 mm; A4 preview had separately maintained styles. Several receipt fields forced unbreakable lines. Physical device output was not reproduced. | Preview iframes use the exact `printFrameHtml()` document used by printing, isolated from responsive application CSS. Keep explicit 58 mm paper/54 mm receipt content, A4 dimensions, page margins and print media rules; use point font sizes and allow long text wrapping. |

Issues 3, 4 and 8 share premature success/reset semantics; DP payment used the same unsafe save pattern. Issues 1 and 4 also involve refresh/render behavior. Logout and password routing have separate causes.

## Persistence and permissions

Before: a local change and scheduled debounce were presented as saved. After: critical operations visibly remain pending through the one-second debounce, PUT, response parsing, and bounded retries. Confirmed success means persistence acknowledgment, not a queued request. A lost acknowledgment is resolved using an operation identity already persisted in the existing JSON document.

Definitive rejection rolls back the local mutation and leaves the editable form. A version conflict loads current server state and leaves the draft for review/resubmission; financial data is not automatically merged for critical operations. An uncertain network failure retains the pending operation and locks further edits/submissions until retry resolves it, preventing a second transaction from being created. After five automatic retries, a persistent banner offers an explicit retry of the same operation. A before-unload warning discourages closing an unconfirmed operation; it is not durable offline storage.

The existing sync writer remains the only writer: one-second debounce, duplicate-state suppression, five automatic retries, 30-second version-only fallback, hidden-tab stopping, Realtime exclusivity, abort controllers, session guards, pending Realtime events, request limits and rate limiters remain. No new polling or per-operation endpoint was introduced. Full-state GETs remain version-triggered or conflict recovery. Static Netlify delivery and the single function architecture are unchanged.

Administrator: quantity editing, incoming stock, password changes and user password reset. Cashier: sales, viewing/printing and settling balances; no quantity editing, incoming changes or self-password changes. Password prohibition was already present server-side and is now explicitly covered by regression tests. Secrets/cookie settings remain server-side/unchanged.

## Quantity and payment policy

- Apply `old quantity - new quantity` to tracked stock, aggregated by product; never replay the full sale.
- Preserve original payment records and original cash received. Increasing total creates an unpaid balance; decreasing total below money received shows `Pengembalian belum dicatat` in details and printed documents. This revision does not claim a refund was actually paid and does not add a refund-processing workflow.
- New transactions retain their discount mode. Legacy transactions without this field retain their recorded nominal discount, capped at subtotal, because original percentage-vs-nominal intent cannot be recovered reliably. Historical tax percentage remains in use.
- Deleted products block edits pending administrator investigation. Untracked products do not gain/lose stock through a sale or quantity edit.
- New audit/operation metadata lives inside `app_state` JSON. No SQL/schema change is needed or proposed.

## Files changed

- `assets/js/app.js`: confirmation-aware saves; conflict/duplicate/session guards; quantity editing; payment normalization; draft preservation; logout; permissions; search; common print preview document.
- `server/app.js`: cashier quantity authorization, aggregate stock validation, version guard before cashier merge, settlement validation/derived balance, self-password route ordering.
- `assets/js/sidebar.jsx` and generated `assets/js/sidebar.js`: navigation-ready notification and keyboard filtering.
- `assets/js/page-loader.js`: cache version for the revised application bundle.
- `assets/css/main.css`: isolated preview frame sizing, search suggestion list, save banner, sticky invoice column; no Dashboard rules changed.
- `index.html`: save/retry status, logout retry, asset cache versions.
- `pages/incoming.html`: explicit product suggestions and accessible association.
- `scripts/critical-save-test.js`: 22 regression cases executing real application functions with controlled browser/network doubles.
- `scripts/business-api-test.js`: actual Express/Netlify handler tests backed by an in-memory Supabase stub, with real bcrypt/JWT behavior and compare-and-swap persistence.
- `scripts/state-refresh-test.js`: update browser doubles for the new logout/status dependencies; existing 19 sync tests retained.
- `scripts/check.js`: syntax-check the added test files.
- `package.json`: run the new regression suites in `npm test`.
- `AUDIT-REPORT.md`: this report and manual checklist.

## Verification

- `npm run check`: PASS.
- `npm test`: PASS — 19 existing sync tests, 22 new frontend/business tests, HTTP security suite, Netlify adapter suite at default/1536/2048 KB plus rejection of 2049 KB, and new API persistence/authorization suite.
- `npm run build`: PASS after retrying outside the Windows sandbox, which initially blocked esbuild spawning with EPERM. Local build warns that Realtime public configuration is absent and therefore produces a fallback-polling bundle; production variables were not read or changed. The release environment must build with its existing Realtime configuration.
- `git diff --check`: PASS.
- Compared the Dashboard render function against HEAD: unchanged. `pages/dashboard.html` is unchanged.

Tests cover slow responses, no early success/reset, failure preservation, double submission, lost acknowledgments, bounded retries, conflict review, stock/record consistency, DP rendering/payment, quantity deltas/totals/permissions/invalid input, preserved drafts, stale activation/API responses, logout, input filtering and shared print layout. The server suite checks cashier password 403, administrator self-change and reset, read-after-save state, stale version rejection, duplicate settlement IDs, stale stored DP balance, overselling rejection, and incoming record/stock persistence. Existing tests cover Realtime during dirty/in-flight writes, stale refreshes, cleanup and low-bandwidth fallback behavior.

The tests use mocks/stubs, not production data or real printers. Browser layout, mobile keyboard behavior and physical printer output remain manual acceptance items.

## Manual acceptance checklist (development/test data only)

1. **Administrator desktop:** login; check existing Dashboard unchanged; create a cash sale, confirm success only after PUT, inspect receipt/history, change own password using the old password, and reset a test cashier password.
2. **Cashier desktop:** no Ganti Password on navigation or via keyboard; direct self-password API returns 403; no Edit Qty/incoming permissions; sale and DP settlement still work.
3. **Mobile browser:** test Android Chrome and iOS Safari; product search with typing/paste/autocorrect/composition, tap a suggestion, verify stable product selection; tap logout text and icon; DP action visible beside invoice without scrolling to the last column.
4. **Two devices:** keep a draft open on B while A saves a sale/incoming/payment/edit. Verify B receives shared data without losing cart, customer, line price/discount/quantity or incoming fields. Hold a modal open, save on A, close B's modal and verify refresh. Trigger simultaneous saves; loser must retain input and request review, not silently merge stock/payment fields.
5. **Slow/failing network:** throttle PUT; all critical forms remain pending and prevent double submissions. Simulate 400 and 503; 400 keeps editable input, 503 keeps the same pending operation; after five retries the banner offers manual retry. Simulate a committed write whose response is lost, then retry and verify one record/payment and one stock change.
6. **Immediate refresh:** after confirmed sale and incoming success, refresh immediately and verify record, totals and stock. Before confirmation, verify pending status and unload warning; do not treat such a forced close as a confirmed save.
7. **Barang Masuk:** verify weighted cost and stock increase, single record after double-click/retry, cleared product/ID/category/unit/price/qty/note after confirmation, retained input after rejection.
8. **Bayar Sisa DP:** unpaid/partial/fully-paid transactions; cashier and administrator; payment and history survive refresh; duplicate click has one settlement; second device reflects settlement. Verify amount above the balance is rejected.
9. **Quantity edit:** 10→7 returns 3 stock; 7→10 removes 3. Test repeated product lines, insufficient stock, fractional/zero/negative/invalid quantity, deleted products, historical discounts/tax, partial DP, newly unpaid non-DP sale and refund-due display. Review audit history in a test export; existing transactions remain present.
10. **Logout:** click text/icon during PUT, refresh, and Realtime activity; UI switches immediately; no old callback restores data. Simulate failed logout and use the login-screen retry. Verify no authenticated data on refresh after server logout confirmation.
11. **Print:** compare embedded preview, browser dialog/PDF and physical 58 mm/A4 output on actual supported devices. Test long product/store/customer names, long receipts, multi-page A4, page breaks, margins and no UI controls. Select matching paper, 100% scale and disable browser headers/footers when supported.

## Remaining limits and deployment recommendation

Do not deploy directly to production solely on these automated checks. Recommend this revision for isolated staging/manual acceptance first, then production after the checklist passes, especially quantity/refund policy, two-device races, mobile printing and logout under network failure.

Pending drafts are memory-only. Closing/reloading before confirmation or choosing logout can abandon unconfirmed input, and an already received server write can still commit after client abort. Check history before re-entering a transaction after such an interruption. Fully confirmed operations are tested to survive reload. There is no new offline queue or schema-backed operation ledger.

Conflicts deliberately require review/resubmission, which may be noticeable at busy times. Non-critical legacy edits still use their existing merge/save behavior. Historical duplicate invoice IDs or malformed production records were not audited/repaired. Added audit records increase JSON size; existing configurable limits (production 1536 KB, maximum 2048 KB) remain enforced. Refund execution and unknown legacy discount intent require operational review as described above.

Physical output cannot be pixel-identical across all printers/drivers/browsers/OS/paper settings. Printer non-printable margins, font substitution, scaling, pagination, thermal-paper length and driver support for custom page dimensions remain outside application control.
