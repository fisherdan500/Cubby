import type { ReportStats } from "@/server/services/reports";

/**
 * A period's totals as per-day figures, each with how it moved against the period before.
 *
 * "Per day" divides by the days that have any entry, not by the calendar: a day nobody logged says
 * nothing about how much the baby slept. A figure is compared only when the earlier period logged
 * that kind of thing too, and the change is stated plainly - more or less is not better or worse,
 * so nothing here is coloured or worded as a judgement.
 */

export type StatsSummaryRow = { label: string; value: string; change: string | null };
export type StatsSummarySection = { title: string; rows: StatsSummaryRow[] };

type Kind = "duration" | "count" | "volume";

export function buildStatsSummary(current: ReportStats, previous: ReportStats | null) {
  const days = current.daysWithEntries;
  const earlier = previous && previous.daysWithEntries > 0 ? previous : null;
  const unit = current.feeding.unit;
  const sections: StatsSummarySection[] = [];
  if (!days) return { daysWithEntries: 0, sections };

  const row = (label: string, kind: Kind, now: number | null, before: number | null | undefined): StatsSummaryRow => {
    const perDay = now === null ? null : now / days;
    const earlierPerDay = before === null || before === undefined || !earlier ? null : before / earlier.daysWithEntries;
    return {
      label,
      value: perDay === null ? "Unavailable" : format(kind, perDay, unit),
      change: perDay === null || earlierPerDay === null ? null : change(kind, perDay - earlierPerDay, unit)
    };
  };

  const hadSleep = (stats: ReportStats | null) => Boolean(stats && (stats.sleep.totalSeconds > 0 || stats.sleep.naps > 0));
  if (hadSleep(current)) {
    const before = hadSleep(earlier) ? earlier : null;
    sections.push({
      title: "Sleep",
      rows: [
        row("Sleep per day", "duration", current.sleep.totalSeconds, before?.sleep.totalSeconds),
        row("Naps per day", "count", current.sleep.naps, before?.sleep.naps)
      ]
    });
  }

  if (current.feeding.count > 0) {
    const before = earlier && earlier.feeding.count > 0 ? earlier : null;
    const rows = [row("Feeds per day", "count", current.feeding.count, before?.feeding.count)];
    if (current.feeding.bottleCount > 0) {
      rows.push(row("Bottle per day", "volume", current.feeding.bottleTotal, before && before.feeding.bottleCount > 0 ? before.feeding.bottleTotal : null));
    }
    if (current.feeding.breastCount > 0) {
      rows.push(row("Breastfeeds per day", "count", current.feeding.breastCount, before && before.feeding.breastCount > 0 ? before.feeding.breastCount : null));
    }
    if (current.feeding.solidsCount > 0) {
      rows.push(row("Solids per day", "count", current.feeding.solidsCount, before && before.feeding.solidsCount > 0 ? before.feeding.solidsCount : null));
    }
    sections.push({ title: "Feeding", rows });
  }

  if (current.diaper.count > 0) {
    const before = earlier && earlier.diaper.count > 0 ? earlier : null;
    sections.push({
      title: "Diapers",
      rows: [
        row("Diapers per day", "count", current.diaper.count, before?.diaper.count),
        row("Wet per day", "count", current.diaper.wet, before?.diaper.wet),
        row("Dirty per day", "count", current.diaper.dirty, before?.diaper.dirty)
      ]
    });
  }

  if (current.pumping.total === null || current.pumping.total > 0) {
    const before = earlier && earlier.pumping.total !== null && earlier.pumping.total > 0 ? earlier.pumping.total : null;
    sections.push({ title: "Pumping", rows: [row("Pumped per day", "volume", current.pumping.total, before)] });
  }

  return { daysWithEntries: days, sections };
}

function format(kind: Kind, value: number, unit: string) {
  if (kind === "duration") return compactDuration(value);
  if (kind === "volume") return `${oneDecimal(value)} ${unit}`;
  return oneDecimal(value);
}

function change(kind: Kind, difference: number, unit: string) {
  const threshold = kind === "duration" ? 60 : 0.05;
  if (Math.abs(difference) < threshold) return "Same";
  // A true minus sign, so the change reads as a number rather than a hyphen.
  const sign = difference > 0 ? "+" : "−";
  return `${sign}${format(kind, Math.abs(difference), unit)}`;
}

function compactDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function oneDecimal(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
