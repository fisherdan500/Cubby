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

Keep Sprout Track-related ideas clean-room: product behavior only, no copied
code, schemas, assets, exact UI text, credentials, route names, or implementation
structure.

## Planned Next

### Secondary Workflow Mobile Audit

- Status: planned
- Priority: medium
- Goal: Continue the mobile audit for dense administrative and integration workflows after the visual-system pass.
- Acceptance: Backups, integrations, member management, and long settings forms are checked at common mobile widths; controls remain thumb-friendly and desktop remains tidy.
- Notes: The visual-system pass covered shared theming plus the primary activity, calendar, and report surfaces. Keep future changes Cubby-original and clean-room.

## Later

No later roadmap items are currently documented.

## Ideas / Parking Lot

No parked ideas are currently documented.

## Recently Completed

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
- Goal: Provide a Sprout-adjacent month calendar with event display and details.
- Acceptance: Calendar has a compact sticky month header, event markers/rows, detail expansion, and event creation.
- Notes: Future calendar changes should stay targeted unless the product direction changes.
