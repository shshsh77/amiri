"use client";

import { Slot } from "@radix-ui/react-slot";
import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import { cn } from "@/lib/utils";

type LiquidGlassProps = ComponentPropsWithoutRef<"div"> & {
  asChild?: boolean;
  shadow?: boolean;
  bezel?: number;
  tint?: string;
};

export function LiquidGlass({
  asChild, shadow = true, bezel = 18, tint, className, style, ...props
}: LiquidGlassProps) {
  const Element = asChild ? Slot : "div";

  return (
    <Element
      {...props}
      className={cn("liquid-glass", shadow && "liquid-glass-shadow", className)}
      style={{ ...style, "--glass-bezel": `${bezel}px`, "--glass-surface": tint } as CSSProperties}
    />
  );
}
