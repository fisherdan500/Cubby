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
- The disposable containers and volume used for this historical baseline were removed after the approved follow-up measurements.

## Dashboard and Navigation Follow-Up — 2026-07-13

### Scope and protocol

This follow-up measured exact base commit `fd5b64c6c00acf9e6a5f81b3227607a2cdbdca44` against the uncommitted `perf/dashboard-navigation-follow-up` worktree. Both sides ran as production images in the dedicated `cubby-perf-dashboard` Compose project on loopback port 3001. The normal `cubby` project and port 3000 were not used or modified.

The comparison reused one dedicated PostgreSQL 16 volume, one generated Better Auth secret, one authenticated synthetic session, and one synthetic household containing one baby and exactly 100 mixed activities on 2026-07-13. The fixture included feeding, diaper, sleep, pumping, play, and note records plus one active sleep timer. No repository `.env`, real credential, or normal Cubby data was read or copied.

For each final side, the app container was freshly recreated, health-checked, warmed with one authenticated dashboard load, and measured with five fresh headless Edge CDP targets at 1440x900. Each target loaded the same selected baby/day with browser cache enabled. A separate 14-navigation sequence exercised two complete cycles of App → Full Log → App → Settings → App → Reports → App. PostgreSQL statement evidence used explicit start/end markers around exactly one authenticated dashboard document request, with statement logging reset immediately afterward.

### Browser document results

| Metric (five samples) | Exact base median | Candidate median | Change |
| --- | ---: | ---: | ---: |
| TTFB | 212.4 ms | 184.7 ms | -27.7 ms (-13.0%) |
| Response complete | 248.5 ms | 239.1 ms | -9.4 ms (-3.8%) |
| DOM ready | 500.1 ms | 543.0 ms | +42.9 ms (+8.6%) |
| Load | 502.3 ms | 544.8 ms | +42.5 ms (+8.5%) |
| Encoded document body | 294,004 bytes | 293,728 bytes | -276 bytes (-0.09%) |

The repeated App legs in the separate 14-navigation sequence improved from 167.65 ms to 155.40 ms median TTFB (-7.3%) and from 359.30 ms to 353.85 ms median load (-1.5%). Full Log and Settings also improved in that sequence, while the two Reports samples were slower. The five-sample document result is therefore mixed: server response timing improved, but this local run does not establish an end-to-end browser rendering improvement. The deterministic SQL reduction below is the primary performance evidence for this slice.

### PostgreSQL query-path results

One authenticated dashboard document request produced 131 logged statements on the exact base and 106 on the candidate: 25 fewer statements (-19.1%). Signature-level changes matched the intended consolidation:

| Query signature | Exact base | Candidate | Change |
| --- | ---: | ---: | ---: |
| Grouped activity count | 1 | 0 | -1 |
| Active-timer `ActivityLog` read | 2 | 1 | -1 |
| Household read | 3 | 2 | -1 |
| Household/member join | 3 | 2 | -1 |
| Baby read | 8 | 6 | -2 |
| Each activity detail relation (`BathLog` through `VaccineLog`) | 6 | 5 | -1 each across 14 relations |
| Other statements | unchanged or reduced by the consolidated call path | unchanged or reduced | no new query class |

The grouped-count query disappeared, one active-timer read disappeared, and the selected-day collection was no longer fetched twice. There were no schema, migration, index, cache, or dependency changes.

### Output-equivalence and navigation checks

- Stable snapshot comparison passed after normalizing only the live elapsed-timer badge.
- Daily-summary, active-timer, normalized main-content, complete main-link, and ordered 100-row timeline hashes matched exactly.
- Every timeline edit link preserved its selected baby/day `returnTo` target.
- The 14 navigation steps reached the expected protected routes without an authentication redirect.
- Zero JavaScript exceptions or console errors were recorded on either image.
- Both images emitted the same existing `apple-mobile-web-app-capable` deprecation warning; the candidate introduced no new warning class.

### Responsive and branding verification

| Viewport | Base document width | Candidate document width | Base → candidate eyebrow | Preserved controls | Result |
| --- | ---: | ---: | --- | --- | --- |
| 320x800 | 373 px | 373 px | hidden → absent | title, baby selector, More menu, quick actions, bottom nav | Pre-existing horizontal overflow; unchanged |
| 375x812 | 385 px | 385 px | hidden → absent | title, baby selector, More menu, quick actions, bottom nav | Pre-existing horizontal overflow; unchanged |
| 390x844 | 388 px | 388 px | hidden → absent | title, baby selector, More menu, quick actions, bottom nav | Pass; no overflow |
| 430x932 | 415 px | 415 px | hidden → absent | title, baby selector, More menu, quick actions, bottom nav | Pass; no overflow |
| 1440x900 | 1425 px | 1425 px | visible → absent | desktop `BrandLockup`, title, baby selector, quick actions, navigation | Pass; no overflow |

Visual screenshot inspection at 320, 375, 430, and 1440 pixels confirmed that the candidate removes only the redundant page-header `Cubby` eyebrow. Desktop branding, the page title, mobile selector/menu, quick actions, daily summary, active timer, timeline, and navigation remain rendered without candidate-specific overlap or clipping.

At the pull request #7 baseline, the exact-width check also found a pre-existing mobile-header minimum-width defect: both base and candidate overflowed horizontally at 320 and 375 pixels with identical document widths. It was not a regression from that worktree and remained outside the narrow performance/header slice. Pull request #10 subsequently added shrinkable mobile-header selector behavior and focused regression coverage, with exact 320x568 and 375x667 responsive acceptance.

### Safety and cleanup

- PostgreSQL statement logging was reset to `none` after each capture.
- The normal Cubby stack remained untouched throughout the benchmark.
- Cleanup verified: the disposable containers, network, PostgreSQL volume, images, browser process/profile, generated secret and cookie jar, screenshots, SQL logs, scripts, and Compose file were removed. Ports 3001 and 9223 were released, and the normal stack retained the same container identities and passed its port-3000 health check.
