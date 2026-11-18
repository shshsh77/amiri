import { useLayoutEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Grid2X2, House, Package, ShieldCheck, ShoppingCart, UserRound } from "lucide-react";
import { GlassTabBar, GlassTabBarItem } from "@/components/ui/glass-tab-bar";
import { GlassmorphismNavigation } from "@/components/ui/glassmorphism-navigation";

const tabs = [
  { route: "home", title: "Главная", Icon: House },
  { route: "shop", title: "Каталог", Icon: Grid2X2 },
  { route: "cart", title: "Корзина", Icon: ShoppingCart },
  { route: "orders", title: "Заказы", Icon: Package },
  { route: "profile", title: "Профиль", Icon: UserRound },
];

const mobileDock = document.querySelector<HTMLElement>("#mobile-navigation");
const desktopDock = document.querySelector<HTMLElement>("#desktop-navigation");
const cartBadge = document.querySelector("#cart-count");
const adminLink = document.querySelector<HTMLAnchorElement>("#admin-link");
const desktopTabs = tabs.map(({ route, title, Icon }) => ({
  route, title, href: "#" + route, icon: <Icon aria-hidden strokeWidth={2} />,
}));
const nestedRoutes: Record<string, string> = { product: "shop", help: "profile", news: "home" };

function getRoute() {
  const segment = window.location.hash.slice(1).split("/")[0];
  const route = nestedRoutes[segment] ?? segment;
  return tabs.some(tab => tab.route === route) ? route : "home";
}

function subscribeRoute(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function getCartCount() {
  return Number(cartBadge?.textContent) || 0;
}

function subscribeCart(onChange: () => void) {
  if (!cartBadge) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(cartBadge, { childList: true, characterData: true, subtree: true });
  return () => observer.disconnect();
}

function getStaffAccess() {
  return Boolean(adminLink && !adminLink.hidden);
}

function subscribeStaffAccess(onChange: () => void) {
  if (!adminLink) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(adminLink, { attributeFilter: ["hidden"] });
  return () => observer.disconnect();
}

function MobileNavigation({ route, count }: { route: string; count: number }) {
  return (
    <GlassTabBar aria-label="Разделы" value={route} onValueChange={next => { window.location.hash = next; }}>
      {tabs.map(({ route, title, Icon }) => {
        const hasCount = route === "cart" && count > 0;
        return (
          <GlassTabBarItem
            key={route}
            value={route}
            label={title}
            className="min-w-0 flex-1 px-0"
            aria-label={hasCount ? `${title}, товаров: ${count}` : undefined}
            icon={<span className="mobile-tab-icon">
              <Icon aria-hidden strokeWidth={2.15} />
              {hasCount && <b aria-hidden className="glass-cart-badge">{count > 99 ? "99+" : count}</b>}
            </span>}
          />
        );
      })}
    </GlassTabBar>
  );
}

function StoreNavigation({ desktop }: { desktop: HTMLElement }) {
  const route = useSyncExternalStore(subscribeRoute, getRoute);
  const count = useSyncExternalStore(subscribeCart, getCartCount);
  const hasStaffAccess = useSyncExternalStore(subscribeStaffAccess, getStaffAccess);
  useLayoutEffect(() => {
    document.documentElement.dataset.glassNavigation = "ready";
    return () => { delete document.documentElement.dataset.glassNavigation; };
  }, []);

  const items = hasStaffAccess
    ? [...desktopTabs, { route: "admin", title: "Админ", href: "/admin", icon: <ShieldCheck aria-hidden /> }]
    : desktopTabs;
  return (
    <>
      <MobileNavigation route={route} count={count} />
      {createPortal(<GlassmorphismNavigation items={items} active={route} cartCount={count} />, desktop)}
    </>
  );
}

if (mobileDock && desktopDock) createRoot(mobileDock).render(<StoreNavigation desktop={desktopDock} />);
