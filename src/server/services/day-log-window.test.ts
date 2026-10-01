/**
 * Which activities a day's log shows.
 *
 * An overnight sleep started at 8pm and ended at 8am never appeared on the morning's log, because
 * the query filtered on the moment an activity was recorded rather than the time it covers. The
 * family had to page back to yesterday to find out when the baby woke.
 */
import { describe, expect, it } from "vitest";

import { dayLogWhere } from "./dashboard";

const dayStart = new Date("2026-09-28T04:00:00.000Z"); // Sep 28 00:00 EDT
const dayEnd = new Date("2026-09-29T04:00:00.000Z");

describe("which activities a day's log asks for", () => {
  it("asks for anything overlapping the day, not only what was recorded in it", () => {
    const where = dayLogWhere({ start: dayStart, end: dayEnd });

    // An activity is on the day when it starts before the day ends and has not already finished
    // before the day begins. The recorded moment alone is what made overnight sleeps vanish.
    expect(where).toEqual({
      OR: [
        { occurredAt: { gte: dayStart, lt: dayEnd } },
        {
          startedAt: { lt: dayEnd },
          endedAt: { gt: dayStart }
        }
      ]
    });
  });

  it("does not reach for a still-running activity from a later day", () => {
    // endedAt: { gt } excludes nulls in Prisma, so a running timer is only ever on its own day.
    const where = dayLogWhere({ start: dayStart, end: dayEnd });
    const spanning = where.OR[1] as { endedAt: { gt: Date } };
    expect(spanning.endedAt).toEqual({ gt: dayStart });
    expect("equals" in spanning.endedAt).toBe(false);
  });
});
