# Cubby Roadmap

This file is the single place for future Cubby product work, known follow-ups,
and parked ideas. Current behavior belongs in `README.md`,
`docs/ARCHITECTURE.md`, and `docs/DEVELOPMENT.md`.

## How To Use This File

Roadmap items are not implemented unless they are also visible in the code or
documented in the current-state docs. Keep entries short and concrete so they can
be converted into implementation plans later.

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

These items implement the approved daily-use roadmap in dependency order. Each
substantive application change uses its own approved worktree and separate merge,
deployment, and cleanup approvals.

### Dashboard Performance Follow-Up And Header Cleanup

- Status: planned
- Priority: high
- Goal: Finish evidence-driven dashboard/general-navigation performance work and remove redundant page-header branding.
- Acceptance: Remaining dashboard and normal-page journeys have production before/after evidence; proven duplicate dashboard/header data loads are consolidated without output or timezone regressions; the `Cubby` page-header eyebrow is absent at every width while sidebar/mobile branding remains; tests, lint, typecheck, build, and responsive checks pass.
- Notes: Pull request #5 already completed Full Log pagination and Full Log/Settings prefetch hardening. Do not add request-context caching unless post-consolidation measurements justify it.

### Reversible Member Suspension

- Status: in progress
- Priority: high
- Goal: Disable and re-enable household access without deleting credentials, membership, role, or history.
- Acceptance: The protected owner and acting member cannot be disabled; owners may manage admins and lower roles; admins may manage only lower roles; disabling revokes sessions immediately; a user whose only current memberships are suspended sees exactly `Your account is disabled.` on future valid login; another active household membership remains usable but does not grant access to the suspended household; re-enabling restores household access; server authorization, audit records, UI states, and tests cover the lifecycle.
- Notes: Isolated implementation and verification are complete, and the feature branch is published pending pull-request approval. Hiding UI is not an authorization boundary; request-time enforcement, uncached session reads, and database serialization with concurrent session creation are required in addition to session revocation. Merge, migration, and deployment remain separately gated.

### Reversible Baby Inactivity

- Status: in progress
- Priority: high
- Goal: Remove babies from active tracking without hiding or deleting their historical records.
- Acceptance: Running or paused timers block deactivation; the last active baby may be deactivated and produces a clear `No active babies` state; inactive babies cannot receive new activities or timers; historical selectors/reports retain an `Inactive` label; existing history remains correctable but cannot start/restart timers; reactivation, backups, audit records, and tests cover the lifecycle.
- Notes: Active-tracking queries and include-inactive historical queries must remain distinct. This worktree contains the implementation in source; merge and deployment remain separately gated.

## Later

### Secondary Workflow Mobile Audit

- Status: planned
- Priority: medium
- Goal: Continue the mobile audit for dense administrative and integration workflows after the approved daily-use roadmap.
- Acceptance: Backups, integrations, member management, and long settings forms are checked at common mobile widths; controls remain thumb-friendly and desktop remains tidy.
- Notes: Resume after the daily-use performance, activity, units, member-suspension, and baby-inactivity phases. Keep future changes Cubby-original and clean-room.

### Manual Backup And Restore Reliability

- Status: planned
- Priority: high
- Goal: Make manual household backup and restore dependable and rehearsable before automating backups.
- Acceptance: Validation, permissions, restoration correctness, failure handling, and a repeatable restore rehearsal are verified.
- Notes: Automated versioned backups stored on the home server follow later; off-device storage is not currently a Cubby responsibility.

### Automated Local Versioned Backups

- Status: proposed
- Priority: medium
- Goal: Schedule versioned backups on the home server after manual restore reliability is established.
- Acceptance: Cadence, retention, status visibility, and recovery instructions are defined and verified.
- Notes: Do not add remote-storage credentials or providers without separate approval.

### Manual Member Invitation Link Management

- Status: planned
- Priority: medium
- Goal: Complete the invite-first member onboarding lifecycle with administrator-managed links that Cubby generates for manual sharing but does not send.
- Acceptance: An authorized household administrator can create an invitation bound to the current household with an intended role/permission level, optional recipient email, and expiration date; Cubby generates a cryptographically secure, single-use link while persisting only the token hash and never the raw token; the administrator can copy the link for manual sharing through email, SMS, or another messaging service; the recipient can follow the link, create or sign into an account, review the household invitation, and accept it; acceptance, expiration, revocation, or replacement invalidates the token; administrators can view pending invitations, copy an active link, revoke it, or generate a replacement; household binding and role-assignment rules prevent cross-household joining and unauthorized role escalation; audit information records creation, expiration, acceptance, revocation, the inviter, and the accepting member.
- Notes: Extend the existing invite-first flow rather than creating a second onboarding model. The link-copy and replacement design must preserve the no-raw-token-at-rest rule. Cubby does not deliver invitations in the initial implementation; automated transactional email plus optional SMTP or provider integration are separate later enhancements.

## Ideas / Parking Lot

- Configurable timer alerts, scheduled reminders, and pattern warnings: low priority until core usability and reliability are complete.
- PWA/offline expansion: preserve a future path, but do not add offline writes, synchronization, or conflict handling now.
- Dedicated integrations: wait for a concrete household use case; retain generic API keys and webhooks.
- Broader multi-household/self-hosting productization: possible later, not current scope.

## Recently Completed

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
- Notes: Squash-merged in pull request #10 after 232 tests, lint, typecheck, production build, exact Docker/browser acceptance, real PostgreSQL concurrency verification, and two independent final reviews with no substantive findings. Runtime coverage included all 14 activity types, owner/parent/caretaker/read-only authorization, source-aware history and hostile return paths, edit/delete workflows, keyboard/focus behavior, light/dark themes, and exact 320x568, 375x667, 390x844, 430x932, 768x1024, 1280x800, and 1280x900 viewports. Gate C corrected zero-valued feeding duration preservation, narrow-viewport overflow, malformed return paths, mutation races, focus containment, touch targets, and event-color contrast under focused regression tests. Deployment remains separately approval-gated.

### Household And Per-Item Unit Defaults

- Status: done
- Priority: high
- Goal: Let each household choose measurement defaults and per-named-item medicine/supplement dose units without rewriting history.
- Acceptance: Volume, weight, length, and temperature defaults use `oz`, `lb`, `in`, and `°F` when unsaved; normal logging learns/reuses medicine and supplement catalog names; activity overrides do not alter defaults; new entries use defaults while edits preserve saved units; mixed-unit summaries convert correctly; Cubby backups preserve settings and older backups remain compatible.
- Notes: Squash-merged in pull request #8 after 125 tests, lint, typecheck, production build, responsive checks, static security scanning, and independent fail-closed review. Deployment remains separately approval-gated.

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
- Notes: Cubby retains Better Auth's 10-minute freshness check and three-requests-per-10-seconds production throttle.

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
