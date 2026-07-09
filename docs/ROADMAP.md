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

### Mobile UX Audit And Polish

- Status: planned
- Priority: high
- Goal: Review Cubby's main workflows as a mobile-first app and make common actions faster and more intuitive on phone-sized screens.
- Acceptance: Log Entry, activity forms, Full Log, Calendar, Reports, Nursery, and Settings are checked around common mobile widths; controls are thumb-friendly, dense information remains readable, and desktop remains tidy.
- Notes: This is a design/product pass, not a signal that the current mobile UI is broken. Keep changes Cubby-original and clean-room.

## Later

No later roadmap items are currently documented.

## Ideas / Parking Lot

No parked ideas are currently documented.

## Recently Completed

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
