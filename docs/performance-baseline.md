# Protected Navigation Performance Baseline

Measured: 2026-07-13 11:22 EDT

Branch: `perf/dashboard-hot-path`

Baseline commit: `776e5f1ebe4146cf717f101b4618dde595136e32`

## Scope

This baseline targets the reported lag while moving between normal app pages, especially Settings and Full Log/history.

Measurements used a disposable production Docker image built from the baseline commit, an isolated PostgreSQL database, and a synthetic household on `http://localhost:3001`. The existing Cubby deployment on port 3000 and its data were not changed.

The synthetic heavy-history case contains exactly 100 activity rows, matching the current `listActivities()` limit.

## Repeatable Loop

1. Build and run the baseline production image against an isolated PostgreSQL container.
2. Create a disposable owner, household, and baby.
3. Insert 100 deterministic synthetic note activities.
4. Use the Full Log search form to force fresh authenticated document requests:
   - A no-match term produces 0 rows.
   - Terms such as `Synthetic`, `performance`, and `note` produce 100 rows.
5. Read the browser Navigation Timing entry immediately after each form submission.
6. Read Resource Timing entries ending in `?_rsc=...` to count Next.js prefetch requests.
7. For one heavy transition, temporarily enable PostgreSQL statement logging and classify the resulting SQL statements. Reset logging immediately afterward.
8. Run `EXPLAIN (ANALYZE, BUFFERS)` for the representative filtered activity query.

## Browser Baseline

| Scenario | Rows | TTFB | Response complete | DOM ready | Load | Encoded document | Visible edit prefetches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full Log no-match | 0 | 276.3 ms | 296.4 ms | 328.5 ms | 350.6 ms | 37,127 B | 0 |
| Full Log `Synthetic` | 100 | 336.1 ms | 395.9 ms | 524.7 ms | 549.2 ms | 339,875 B | 8 |
| Full Log `performance` | 100 | 340.6 ms | 360.5 ms | 526.5 ms | 556.1 ms | 340,483 B | 8 |
| Full Log `note` | 100 | 279.7 ms | 298.5 ms | 451.3 ms | 465.9 ms | 338,355 B | 8 |
| Full Log `performance note` | 100 | 363.7 ms | 400.7 ms | 551.7 ms | 580.9 ms | 342,403 B | 8 |

Heavy-history summary:

- Median TTFB: **338.35 ms**
- Median response complete: **378.2 ms**
- Median DOM ready: **525.6 ms**
- Median load: **552.65 ms**
- Median encoded document: **340,179 B**
- Observed range: **279.7–363.7 ms TTFB** and **451.3–551.7 ms DOM ready**

The controlled 0-row/100-row contrast increases the document from 37 KB to roughly 340 KB and adds about 197 ms between the observed DOM-ready samples.

## Post-Change Production Verification

The after-change image was built from the uncommitted worktree and run against the same disposable PostgreSQL database, synthetic household, and 100 activity rows on port 3001.

Each search still matches all 100 synthetic activities, but cursor pagination renders only the first 25 rows in the initial document.

| Scenario | Initial rows | TTFB | Response complete | DOM ready | Load | Encoded document | Edit prefetches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full Log `Synthetic` | 25 | 246.3 ms | 321.2 ms | 360.1 ms | 361.3 ms | 115,257 B | 0 |
| Full Log `performance` | 25 | 176.6 ms | 196.3 ms | 280.0 ms | 281.4 ms | 115,419 B | 0 |
| Full Log `note` | 25 | 163.5 ms | 191.0 ms | 256.2 ms | 283.6 ms | 114,852 B | 0 |
| Full Log `performance note` | 25 | 223.0 ms | 240.4 ms | 287.2 ms | 321.5 ms | 115,924 B | 0 |

Post-change summary:

- Median TTFB: **199.8 ms**, down **40.9%** from 338.35 ms.
- Median response complete: **218.35 ms**, down **42.3%** from 378.2 ms.
- Median DOM ready: **283.6 ms**, down **46.0%** from 525.6 ms.
- Median load: **302.55 ms**, down **45.3%** from 552.65 ms.
- Median encoded document: **115,338 B**, down **66.1%** from 340,179 B.
- Observed range: **163.5–246.3 ms TTFB** and **256.2–360.1 ms DOM ready**.

Acceptance results:

- **Pass:** median encoded document is below the 130 KB target; every individual sample was also below the target.
- **Pass:** median DOM ready is below the 400 ms target; every individual sample was also below the target.
- **Pass:** Full Log renders 25 rows and emits zero automatic edit-page RSC prefetches before selection.
- **Pass:** Settings renders all nine cards and emits zero automatic settings-card RSC prefetches before selection.
- **Pass:** cursor traversal reached synthetic IDs 001–100 exactly once across four 25-row pages; the final page had no `Older entries` link and `Newest entries` returned to page 1.
- **Pass:** changing babies resets the history cursor while preserving independent type/search filters, covered by a focused regression test.
- **Pass:** browser console inspection after the final sample reported no console messages or JavaScript errors.
- **Pass:** the canonical full suite completed with 20 test files and 92 tests passing.
- **Pass:** lint, typecheck, and the production Docker build completed successfully before the after-change browser run.

These results meet the workstream acceptance target without Slice C request-context caching. Request-local authentication/context deduplication remains a possible future optimization, not a requirement for this change.

## Prefetch Evidence

### Full Log

At baseline, the 100-row history page began prefetching edit pages for visible activity rows. The measured viewport launched eight edit-page RSC requests immediately. The same page also prefetched the AppShell destinations; one fresh heavy navigation recorded 15 total RSC resource requests.

Each additional scroll can expose more row links and make more edit pages eligible for prefetch.

Relevant code:

- `src/app/app/history/page.tsx:100` renders every row as a Next.js `Link` to its edit page.
- At baseline, no high-cardinality row link set `prefetch={false}`.

### Settings

At baseline, opening Settings launched RSC prefetches for all nine settings cards:

- Appearance
- Admin
- Babies
- Members and access
- Integrations
- Backups
- Export
- Notifications
- Sessions

Individual observed requests took roughly 23–85 ms in the light synthetic household. These are background requests for destinations the user has not selected.

Relevant code:

- At baseline, `src/app/app/settings/page.tsx:34` rendered all settings cards as default-prefetch Next.js links.

Primary AppShell navigation prefetch is intentionally separate: those five high-frequency destinations are a bounded set and can make the next deliberate navigation faster. The first fix should target high-fan-out row/card lists rather than disable all prefetching globally.

## Query-Path Evidence

A fresh heavy Full Log navigation plus its automatic prefetch activity executed **31 PostgreSQL statements**:

- Session: 3
- User: 4
- HouseholdMember: 4
- Household: 2
- Baby: 2
- ActivityLog: 2
- Activity detail tables: 11
- Other/control statements: 3

Static tracing explains the repeated context work:

1. `src/app/app/history/page.tsx:18` calls `requireUserPage()`.
2. `src/app/app/history/page.tsx:19` calls `getHeaderBabySelector()`.
3. `src/server/services/baby-selector.ts:14` calls `getHouseholdHome()` and then queries active timers.
4. `src/app/app/history/page.tsx:20` calls `listActivities()`.
5. `src/server/services/activities.ts:333` calls `getHouseholdContext()`.
6. `src/server/auth/context.ts:14` calls `requireUser()` again and queries membership again.

Settings has the same duplicated authentication pattern:

1. `src/app/app/settings/page.tsx:22` calls `requireUserPage()`.
2. `src/app/app/settings/page.tsx:23` calls `getHouseholdContext()`.
3. `getHouseholdContext()` calls `requireUser()` again.

## Database Falsification

The representative 100-row filtered activity query completed in **7.951 ms** under `EXPLAIN (ANALYZE, BUFFERS)`. Planning took 9.789 ms in that one direct diagnostic invocation.

This makes a missing activity index unlikely to be the primary cause of the measured 280–364 ms TTFB or 451–552 ms DOM-ready times. The initial fix should not add speculative indexes.

## Ranked Root-Cause Hypotheses

1. **Automatic prefetch fan-out amplifies route work.**
   - Evidence: eight visible edit-page prefetches on Full Log, nine settings-card prefetches on Settings, and 15 total RSC requests after one heavy navigation.
   - Prediction: setting `prefetch={false}` on high-fan-out history-row and settings-card links removes those background requests without changing destination correctness.

2. **Repeated authentication and household-context resolution inflates every protected render and every prefetched RSC request.**
   - Evidence: duplicated call paths in source and repeated Session/User/HouseholdMember statements in the trace.
   - Prediction: request-local deduplication reduces repeated context SQL and TTFB, especially when several RSC requests overlap.

3. **Full Log’s initial 100-row payload dominates response size and browser work.**
   - Evidence: approximately 340 KB heavy document versus 37 KB at zero rows; median heavy DOM-ready is 525.6 ms.
   - Prediction: cursor pagination with a smaller first page materially reduces document size and DOM-ready time while preserving access to all history.

4. **Raw activity-query execution is not the primary problem.**
   - Evidence: representative SQL execution completed in about 8 ms.
   - Prediction: speculative index changes alone would not materially change the browser baseline.

## Proposed Minimal Implementation Sequence

### Slice A — Stop unintended prefetch fan-out

- Add `prefetch={false}` to Full Log activity-row links.
- Add `prefetch={false}` to Settings section-card links.
- Keep the bounded primary AppShell navigation prefetch enabled.
- Re-run Resource Timing and verify:
  - Full Log emits zero automatic edit-page RSC requests before a row is selected.
  - Settings emits zero automatic settings-card RSC requests before a card is selected.

### Slice B — Paginate Full Log

- Return a first page of 25 activities rather than rendering 100 immediately.
- Add a cursor-based `Older entries` path/control so all history remains reachable.
- Preserve baby/type/search filters in pagination links.
- Add unit tests for cursor query construction, filter preservation, and stable ordering.
- Re-run the 100-record scenario and target:
  - Initial encoded document below 130 KB.
  - No more than 25 activity rows in the initial DOM.
  - All 100 rows reachable without duplicates or omissions.

### Slice C — Deduplicate protected request context only if needed

- Measure Slice A and B first.
- If TTFB remains above the agreed target, introduce request-local session/context reuse rather than cross-request user caching.
- Prove with query counting that one route render no longer repeats session and membership resolution.
- Do not cache authorization state across requests.

## Acceptance Target for This Workstream

For the disposable 100-record household in production mode:

- Full Log initial document below 130 KB.
- Median Full Log DOM-ready below 400 ms on the same host.
- Zero automatic edit-page prefetch requests before explicit selection.
- Zero automatic settings-card prefetch requests before explicit selection.
- No activity-history loss: cursor pagination reaches all rows exactly once.
- Existing tests, lint, typecheck, and production build pass.

## Safety and Isolation

- The existing Cubby stack on port 3000 was not restarted or modified.
- No real account, household, activity, credential, `.env`, or runtime configuration was read or changed.
- PostgreSQL statement logging was enabled only in the disposable container and reset after the diagnostic request.
- The disposable containers/volume remain available for before/after measurements until cleanup is explicitly approved.
