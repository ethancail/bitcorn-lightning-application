import { useLayoutEffect, useRef } from "react";

// FLIP: First, Last, Invert, Play. Tracks an array of keys and animates
// each element's translateY when its DOM position changes between renders.
export function useFlip(keys: string[], elements: Map<string, HTMLElement | null>, durationMs = 500) {
  const prevPositions = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
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

    prevPositions.current = newPositions;
  }, [keys, elements, durationMs]);
}
