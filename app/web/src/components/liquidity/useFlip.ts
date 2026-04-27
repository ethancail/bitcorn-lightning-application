import { useLayoutEffect, useRef } from "react";

// FLIP: First, Last, Invert, Play. Tracks an array of keys and animates
// each element's translateY when its DOM position changes between renders.
//
// Note: keys array is intentionally recreated each render (not memoized)
// so the effect re-runs and re-measures positions every render. The inner
// prevTop/newTop diff prevents wasted work when nothing has moved.
export function useFlip(keys: string[], elements: Map<string, HTMLElement | null>, durationMs = 500) {
  const prevPositions = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    // Snapshot any in-flight transforms and temporarily clear them so we
    // measure the *natural* DOM position, not the visually-translated one.
    // Without this, a fast double-refresh would record stale translated
    // coordinates as "previous" and cause oscillation on the next refresh.
    const snapshots = new Map<string, string>();
    for (const key of keys) {
      const el = elements.get(key);
      if (!el) continue;
      snapshots.set(key, el.style.transform);
      if (el.style.transform) {
        el.style.transition = "none";
        el.style.transform = "";
      }
    }

    // Measure new positions (now reflecting natural layout, not in-flight transforms).
    const newPositions = new Map<string, number>();
    for (const key of keys) {
      const el = elements.get(key);
      if (el) newPositions.set(key, el.getBoundingClientRect().top);
    }

    // First pass: compute deltas vs previous positions; if changed, prime the inverted transform.
    for (const key of keys) {
      const el = elements.get(key);
      if (!el) continue;
      const prevTop = prevPositions.current.get(key);
      const newTop = newPositions.get(key);
      if (prevTop !== undefined && newTop !== undefined && prevTop !== newTop) {
        const delta = prevTop - newTop;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
      } else {
        // No movement — restore whatever transform was snapshotted (likely empty).
        const snapshot = snapshots.get(key);
        if (snapshot !== undefined) el.style.transform = snapshot;
      }
    }

    // Second pass (next frame): release the transform with a transition so the row slides into place.
    requestAnimationFrame(() => {
      for (const key of keys) {
        const el = elements.get(key);
        if (!el) continue;
        if (el.style.transform) {
          el.style.transition = `transform ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
          el.style.transform = "";
        }
      }
    });

    // Update prev to the new measurements; drop entries for keys no longer present.
    const nextPrev = new Map<string, number>();
    const keySet = new Set(keys);
    for (const [k, v] of newPositions) {
      if (keySet.has(k)) nextPrev.set(k, v);
    }
    prevPositions.current = nextPrev;
  }, [keys, elements, durationMs]);
}
