export interface RowWindow { start: number; end: number; }

/** First row whose bottom lies below y. Offsets include the final total height. */
export function rowAt(offsets: Float64Array, y: number): number {
  let lo = 0, hi = Math.max(0, offsets.length - 1);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function rowWindow(offsets: Float64Array, top: number, height: number, overscan = 6): RowWindow {
  const count = Math.max(0, offsets.length - 1);
  return {
    start: Math.max(0, rowAt(offsets, Math.max(0, top)) - overscan),
    end: Math.min(count, rowAt(offsets, Math.max(0, top) + Math.max(0, height)) + overscan + 1),
  };
}

/** Preserve the mounted window while scrolling within the same row boundaries. */
export function stableWindow(previous: RowWindow, next: RowWindow): RowWindow {
  return previous.start === next.start && previous.end === next.end ? previous : next;
}
