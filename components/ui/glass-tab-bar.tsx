"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useActiveIndicator } from "@/components/ui/glass-tab-bar-utils/use-active-indicator";
import { LiquidGlass } from "@/components/ui/glass-tab-bar-utils/liquid-glass";

type TabBarContextValue = {
  value: string | undefined;
  setValue: (value: string) => void;
};

const TabBarContext = React.createContext<TabBarContextValue | null>(null);

function GlassTabBar({
  className, children, value: valueProp, defaultValue, onValueChange, ...props
}: Omit<React.ComponentProps<"nav">, "defaultValue"> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const value = valueProp ?? uncontrolled;
  const setValue = React.useCallback((next: string) => {
    if (valueProp === undefined) setUncontrolled(next);
    onValueChange?.(next);
  }, [onValueChange, valueProp]);
  const ref = React.useRef<HTMLDivElement>(null);
  const rect = useActiveIndicator(ref, '[aria-current="page"]');

  return (
    <TabBarContext.Provider value={{ value, setValue }}>
      <LiquidGlass asChild className={cn("rounded-full p-1", className)}>
        <nav data-slot="glass-tab-bar" {...props}>
          <div ref={ref} className="relative flex items-center">
            {rect && (
              <LiquidGlass
                aria-hidden
                shadow={false}
                bezel={14}
                tint="var(--glass-highlight)"
                className="glass-selection pointer-events-none absolute rounded-full transition-[transform,width] duration-500 ease-[cubic-bezier(0.34,1.3,0.64,1)] motion-reduce:transition-none"
                style={{ left: 0, top: rect.top, width: rect.width, height: rect.height, transform: `translateX(${rect.left}px)` }}
              />
            )}
            {children}
          </div>
        </nav>
      </LiquidGlass>
    </TabBarContext.Provider>
  );
}

function GlassTabBarItem({
  className, value, icon, label, onClick, ...props
}: React.ComponentProps<"button"> & {
  value: string;
  icon: React.ReactNode;
  label: string;
}) {
  const ctx = React.useContext(TabBarContext);
  const active = ctx?.value === value;

  return (
    <button
      {...props}
      type="button"
      data-slot="glass-tab-bar-item"
      aria-current={active ? "page" : undefined}
      onClick={event => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx?.setValue(value);
      }}
      className={cn(
        "relative z-10 flex h-14 min-w-18 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-full px-3 text-[10px] font-semibold tracking-[0.01em] transition-[color,transform] duration-300 active:scale-95 [&_svg]:size-6",
        className,
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export { GlassTabBar, GlassTabBarItem };
export default GlassTabBar;
