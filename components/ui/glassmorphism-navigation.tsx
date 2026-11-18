"use client";

import { useRef, type ReactNode } from "react";
import { useActiveIndicator } from "@/components/ui/glass-tab-bar-utils/use-active-indicator";

type NavigationItem = {
  route: string;
  title: string;
  href: string;
  icon: ReactNode;
};

export function GlassmorphismNavigation({
  items, active, cartCount,
}: {
  items: readonly NavigationItem[];
  active: string;
  cartCount: number;
}) {
  const track = useRef<HTMLDivElement>(null);
  const rect = useActiveIndicator(track, '[aria-current="page"]');

  return (
    <div className="desktop-glass-nav" ref={track}>
      {rect && (
        <span
          className="desktop-glass-indicator"
          aria-hidden="true"
          style={{ top: rect.top, width: rect.width, height: rect.height, transform: `translateX(${rect.left}px)` }}
        />
      )}
      {items.map(({ route, title, href, icon }) => {
        const showCount = route === "cart" && cartCount > 0;
        return (
          <a
            key={route}
            className="desktop-glass-link"
            href={href}
            aria-current={route === active ? "page" : undefined}
            aria-label={showCount ? `${title}, товаров: ${cartCount}` : undefined}
          >
            {icon}{title}
            {showCount && <span className="desktop-cart-count" aria-hidden="true">{cartCount > 99 ? "99+" : cartCount}</span>}
          </a>
        );
      })}
    </div>
  );
}
