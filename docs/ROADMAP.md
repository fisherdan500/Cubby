# Cubby Roadmap

This file is the single place for approved or planned Cubby delivery work and
known implementation follow-ups. Unresolved ideas, research-derived opportunities,
and deferred candidates belong in the Cubby control plane's
`contexts/product-discovery.md`. Current behavior belongs in `README.md`,
`docs/ARCHITECTURE.md`, and `docs/DEVELOPMENT.md`.

## How To Use This File

Roadmap items are not implemented unless they are also visible in the code or
documented in the current-state docs. Keep entries short and concrete so they can
be converted into implementation plans later.

Do not add candidate items or a live parking-lot backlog here. Candidate discovery
must be resolved and explicitly approved before it is promoted into this roadmap
with a delivery status and acceptance criteria.

Use this format for each item:

```markdown
### Item Title

- Status: proposed | planned | in progress | blocked | done | parked
- Priority: high | medium | low
- Goal: One sentence describing the outcome.
- Acceptance: Short checklist of what makes the item complete.
- Notes: Constraints, dependencies, or design preferences.
```

Keep Sprout Track support limited to clean-room migration of household-owned
data. Do not pursue ongoing Sprout parity or copy code, schemas, assets, exact UI
text, credentials, route names, or implementation structure.

## Product Priority

1. Daily-use feature gaps and UX polish.
2. Always-on reliability, manual backup/restore, recovery, and deployment hardening.
3. Reports, reminders, and additional household capabilities.
4. Integrations, PWA/offline expansion, and broader self-hosting.

## Planned Next

Each substantive application change uses its own approved worktree and separate
implementation, merge, deployment, and cleanup approvals.

### Confirmed-Decision Delivery Program

- Status: active (reconciled 2026-09-22 against PR #121).
  - Accepted, with merged evidence: P0, P1.1, P1-2, P1-5, P1-6 and P1-7.
  - P1-3: Invitation Protocol v2 is merged (#64), with the accepted-state recovery guard (#65) and the recovery-code notice and cross-lineage re-invitation (#66). Ownership transfer, support access, merge and deletion remain open.
  - P1-4: every browser-operation and HTTP mutation family is covered by the disposable save-path acceptance rehearsal (#79, #83, #85–#91).
  - P1-1: host-local account verification is repaired and a one-time setup-code ownership claim was added (#100).
  - P1-5 is complete: every date and time renders in the household zone, and an invalid zone fails visibly (#103).
  - P2 activity conformance is complete: the add/edit round trip clears notes and lengths across all 14 types (#104), and one declared, versioned field matrix now ties form, validation, detail view, backup and export to a single source (#112).
  - P4 gates delivered: a performance budget harness for one- and five-year households (#105, #109), report-number coverage (#108), wider integrity checks (#111), and export correctness (#106, #110).
  - Verification is now automated rather than remembered: one `verify:gates` runner and CI on every pull request (#113), extended to the image-building rehearsals (#121).
  - Partial: P1-1, P1-3 and P1-4. Blocked: P1-8.
  - The whole-app visual rework, driven directly by the User's phone review (#114–#119), is complete; Nursery was retired as redundant rather than redesigned (see below).
  - An independent audit of #102–#122 was remediated in #135: calendar tenant links, timer shell, exact sleep pauses, report averages, spreadsheet formula exports, verification correctness, 3:1 control outlines, first-account setup with the setup code, and a working fresh-server quick start.
  - Deployment and cleanup remain separate gates.
- Priority: high
- Goal: Reconcile all confirmed product policy against the exact application tree, then deliver missing behavior in dependency order without mistaking decisions for implementation.
- Acceptance: P0 assigns every `DEC-PROD-001` through `DEC-PROD-402` an evidence-backed `implemented`, `partially implemented`, `missing`, `policy-only/no build`, or `deferred by confirmed sequence` disposition and names the smallest safe first slice; P1 establishes identity, platform/household authority, authorization, data-integrity, audit, migration, and recovery foundations; P2 completes the canonical 14-type activity contract, subtype-first field matrices, drafts, date/time controls, timers, and personal dashboard editor; P3 completes daily care coordination, handoff, caregiver coverage, shared-device, and accessibility journeys; P4 passes system-of-record reliability, integrity, performance, update, backup, host-loss, and outage-continuity gates; P5 delivers reports, schedules, reminders, and care artifacts over authoritative data; P6 adds only approved optional domain depth; P7 adds narrow capability-gated integrations and quick capture; P8 leaves optional AI, offline/PWA, and broader distribution until the local deterministic core is dependable.
- Notes: The expanded dependency model, decision anchors, exclusions, phase acceptance gates, and cross-phase definition of done are canonical in `C:\Projects\Cubby\hermes-control\contexts\implementation-roadmap.md`. P0 and P1.1 are complete in the application branch history. P1.2.1 was squash-merged through PR #23 after its bounded remediation, canonical local verification, independent review, and disposable rehearsal. A fresh post-merge exact-head review, deployment, and cutover remain separate approval gates; each later slice still requires exact-tree planning and the normal worktree/action approvals.

### Family Feed

- Status: in progress (DEC-PROD-421)
- Priority: medium
- Goal: A private family journal: everything logged for the baby as a scrollable feed, then text posts with #tags, then comments and emoji reactions, and later photos.
- Notes: Private to the household. No public sharing, followers, like counts, ranking, streaks or engagement notifications. Step 1 adds a Feed tab: every logged activity as its own card for the selected baby, newest first under household days, with header filters, opening the entry and returning to the same feed. On phones it takes the Full Log's tab, and the Full Log moves behind More, with the aim that the feed replaces it.

People see the feed as **Moments**, at `/app/moments`, because "Feed" already means feeding the baby. The tab, page title and Back links say Moments, and `/app/feed` forwards there with a temporary redirect that keeps the query string. Code, API routes and stored data keep the feed name.

Step 2 adds text posts:
- a caption about the selected baby or the whole family, with #tags taken from the text; whole-family posts appear for every baby;
- anyone but read-only members may post; authors remove their own posts, and owners, admins and parents any;
- posts sit among entries by time, under a Posts filter, and tapping a tag shows every post that carries it;
- the audit records only that a post was made or removed, never its text;
- posts are carried in backups, keeping the author's name on restore.

Step 3 adds comments, reactions and editing:
- every member, read-only members included, may comment on and react to a post or a logged entry; neither changes the entry;
- four reactions - ❤️ love, 😂 funny, 🥰 aww, 🎉 celebrate - shown with the names of who chose them, never a count. 👏 well done was retired so the row fits beside Comment on a phone; stored ones are kept but hidden;
- authors edit their own comments and posts, marked "edited"; authors remove their own comments, and owners, admins and parents any;
- the audit records what was done and what it was on, never the words;
- comments and reactions are carried in backups, by name, with the posts and entries they belong to.

Photos (DEC-PROD-422) are the first attachment type, built to the attachment rules (DEC-PROD-070, 141–147) in three steps, and switched on only after the last:
1. The attachment foundation:
   - photos are re-saved server-side at up to 2560px with location and camera data removed;
   - bytes are kept in a private store under random names, with size and checksum checked on every read;
   - photos are served only to current household members, uncached;
   - removed photos are recoverable for 30 days, then purged;
   - the audit is content-free, and the integrity check covers photo bytes and records.

   There is no user-facing change yet.
2. Photo posts, off by default:
   - the composer picks up to 10 JPEG, PNG or WebP photos, uploading each as it is chosen;
   - a post may be photos alone, and its photos appear with it or not at all;
   - cards show photos in a grid from the private address;
   - removing a post removes its photos too;
   - a "Recently removed" page brings a post and its intact photos back within 30 days;
   - a scheduled job purges expired removals and unclaimed uploads.
3. Backup and restore carry the photos, in three parts:
   - 3a: a household with photos downloads one uncompressed `.zip` (`backup.json` with a checksummed photo list, plus `photos/<id>.jpg`), and restore accepts it with every photo verified. Households without photos keep the same `.json`.
   - 3b: automated backups written as `.zip` versions (written, synced and fully read back before they count), verified photo by photo by the integrity check, streamed on download, and accepted by the update preflight; plus the `docker-data/attachments` volume, `quick-start.sh` and install notes.
   - 3c: photos switched on. An existing install needs `docker-data/attachments` owned by uid 1000 first (see the README); `enabledTypes.feed_photo` in `src/domain/attachments.ts` switches them off again if ever needed.
4. Using the photos:
   - a full-screen viewer inside Moments: swipe or tap either side to move between photos, stopping at the ends; swipe down to close; buttons that fade after two seconds;
   - Save (on a phone, through the share sheet, so an iPhone puts it in Photos) and, on a computer, Share;
   - a Photos filter gathering every post's photos into one grid, newest post first, 25 posts a page.

### Routine And Planned Schedule

- Status: in progress (DEC-PROD-420)
- Priority: medium
- Goal: Show what the baby's day actually looks like, and let caregivers write the plan they intend, printable for anyone looking after the baby.
- Notes: Step 1 (#141) rebuilt the observed Routine: wake, naps and bedtime read by time rather than position, with feed rhythm, variability, an honest not-enough-data state, and a print view labelled observed. Step 2 adds one planned schedule per baby: items at an exact time or within a window, with optional notes. It is edited on the Routine tab beside the observed routine, prints on its own, is saved against its revision, is audited without its text, and is carried in backups. Medicine and supplement items wait for their safety fields (DEC-PROD-149).

Step 3 suggests a plan from the Routine (DEC-PROD-152–154), from the selected Routine window:
- Each suggestion shows the days it rests on, how much the time moved, the days left out, and a plain confidence level.
- Too little or too varied data gives a reason, not a time.
- Nearby plan items of the same kind are shown as changes beside their current time.
- Every item starts undecided, and a preview of the whole resulting plan comes before the ordinary revision-checked save.

Tidy-up after use:
- Each Reports tab now shows only the period control it uses. Routine offers 7, 14 or 30 days, always ending today and 30 by default. Stats offers 7, 14 or 30 days, or Custom, which reveals the date boxes. Growth and Milestones have none.
- The four "at a glance" cards became one summary line in Typical day, holding only what the list cannot show: night length, nap steadiness, feed spacing and night feeds.

Later: named templates, elapsed and sequence timing, reminders, pinned or suggestible entries, and the fuller caregiver handoff (DEC-PROD-148–151).

### Nursery Night Treatment

- Status: retired (2026-09-24)
- Priority: low
- Goal: Give the Nursery screen a way to read as "night" now that the whole application is dark.
- Notes: Nursery inherited the new palette in #117 but kept its old layout, so the contrast that used to say "night" is gone. With dark as the default it duplicated the Log Entry dashboard (the same quick actions, and running timers the shell timer bar already covers), and the User judged it redundant. No night treatment was built. The screen is retired: it is gone from the sidebar and the phone's More menu, the shell timer bar now shows on every screen, and `/app/nursery` redirects to Log Entry with the selected baby so old links and home-screen shortcuts still work. The stored `nurseryModeEnabled` setting stays in the schema and backup format so older backups still restore.

## Later

### Manual Member Invitation Link Management

- Status: source delivered after full synthetic disposable acceptance, canonical gates, and exact-tree security and acceptance reviews; deployment, cutover, and live invitation use remain separately gated
- Priority: medium
- Goal: Complete the invite-first member onboarding lifecycle with administrator-managed links that Cubby generates for manual sharing but does not send.
- Acceptance: An authorized household administrator can create an invitation bound to the current household with an intended role/permission level, required intended verified recipient email, and expiration date; Cubby generates a cryptographically secure, single-use link while persisting only the token hash and never the raw token; the administrator can copy the link for manual sharing through email, SMS, or another messaging service; the recipient can follow the link, create or sign into an account, review the household invitation, and accept it; acceptance, expiration, revocation, or replacement invalidates the token; administrators can view pending invitations, copy an active link, revoke it, or generate a replacement; household binding and role-assignment rules prevent cross-household joining and unauthorized role escalation; audit information records creation, expiration, acceptance, revocation, the inviter, and the accepting member.
- Notes: Invitation protocol v2 extends the invite-first flow with fragment stripping, a guarded setup corridor, display-once manual links, replacement, recovery readiness, explicit review/acceptance, and no raw token at rest. An existing account converges invitation setup only through authenticated post-sign-in binding and keeps ordinary household access without a bound claim; re-inviting an account whose setup belongs to a different invitation now takes over onto the new invitation only once the prior one is no longer pending and unexpired, and still fails closed while the prior invitation remains active. Once an invitation setup is accepted it can no longer re-enter invitation recovery enrollment or rehearsal; that guard is required before deployment. Regenerating an existing account's recovery codes is intended and now carries an in-app notice that it invalidates any prior set. Cubby does not deliver invitations automatically; the TLS-SMTP check in disposable acceptance is synthetic transport verification only.

## Ideas / Parking Lot

Candidate entries were removed from this delivery roadmap in the approved
2026-07-17 planning-lifecycle reconciliation. Use the Cubby control plane's
`contexts/product-discovery.md` for unresolved ideas and deferred candidates. This
heading remains only as a historical redirect for earlier evidence links; it does
not contain or authorize roadmap work.

## Recently Completed

### Automated Verification Gates And Continuous Integration

- Status: done
- Priority: high
- Goal: Make every verification gate runnable from one command and run it on every pull request, so a gate cannot rot unnoticed.
- Acceptance: One runner executes the gates a person would type; every `verify:` script is classified as automated, run by hand with a stated reason, or not a gate; continuous integration drives the same runner rather than a second copy of the list; a new gate group cannot be added without a job to run it.
- Notes: Pull request #113 added `scripts/verify-gates.ts`, the `canonical` and `disposable` groups, and the first workflow. Pull request #121 added the `image` group for the rehearsals that build the application image (`backup-recovery`, `browser-operation-save-path`), which share one job so later builds reuse the first's layers; #135 added `quick-start` to that group and `platform-first-account` to the disposable group. `GATES_RUN_BY_HAND` now records why each remaining rehearsal cannot run on every pass, and a test rejects a reason amounting to "slow"; what stays out is three wall-clock budgets, one rehearsal that inspects an existing local `cubby-app` image, and one that drives Chrome over CDP. Automation immediately found real faults that hand-running had missed: a Windows-only assumption in `sprout-staging`, a stale generated artifact, and three broken rehearsals - two of which could never have passed on Linux at all (`node node_modules/esbuild/bin/esbuild` is a shim on Windows and the native binary on Linux, and a `mkdtemp` 0700 bind mount is unreadable by the image's `node` user where Docker Desktop synthesizes permissions).

### Running Timer Indicators And Whole-App Visual Rework

- Status: done (Nursery retired; see Nursery Night Treatment)
- Priority: medium
- Goal: Make a running timer legible from anywhere without crowding the dashboard, and give the application a calm, mature palette that leads with its accent.
- Acceptance: A running timer shows as an indicator rather than a control cluster; stopping is one tap from any screen and returns the caregiver where they were; the palette is tuned equally in both modes and every foreground/background pairing meets its contrast target under test.
- Notes: Pull requests #114-#119. The User chose a minimal dot indicator plus a persistent shell timer bar, with pause reserved for the activity's own screen (#114), and stopping a timer now leaves the activity by itself (#115). Cubby opens dark by default while stored `system` choices are left alone (#116). The palette rewrite (#117) is pinned by `src/styles/theme-contrast.test.ts`, which computes WCAG ratios across both modes and all five accents and found three real faults before merge. The daily summary gained an Awake Time figure measured against the day (#118, #119), which also corrected sleep from "attributed to its start day" to "the part of each sleep overlapping the day". Nursery was later retired rather than given a night treatment.

### Always-On Update And Migration Hardening

- Status: done
- Priority: high
- Goal: Make routine Cubby updates safe, observable, and recoverable on the home-server Docker deployment before changing the household's running instance.
- Acceptance: A pre-update checklist verifies backup freshness, backup-directory preservation, database health, free space, and configuration; Docker distinguishes an app container that is merely running from a Cubby application that is ready with PostgreSQL; the documented update flow covers build or pull, migration execution, startup, post-update health, and functional smoke checks; an isolated disposable rehearsal upgrades realistic existing data through the committed migration chain and verifies persistent timers, authentication, household data, automated-backup discovery, and backup download after app-container replacement; representative startup or migration failure is visible rather than falsely healthy; rollback guidance states when forward-applied migrations require verified backup recovery instead of starting an older image; the operator runbook contains no credentials or private network details.
- Notes: Implementation, isolated verification, and bounded household deployment completed on 2026-07-16. Preflight service discovery supports both legacy JSON-array output and Docker Compose 5.2 newline-delimited JSON while preserving fail-closed validation. The slice remains bounded to the existing Docker Compose home-server deployment and its operator workflow; generalized hosting, remote monitoring, remote backup providers, PWA/offline behavior, and multi-household infrastructure remain out of scope. Optional smoke writes and remaining recovery/runtime cleanup remain separately approval-gated.

### Automated Local Versioned Backups

- Status: done
- Priority: medium
- Goal: Schedule versioned backups on the home server after manual restore reliability is established.
- Acceptance: Cadence, retention, status visibility, immutable local download, and recovery instructions are defined and verified against the isolated rehearsal.
- Notes: Squash-merged in pull request #18 after 417 tests, lint, typecheck, Prisma validation, production build, a disposable PostgreSQL recovery rehearsal, and independent final review. Automation is opt-in and local-only, with sanitized status and failure visibility, immutable checksummed version 2 files, retention safety, and download-based fresh-target recovery. The feature was included in the bounded household deployment on 2026-07-16. Remote-storage credentials, providers, and application-managed encryption remain out of scope.

### Manual Backup And Restore Reliability

- Status: done
- Priority: high
- Goal: Make manual household backup and restore dependable and rehearsable before automating backups.
- Acceptance: Validation, permissions, restoration correctness, failure handling, and a repeatable restore rehearsal are verified.
- Notes: The checksummed version 2 fresh-target, non-secret snapshot and project-scoped PostgreSQL rehearsal are complete. The disposable rehearsal now also covers automated file generation, discovery, restore, re-export equivalence, retention safety, and teardown of its generated temporary backup directory. Off-device storage is not currently a Cubby responsibility.

### Secondary Workflow Mobile Audit

- Status: done
- Priority: medium
- Goal: Keep dense administrative and integration workflows usable at common phone widths while preserving tidy desktop layouts.
- Acceptance: Backups, integrations, member management, and long settings forms were checked at common mobile widths; controls remain thumb-friendly and desktop remains tidy.
- Notes: Completed in pull request #16. Automated responsive coverage is complete; real-device Safari and Chrome validation remains deferred and is not evidence claimed by this item.

### Dashboard Performance Follow-Up And Header Cleanup

- Status: done
- Priority: high
- Goal: Finish evidence-driven dashboard/general-navigation performance work and remove redundant page-header branding.
- Acceptance: Remaining dashboard and normal-page journeys have production before/after evidence; proven duplicate dashboard/header data loads are consolidated without output or timezone regressions; the `Cubby` page-header eyebrow is absent at every width while sidebar/mobile branding remains; tests, lint, typecheck, build, and responsive checks pass.
- Notes: Pull request #5 completed Full Log pagination and Full Log/Settings prefetch hardening. Squash-merged in pull request #7 after 20 test files and 99 tests, lint, typecheck, production build, independent reviews, and exact-base/candidate production and responsive evidence passed. The dashboard candidate reduced logged SQL statements from 131 to 106 and median document TTFB from 212.4 ms to 184.7 ms while preserving normalized output hashes, 100 timeline entries and return links, 14 protected navigation journeys, zero JavaScript/console errors, desktop branding, and mobile controls. Pull request #10 subsequently corrected the narrow mobile-header selector overflow found during the pull request #7 baseline and verified exact 320x568 and 375x667 viewports. The feature was included in the bounded household deployment on 2026-07-16; request-context caching remains evidence-gated.

### Reversible Baby Inactivity

- Status: done
- Priority: high
- Goal: Remove babies from active tracking without hiding or deleting their historical records.
- Acceptance: Running or paused timers block deactivation; the last active baby may be deactivated and produces a clear `No active babies` state; inactive babies cannot receive new activities or timers; historical selectors/reports retain an `Inactive` label; existing history remains correctable but cannot start/restart timers; reactivation, backups, audit records, and tests cover the lifecycle.
- Notes: Squash-merged in pull request #13 after 304 tests, lint, typecheck, Prisma validation, a production build, isolated PostgreSQL/browser acceptance, and independent immutable-tree security/correctness and product/code-quality reviews with zero blockers. Active-tracking queries and include-inactive historical queries remain distinct. Its migration and feature were included in the bounded household deployment on 2026-07-16.

### Reversible Member Suspension

- Status: done
- Priority: high
- Goal: Disable and re-enable household access without deleting credentials, membership, role, or history.
- Acceptance: The protected owner and acting member cannot be disabled; owners may manage admins and lower roles; admins may manage only lower roles; disabling revokes sessions immediately; a user whose only current memberships are suspended sees exactly `Your account is disabled.` on future valid login; another active household membership remains usable but does not grant access to the suspended household; re-enabling restores household access; server authorization, audit records, UI states, and tests cover the lifecycle.
- Notes: Squash-merged in pull request #12 after 256 tests, lint, typecheck, Prisma validation, a production build, disposable PostgreSQL/Better Auth acceptance, and independent final reviews with zero blockers. Hiding UI is not an authorization boundary; request-time enforcement, uncached session reads, and database serialization with concurrent session creation remain required in addition to session revocation. Its migration and feature were included in the bounded household deployment on 2026-07-16.

### Responsive Activity Experience Decision Gate

- Status: done
- Priority: high
- Goal: Select the production create/view/edit interaction model before changing activity forms.
- Acceptance: Three disposable responsive variants are reviewed at common phone and desktop widths; User selects one; no production activity-form code changes before selection.
- Notes: User selected Focused Routes: dedicated URL-addressable create, read-only detail, and edit pages with explicit Edit and separated confirmation-protected Delete actions.

### Read-Only Activity Detail And Selected Entry Experience

- Status: done
- Priority: high
- Goal: Give activity selection a polished read-only destination and implement the selected create/edit interaction model.
- Acceptance: Dashboard, Full Log, Calendar, and other activity-selection surfaces open detail; detail has explicit Edit and separated confirmation-protected Delete actions; create/edit return context remains correct; all 14 current types remain supported; unlimited simultaneous and same-type timers remain visible and individually controllable on Dashboard and Nursery.
- Notes: Squash-merged in pull request #10 after 232 tests, lint, typecheck, production build, exact Docker/browser acceptance, real PostgreSQL concurrency verification, and two independent final reviews with no substantive findings. Runtime coverage included all 14 activity types, owner/parent/caretaker/read-only authorization, source-aware history and hostile return paths, edit/delete workflows, keyboard/focus behavior, light/dark themes, and exact 320x568, 375x667, 390x844, 430x932, 768x1024, 1280x800, and 1280x900 viewports. Gate C corrected zero-valued feeding duration preservation, narrow-viewport overflow, malformed return paths, mutation races, focus containment, touch targets, and event-color contrast under focused regression tests. The feature was included in the bounded household deployment on 2026-07-16.

### Household And Per-Item Unit Defaults

- Status: done
- Priority: high
- Goal: Let each household choose measurement defaults and per-named-item medicine/supplement dose units without rewriting history.
- Acceptance: Volume, weight, length, and temperature defaults use `oz`, `lb`, `in`, and `°F` when unsaved; normal logging learns/reuses medicine and supplement catalog names; activity overrides do not alter defaults; new entries use defaults while edits preserve saved units; mixed-unit summaries convert correctly; Cubby backups preserve settings and older backups remain compatible.
- Notes: Squash-merged in pull request #8 after 125 tests, lint, typecheck, production build, responsive checks, static security scanning, and independent fail-closed review. The feature was included in the bounded household deployment on 2026-07-16.

### Mobile Settings Discoverability

- Status: done
- Priority: high
- Goal: Make settings and account actions obvious on phones without crowding the daily-use bottom navigation.
- Acceptance: A labeled mobile header action opens Settings, theme, and sign-out controls; the five primary bottom-navigation destinations remain unchanged; keyboard, screen-reader, common phone widths, and desktop behavior are verified.
- Notes: Implemented with existing routes and permissions and without a generalized menu framework, schema changes, or unrelated settings-page redesign. Verified with lint, type-checking, 75 tests, a production build, a Docker image and disposable runtime health check, browser interaction checks, and independent review.

### Routine Activity Visibility

- Status: done
- Priority: medium
- Goal: Let each browser choose which routine-relevant activity patterns appear in Typical Day.
- Acceptance: Routine supports Sleep, Feeding, Diaper, Pumping, Medicine, Supplement, Bath, and Play; an accessible artwork checkbox selector filters rows; the choice persists locally; Mood and other event/record types remain outside Typical Day; existing windows and permissions are preserved.
- Notes: Browser-local preference only; no schema, API, backup, or cross-device synchronization changes. Routine clock times use circular averaging so patterns spanning midnight remain accurate.

### Activity Entry Workflow And Selector Labels

- Status: done
- Priority: high
- Goal: Make shared activity create/edit workflows faster, clearer, and less error-prone on phones.
- Acceptance: High-frequency fields are immediately available; optional details are visually subordinate; numeric fields use suitable mobile keyboards; selector labels are human-readable while stored/API values remain unchanged; save state and failures are accessible; create and edit preserve their existing return context.
- Notes: Implemented in the shared activity form without changing service/API contracts, schemas, offline behavior, reminders, or navigation shape. Verified with lint, type-checking, 75 tests, a production build, a Docker image build, and disposable create/edit browser checks.

### Session Management Cleanup

- Status: done
- Priority: high
- Goal: Remove the unused trusted-device PIN and make personal session management accurate.
- Acceptance: The dead PIN model/API/UI are removed; Active Sessions has loading, stale-login, error, current-session, and revocation behavior; sign-in throttling is explained accurately.
- Notes: Historical cleanup originally retained Better Auth freshness/rate-limit defaults. The active P1-3 candidate now denies framework freshness shortcuts and disables Better Auth's in-memory limiter in favor of Cubby's database-clock account/client/deployment throttle; the complete security program remains unreleased until Phase 9.

### Soft Editorial Visual System

- Status: done
- Priority: high
- Goal: Give Cubby a calm, premium nursery character while preserving fast one-handed tracking.
- Acceptance: Light and dark semantic palettes, original activity artwork, local editorial/body fonts, household accent presets, subtle material texture, and shared shell/activity components are implemented.
- Notes: Utility actions retain conventional icons. Household appearance is owner/admin controlled and included in Cubby JSON backups.

### Mobile Daily-Use Polish

- Status: done
- Priority: high
- Goal: Make Cubby's most-used phone workflows faster to use one-handed.
- Acceptance: Mobile shell is denser, bottom navigation has active state, Log Entry prioritizes Sleep/Feed/Diaper, activity forms have grouped fields with a sticky mobile submit action, and Nursery has larger night-use controls.
- Notes: This did not add PWA/offline support, reminder logic, bottom-sheet forms, or schema changes.

### Full Log Mobile Polish

- Status: done
- Priority: medium
- Goal: Make reviewing, finding, editing, and deleting past entries easier on phone-sized screens.
- Acceptance: Full Log has compact auto-applying filters, a clear action for active filters, day-grouped entries, row-tap edit navigation, and delete returns to the same filtered list.
- Notes: This stayed UI/navigation focused and did not add date-range filtering or change service limits.

### Documentation Foundation

- Status: done
- Priority: high
- Goal: Create a concise README, architecture guide, development guide, and agent guide.
- Acceptance: `README.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, and `AGENTS.md` exist and separate current behavior from future work.
- Notes: Future feature plans should be added here instead of being mixed into current-state docs.

### Sprout Backup Import

- Status: done
- Priority: high
- Goal: Let Cubby preview and import Sprout Track backup files into the current household.
- Acceptance: Cubby accepts Sprout `.zip`, standalone `baby-tracker.db`, and `data.json` backups through the backups settings flow.
- Notes: This remains a clean-room data importer, not a raw Sprout database restore.

### Reports Routine Tab

- Status: done
- Priority: medium
- Goal: Show sleep/feed rhythm over trailing report windows.
- Acceptance: Reports include a Routine tab with `1 week`, `2 weeks`, and `1 month` windows anchored to the report end date.
- Notes: Routine calculations use existing report data and `APP_TIMEZONE`.

### Calendar Month Experience

- Status: done
- Priority: medium
- Goal: Provide a compact Cubby month calendar with event display and details.
- Acceptance: Calendar has a compact sticky month header, event markers/rows, detail expansion, and event creation.
- Notes: Future calendar changes should stay targeted unless the product direction changes.
