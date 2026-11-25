// The sidebar's width, dragged by its right edge (App.svelte) like Spark's: kept in the setting "sidebarWidth".
// Never so wide that the list and the email are squeezed: at most MAX_SHARE of the window. Unit-tested
// (test/sidebar-width.test.ts).

export const SIDEBAR_DEFAULT = 232;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;
export const MAX_SHARE = 0.34;
/** Arrow keys move it this much (Shift: more). */
export const SIDEBAR_STEP = 16;

/** A width the window has room for (whole pixels). */
export function clampSidebar(width: number, windowWidth = Infinity): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(windowWidth * MAX_SHARE)));
  const w = Number.isFinite(width) ? Math.round(width) : SIDEBAR_DEFAULT;
  return Math.min(max, Math.max(SIDEBAR_MIN, w));
}

/** The width after a key on the focused edge, or null for other keys. */
export function sidebarKey(width: number, key: string, shift = false): number | null {
  const step = shift ? SIDEBAR_STEP * 4 : SIDEBAR_STEP;
  switch (key) {
    case "ArrowLeft": return width - step;
    case "ArrowRight": return width + step;
    case "Home": return SIDEBAR_MIN;
    case "End": return SIDEBAR_MAX;
    case "Enter": return SIDEBAR_DEFAULT;
    default: return null;
  }
}
