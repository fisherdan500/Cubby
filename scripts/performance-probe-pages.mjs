// The performance dataset ends on a fixed day, so a page asked for "today" measures an empty day once
// the calendar moves past it. The probes pin every dated page to the dataset's own last day, and fail a
// measured page that did not actually render the seeded history.

const datasetActivityLink = /\/app\/activities\/(perf_[0-9a-z]+)/g;

/** The dataset's last day as a date key. The rehearsal runs in Etc/UTC, so the UTC day is the local day. */
export function populatedDateKey(handoff) {
  const endDate = handoff?.endDate;
  if (typeof endDate !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(endDate) || Number.isNaN(Date.parse(endDate))) {
    throw new Error("performance_probe_handoff_end_date_invalid");
  }
  return endDate.slice(0, 10);
}

export function populatedDashboardPath(babyId, dateKey) {
  return `/app?${new URLSearchParams({ babyId, date: dateKey }).toString()}`;
}

/** Distinct seeded activities the page links to; ids created by the probe itself are not counted. */
export function datasetActivityCount(html) {
  return new Set(Array.from(html.matchAll(datasetActivityLink), (match) => match[1])).size;
}

export function requirePopulatedPage(path, html, minimum) {
  const count = datasetActivityCount(html);
  if (count < minimum) throw new Error(`performance_probe_page_unpopulated:${path}:${count}`);
}
