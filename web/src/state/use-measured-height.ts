import { useEffect, useState, type RefObject } from "react";

/**
 * The rendered height of a scroll container, for windowing maths to work from.
 *
 * Windowed lists need to know how tall their viewport is, and the easy answer —
 * a constant — is wrong on both ends of the range of screens this runs on: taller
 * than a laptop window, so the list needs two scrollbars to reach its end, and a
 * fraction of a large display, so most of the screen stays empty. Letting CSS
 * decide the height and reading it back keeps one owner of that decision.
 *
 * `ready` exists because the observed node is often rendered conditionally; the
 * ref object's identity does not change when its contents do, so the mount of the
 * element has to be named as the thing that changed.
 */
export function useMeasuredHeight(ref: RefObject<HTMLElement | null>, fallback: number, ready = true): number {
  const [height, setHeight] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!ready || !node) return;
    // Test environments and older browsers without ResizeObserver still get a
    // real height once, which beats windowing against a guess.
    if (typeof ResizeObserver === "undefined") {
      if (node.clientHeight > 0) setHeight(node.clientHeight);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.height ?? node.clientHeight;
      if (measured > 0) setHeight(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, fallback, ready]);

  return height;
}
