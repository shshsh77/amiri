import { useLayoutEffect, useState, type RefObject } from "react";

type IndicatorRect = { left: number; top: number; width: number; height: number };

export function useActiveIndicator(ref: RefObject<HTMLDivElement | null>, selector: string) {
  const [rect, setRect] = useState<IndicatorRect | null>(null);

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;

    const measure = () => {
      const active = container.querySelector<HTMLElement>(selector);
      if (!active?.offsetWidth) {
        setRect(null);
        return;
      }
      const next = {
        left: active.offsetLeft,
        top: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight,
      };
      setRect(previous => previous?.left === next.left && previous.top === next.top &&
        previous.width === next.width && previous.height === next.height ? previous : next);
    };

    const mutations = new MutationObserver(measure);
    mutations.observe(container, { subtree: true, childList: true, attributeFilter: ["aria-current"] });
    const resize = new ResizeObserver(measure);
    resize.observe(container);
    for (const child of container.querySelectorAll(":scope > a, :scope > button")) resize.observe(child);
    measure();
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, [ref, selector]);

  return rect;
}
