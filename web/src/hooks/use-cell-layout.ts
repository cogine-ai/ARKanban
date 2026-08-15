import { useEffect, useRef, useState } from "react";
import { initialCellLayout, nextCellLayout, type CellLayout } from "../settled-layout";

export function useCellLayout() {
  const cellRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [layout, setLayout] = useState<CellLayout>({ mode: "standard", capacity: 4 });

  useEffect(() => {
    const element = cellRef.current;
    if (!element) return;
    setLayout(initialCellLayout(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (!width) return;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setLayout((current) => nextCellLayout(width, current)), 300);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, []);
  return { cellRef, layout };
}
