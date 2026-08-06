/**
 * Per-tab memory of where the capture flow should exit to.
 *
 * testData lives only in memory, and exiting the flow wipes the store before
 * the exit navigation lands (zustand's useSyncExternalStore update flushes
 * ahead of React Router's transition), so TestRouteGuard can re-render with an
 * empty store while still mounted on a /test/* route. Two fallbacks keep that
 * render pointing at the right place:
 *
 * - the camp origin, written when a camp session starts, lets any exit or
 *   mid-session reload find its roster again;
 * - the exit destination, written the moment the operator confirms an exit,
 *   covers non-camp sessions too (their exit target is the dashboard, which
 *   must not be confused with a cold deep-link's redirect to the intake form).
 *
 * Both are consumed when a dashboard-side surface mounts. sessionStorage is
 * deliberate: "Start a new test" opens a fresh tab, which must not inherit
 * another tab's camp or exit state.
 */
const ORIGIN_KEY = 'aignosis:camp-origin';
const EXIT_KEY = 'aignosis:test-exit';

export function rememberCampOrigin(campId: string): void {
  try {
    sessionStorage.setItem(ORIGIN_KEY, campId);
  } catch {
    // Storage unavailable — the in-memory camp_id still covers the happy path.
  }
}

/** Consume the flow's per-tab state; called when a dashboard surface mounts. */
export function clearCampOrigin(): void {
  try {
    sessionStorage.removeItem(ORIGIN_KEY);
    sessionStorage.removeItem(EXIT_KEY);
  } catch {
    // ignore
  }
}

/** The store's camp_id when present, else the persisted origin. */
export function resolveCampId(campId: string | null | undefined): string | null {
  if (campId) return campId;
  try {
    return sessionStorage.getItem(ORIGIN_KEY);
  } catch {
    return null;
  }
}

/** Record where a confirmed exit is heading, ahead of the store wipe. */
export function markTestExit(destination: string): void {
  try {
    sessionStorage.setItem(EXIT_KEY, destination);
  } catch {
    // ignore — the guard then falls back to the camp origin or the intake form.
  }
}

/** The in-flight exit destination, if an exit was just confirmed. */
export function getTestExitDestination(): string | null {
  try {
    return sessionStorage.getItem(EXIT_KEY);
  } catch {
    return null;
  }
}
