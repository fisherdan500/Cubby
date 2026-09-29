/**
 * Shown while a server-rendered /app screen is being fetched.
 *
 * Next 14 renders nothing between a Link click and the server's answer unless the route has a
 * loading boundary. With none, navigation looked ignored: a parent taps Moments, sees the old screen
 * sit there, and taps again. This is the acknowledgement - it paints immediately on click.
 *
 * It also earns the prefetch. Next halts prefetching a dynamic route at the nearest loading
 * boundary, so before this file existed there was no boundary to prefetch to and every hop waited
 * on a cold server render.
 *
 * Deliberately a skeleton of the content area alone: the shell's sidebar, header and tabs are in the
 * layout above, stay mounted across navigation, and must not be redrawn here or the whole frame
 * would flash on every hop.
 */
export default function AppLoading() {
  return (
    <div aria-hidden="true" className="space-y-4">
      {/* aria-hidden with no status role: the pending tab in the nav is what assistive technology is
          told about, so a screen reader hears one announcement instead of two. */}
      <div className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((slot) => (
          <div key={slot} className="h-24 animate-pulse rounded-xl border border-border bg-card/60" />
        ))}
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3].map((slot) => (
          <div key={slot} className="h-14 animate-pulse rounded-lg border border-border bg-card/40" />
        ))}
      </div>
    </div>
  );
}
