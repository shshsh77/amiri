const icons = {
  home: '<path d="M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5M10 20v-6h4v6"/>',
  shop: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  cart: '<path d="M3 4h2.2l2.3 10.5h10.2L20 7.5H6.4"/><circle cx="9.2" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
  orders: '<path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8m-4.5-15.5 9 5"/>',
  help: '<path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.6A8.4 8.4 0 1 1 21 11.5zM9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.6-2.4 2.2-2.4 3.4M12 16.5h.01"/>',
  admin: '<path d="M12 2.8 4.5 6v5c0 4.7 2.8 8 7.5 10.1 4.7-2.1 7.5-5.4 7.5-10.1V6zM9 11.7l2.1 2 4-4"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.4-3.9 4.3-5.8 7.5-5.8s6.1 1.9 7.5 5.8"/>',
  info: '<circle cx="12" cy="6.6" r="1.6" fill="currentColor" stroke="none"/><path d="M10.2 10.6h1.9v7.2M10 17.8h4.2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  pod: '<rect x="8" y="5" width="8" height="16" rx="3"/><path d="M10 5V3h4v2m-2 10v2"/>',
  drop: '<path d="M12 3c2 4 6 7.5 6 12a6 6 0 0 1-12 0c0-4.5 4-8 6-12Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  tin: '<ellipse cx="12" cy="8" rx="8" ry="3.5"/><path d="M4 8v8c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V8"/>',
  device: '<rect x="7" y="7" width="10" height="14" rx="3"/><path d="M10 7V3h4v4m-3 9h2"/>',
};

function icon(name, size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

let categories = [];
const { lineKey, minimumOrderTotal, topProductLimit } = window.AMIRI_CATALOG;
const categoryIcons = ["pod", "drop", "tin", "device"];
const channelUrl = "https://t.me/amirivape1";
const managerUrl = "https://t.me/amirivapemanager1";
const locations = [
  "ул. Пушкинская, 233",
  "ул. Коммунаров, 214",
  "ул. Молодёжная, 10Б",
];
let products = [];

const questions = [
  ["Как узнать часы работы точки?", "Уточните часы работы нужного магазина у менеджера в Telegram."],
  ["Где смотреть статус заказа?", "Откройте «Заказы» после входа через Telegram."],
  ["Можно изменить или отменить заказ?", "Свяжитесь с менеджером и укажите номер заказа."],
];

const view = document.querySelector("#view");
const panel = document.querySelector("#panel");
const purchaseCelebration = document.querySelector("#purchase-celebration");
const account = document.querySelector("#account");
const userName = document.querySelector("#user-name");
const cartCount = document.querySelector("#cart-count");
const cartbar = document.querySelector("#cartbar");
const tabs = [...document.querySelectorAll("[data-tab]")];
let byId = new Map();
let variantsByLine = new Map();
let cartKey = "";
const rubles = new Intl.NumberFormat("ru-RU");
const money = amount => `${rubles.format(amount)} ₽`;
const catalogPrice = ({ price, variablePrice }) => price === null
  ? "Цена уточняется" : `${variablePrice ? "от " : ""}${money(price)}`;
const productBadges = new Map([["new", "Новинка"], ["restock", "Пополнение"]]);
const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = text => String(text).replace(/[&<>"]/g, char => entities[char]);
const formatTitle = title => escapeHtml(title).replace(/\(([^()]+)\)/g, match => match.replaceAll(" ", "\u00a0"));
const normalize = text => text.toLowerCase().replaceAll("ё", "е").trim();
const orderLabels = { forming: "Заказ формируется", new: "Новый", accepted: "Принят", packing: "На сборке", shipped: "Отправлен", completed: "Завершён", cancelled: "Отменён" };

let selected = "new";
let topProducts = [];
let productBack = "#shop";
let cart = {};
let returnedOrders = new Set();
let returnedTitles = new Map();
let serverUser = null;
let ordersList = [];
let storefrontLoaded = false;
let checkingSession = location.protocol !== "file:";
let storefrontRequest = 0;
let checkoutPending = false;
let cartNotice = "";
let checkoutError = "";
let storefrontError = "";
let pendingOrder = null;
let checkoutDelivery;
let orderActionPending = false;
let orderActionError = "";
let serverClockOffset = 0;

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function saveCart() {
  try {
    localStorage.setItem(cartKey, JSON.stringify({ items: cart, returned: [...returnedOrders], titles: Object.fromEntries(returnedTitles) }));
  } catch {}
}

function savePending(value) {
  pendingOrder = value;
  try {
    if (value) localStorage.setItem(cartKey + "-pending", JSON.stringify(value));
    else localStorage.removeItem(cartKey + "-pending");
  } catch {}
}

function restoreCart(key) {
  const saved = readLocal(key);
  const hasReturns = Array.isArray(saved?.returned);
  returnedOrders = new Set(hasReturns ? saved.returned.filter(Number.isSafeInteger) : []);
  returnedTitles = new Map(Object.entries(saved?.titles ?? {}).filter(([, title]) => typeof title === "string"));
  const items = hasReturns ? saved.items : saved;
  return Object.fromEntries(Object.entries(items ?? {}).filter(([id, quantity]) =>
    /^[a-z0-9-]{1,64}$/.test(id) && Number.isSafeInteger(quantity) && quantity > 0 && (quantity <= 999 || returnedTitles.has(id))));
}

function photo(product) {
  const image = product.image
    ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy" decoding="async">` : "";
  return `<span class="photo" aria-hidden="true">${icon(categoryIcons[product.category] || "orders", 34)}${image}</span>`;
}

function productCard(product, { home = false, rank } = {}) {
  const available = product.stock > 0;
  const badge = product.badge === "restock" && !available ? undefined : productBadges.get(product.badge);
  return `<button class="product-card${home ? " shelf-card" : ""}" type="button" data-product="${product.id}">
    <span class="product-media">
      ${photo(product)}
      ${rank ? `<span class="product-rank" data-rank="${rank}">${rank}</span>` : ""}
      ${badge ? `<span class="product-badge product-badge-${product.badge}">${badge}</span>` : ""}
    </span>
    <span class="product-copy">
      <span class="title">${formatTitle(product.title)}</span>
      ${home ? "" : `<span class="product-meta">
        <strong>${catalogPrice(product)}</strong>
        <span class="product-stock${available ? " is-available" : ""}">${available ? "В наличии" : "Нет в наличии"}</span>
      </span>`}
    </span>
    <span class="product-footer">Подробнее ${icon("chevron", 16)}</span>
  </button>`;
}

function panelIcon(name) {
  return `<span class="panel-icon" aria-hidden="true">${icon(name, 24)}</span>`;
}

function manager() {
  return `<div class="info manager">
    ${panelIcon("help")}
    <div><b>Менеджер AMIRI VAPE</b><p>@amirivapemanager1</p></div>
    <a class="button" href="${managerUrl}" target="_blank" rel="noopener noreferrer">Написать</a>
  </div>`;
}

function highlights() {
  let items;
  let emptyText;
  if (selected === "mine") {
    const counts = new Map();
    for (const order of ordersList) {
      if (order.state !== "completed") continue;
      for (const item of order.items) {
        const product = byId.get(item.id);
        if (!product) continue;
        const key = lineKey(product);
        counts.set(key, (counts.get(key) || 0) + item.quantity);
      }
    }
    items = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => variantsByLine.get(key)[0]);
    emptyText = "Здесь появятся позиции из ваших завершённых заказов.";
  } else if (selected === "top") {
    items = topProducts.map(id => byId.get(id)).filter(Boolean);
    emptyText = "Топ появится после первых завершённых заказов.";
  } else {
    items = products.slice().reverse();
    emptyText = "Новинки появятся после обновления каталога.";
  }
  return items.length ? `<div class="product-row" tabindex="0" role="region" aria-label="Подборка товаров">
    ${linesFor(items).slice(0, selected === "top" ? topProductLimit : 12).map((product, index) => productCard(product, {
      home: true, rank: selected === "top" ? index + 1 : undefined,
    })).join("")}
  </div>`
    : `<p class="empty-selection">${escapeHtml(storefrontError || emptyText)}</p>`;
}

function home() {
  const selections = [["new", "Новинки"], ["top", "Топ за 30 дней"], ["mine", "Вы берёте"]];
  const name = serverUser?.firstName || serverUser?.username;
  return `<section class="hero">
    <span class="hero-watermark" aria-hidden="true">AMIRI VAPE</span>
    <img class="hero-visual" src="/assets/amiri-logo.svg" width="527" height="536" alt="" fetchpriority="high">
    <div class="hero-copy">
      <p class="hero-brand"><img src="/assets/amiri-logo.svg" width="30" height="30" alt=""> AMIRI VAPE</p>
      <h1>Здравствуйте${name ? `, <span>${escapeHtml(name)}</span>` : ""}</h1>
    </div>
  </section>
  <section class="home-collection" aria-label="Подборки товаров">
  <div class="highlights" role="group" aria-label="Подборки">${selections.map(([id, label]) =>
    `<button type="button" data-selection="${id}" aria-pressed="${selected === id}">${label}</button>`).join("")}</div>
  <div id="highlight-results">${highlights()}</div>
  </section>
  <div class="home-support">
    <a class="info" href="#help">${panelIcon("orders")}<div><b>Первый заказ</b><p>Как оформить заказ и проверить его статус</p></div>${icon("chevron", 16)}</a>
    ${manager()}
  </div>`;
}

const plurals = new Intl.PluralRules("ru");
const countLabel = (count, forms) => `${count} ${forms[plurals.select(count)] || forms.many}`;
const lineCount = count => countLabel(count, { one: "линейка", few: "линейки", many: "линеек" });
const brandCount = count => countLabel(count, { one: "бренд", few: "бренда", many: "брендов" });
const categoryTitle = id => categories.find(category => category.id === id)?.title || "";
const hashParts = () => location.hash.slice(1).split("/");
const lineKeys = items => new Set(items.map(lineKey));

function linesFor(items) {
  return [...lineKeys(items)].map(key => {
    const variants = variantsByLine.get(key);
    const cover = variants.find(variant => variant.image) || variants[0];
    const prices = variants.map(variant => variant.price).filter(price => price !== null);
    const price = prices.reduce((lowest, amount) => Math.min(lowest, amount), prices[0] ?? null);
    return {
      ...cover, title: cover.line || cover.title, price,
      variablePrice: prices.some(amount => amount !== price),
      stock: variants.reduce((stock, variant) => stock + variant.stock, 0),
      badge: variants.some(variant => variant.badge === "new") ? "new"
        : variants.some(variant => variant.badge === "restock" && variant.stock > 0) ? "restock" : "",
    };
  });
}

function groupBrands(items) {
  const groups = new Map();
  for (const product of items) {
    const title = product.brand || "Другие товары";
    const key = product.brand ? "b-" + encodeURIComponent(normalize(product.brand)) : "other";
    if (!groups.has(key)) groups.set(key, { key, title, items: [] });
    groups.get(key).items.push(product);
  }
  return [...groups.values()];
}

function catalogBanner({ title, href, detail, category, banner, image }) {
  return `<a class="catalog-banner" href="${href}">
    <span class="banner-art" aria-hidden="true">
      ${icon(categoryIcons[category] || "orders", 46)}
      ${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async">` : ""}
    </span>
    ${banner ? `<img class="banner-image" src="${escapeHtml(banner)}" alt="" loading="lazy" decoding="async">` : ""}
    <span class="banner-heading"><small>AMIRI VAPE</small><strong>${escapeHtml(title)}</strong></span>
    <span class="banner-count">${detail}</span>
  </a>`;
}

function shop() {
  if (!storefrontLoaded) {
    const status = storefrontError || (checkingSession || serverUser ? "Загружаем каталог…" : "Войдите, чтобы посмотреть каталог.");
    return `<header class="section-title"><h1>Каталог</h1></header>
      <p class="empty-selection" role="status">${escapeHtml(status)}</p>
      ${storefrontError && serverUser ? '<button type="button" class="button ghost" data-refresh-store>Обновить</button>' : ""}`;
  }
  const [, id, brandKey] = hashParts();
  const category = categories.find(category => String(category.id) === id);
  const items = category ? products.filter(product => product.category === category.id) : products;
  const groups = category ? groupBrands(items) : [];
  const activeBrand = groups.find(group => group.key === brandKey);
  const title = activeBrand?.title || category?.title || "Каталог";
  const displayedItems = activeBrand?.items || items;
  const displayedLines = linesFor(displayedItems);
  let results;
  if (!category) {
    results = `<div class="category-grid">${categories.map(({ id, title, image }) => {
      const lines = products.filter(product => product.category === id);
      const brands = groupBrands(lines).filter(group => group.key !== "other").length;
      const summary = lineCount(lineKeys(lines).size);
      return catalogBanner({
        title, category: id, href: `#shop/${id}`, banner: image,
        image: lines.find(product => product.image)?.image,
        detail: brands ? `${brandCount(brands)} · ${summary}` : summary,
      });
    }).join("")}</div>`;
  } else if (!activeBrand && groups.some(group => group.key !== "other")) {
    results = `<div class="category-grid">${groups.map(group => catalogBanner({
      title: group.title, category: category.id, href: `#shop/${category.id}/${group.key}`,
      image: group.items.find(product => product.image)?.image, detail: lineCount(lineKeys(group.items).size),
    })).join("")}</div>`;
  } else {
    results = displayedLines.length
      ? `<div class="catalog-grid">${displayedLines.map(product => productCard(product)).join("")}</div>`
      : `<p class="empty-selection">${escapeHtml(storefrontError || "В этой категории пока нет товаров.")}</p>`;
  }
  return `<div class="search">
    <button type="button" class="search-trigger" data-open-search>${icon("search", 20)} Бренд, вкус или линейка</button>
  </div>
  ${category ? `<nav class="catalog-breadcrumb" aria-label="Путь в каталоге">
    <a class="catalog-crumb-pill" href="#shop">Каталог</a>${icon("chevron", 13)}
    ${activeBrand ? `<a class="catalog-crumb-pill" href="#shop/${category.id}">${escapeHtml(category.title)}</a>
      ${icon("chevron", 13)}<span class="catalog-crumb-pill" aria-current="page">${escapeHtml(activeBrand.title)}</span>`
      : `<span class="catalog-crumb-pill" aria-current="page">${escapeHtml(category.title)}</span>`}
  </nav>` : ""}
  <header class="section-title"><h1>${escapeHtml(title)}</h1><span>${lineCount(displayedLines.length)}</span></header>
  ${results}`;
}

function quantityControls(product, quantity) {
  const limit = Math.min(999, product.stock ?? 999);
  const locked = checkoutPending || pendingOrder;
  return `<div class="stepper" data-quantity-item="${product.id}" role="group" aria-label="Количество">
    <button type="button" data-quantity="-1" data-item="${product.id}" aria-label="Убавить количество" ${quantity && !locked ? "" : "disabled"}>−</button>
    <output>${quantity}</output>
    <button type="button" data-quantity="1" data-item="${product.id}" aria-label="Увеличить количество" ${quantity >= limit || locked ? "disabled" : ""}>+</button>
  </div>`;
}

function cartLines() {
  return Object.entries(cart).map(([id, quantity]) => {
    const product = byId.get(id) || { id, title: returnedTitles.get(id), stock: 0 };
    const available = product.price == null ? 0 : Math.min(999, product.stock);
    return { product, quantity, available };
  }).filter(({ product }) => product.title);
}

const cartTotal = lines => lines.reduce((total, { product, quantity, available }) =>
  total + (quantity <= available ? quantity * product.price : 0), 0);

function cartPage() {
  const items = cartLines();
  if (!items.length && !pendingOrder) {
    return `<div class="narrow empty">${panelIcon("cart")}<h1>Корзина пока пустая</h1>
      ${checkoutError || storefrontError || cartNotice ? `<p role="status">${escapeHtml(checkoutError || storefrontError || cartNotice)}</p>` : ""}
      <a class="button" href="#shop">Перейти в каталог</a><a class="button ghost" href="#home">Новинки на главной</a></div>`;
  }
  return `<div class="narrow">
    <a class="crumbs" href="#shop">‹ В каталог</a><h1 class="heading">Корзина</h1><p class="subtitle" data-cart-quantity>${cartQuantity()} шт.</p>
    <div class="list">${items.map(({ product, quantity, available }) => {
      const title = [product.line, product.title].filter(Boolean).join(" · ");
      const status = cartLineStatus({ product, quantity, available });
      const remove = !available && !checkoutPending && !pendingOrder
        ? `<button type="button" class="button ghost" data-quantity="${-quantity}" data-item="${product.id}">Убрать</button>` : "";
      return `<article class="cart-item" data-cart-item="${product.id}">${photo(product)}<div><b>${escapeHtml(title)}</b><p data-cart-line-status>${status}</p></div>
        ${remove || quantityControls(product, quantity)}</article>`;
    }).join("")}</div>
    <div data-cart-summary>${cartSummary(items)}</div>
  </div>`;
}

function cartLineStatus({ product, quantity, available }) {
  if (quantity <= available) return money(product.price * quantity);
  return available ? `Доступно ${available} шт.` : `Сейчас недоступно · ${quantity} шт. в корзине`;
}

function cartSummary(items) {
  const total = cartTotal(items);
  const unavailable = items.some(({ quantity, available }) => quantity > available);
  const canSubmit = !checkoutPending && (pendingOrder || (storefrontLoaded && !unavailable && total >= minimumOrderTotal));
  return `<div class="cart-total"><b>Итого</b><b>${money(total)}</b></div>
    ${!pendingOrder && unavailable ? '<p class="cart-demo">Уберите недоступные позиции или уменьшите количество до остатка.</p>' :
      !pendingOrder && total < minimumOrderTotal ? `<p class="cart-demo">Минимальная сумма заказа — ${money(minimumOrderTotal)}. Добавьте ещё на ${money(minimumOrderTotal - total)}.</p>` : ""}
    ${serverUser ? `<div class="cart-checkout"><button class="button" type="button" data-checkout ${canSubmit ? "" : "disabled"}>
      ${checkoutPending ? "Оформляем…" : pendingOrder ? "Проверить оформление" : "Оформить заказ"}</button></div>
      <p class="cart-demo" role="status">${escapeHtml(checkoutError || storefrontError || cartNotice)}</p>`
      : '<a class="button" href="/login">Войти через Telegram</a>'}
  `;
}

function orders() {
  if (!serverUser) {
    return `<div class="narrow empty">${panelIcon("orders")}<h1>Мои заказы</h1>
      <p>Войдите через Telegram, чтобы посмотреть заказы.</p><a class="button" href="/login">Войти через Telegram</a></div>`;
  }
  if (ordersList.length || storefrontError) {
    return `<div class="narrow"><h1 class="heading">Мои заказы</h1>
      <button type="button" class="button ghost" data-refresh-store>Обновить</button>
      ${storefrontError ? `<p class="cart-demo" role="status">${escapeHtml(storefrontError)}</p>` : ""}
      ${orderActionError ? `<p class="cart-demo" role="alert">${escapeHtml(orderActionError)}</p>` : ""}
      <div class="list">${ordersList.map(customerOrderCard).join("")}</div></div>`;
  }
  return `<div class="narrow"><h1 class="heading">Мои заказы</h1><div class="empty">
    ${panelIcon("orders")}<h2>Заказов пока нет</h2>
    <p>Соберите первый заказ в каталоге — статус будет виден здесь</p><a class="button" href="#shop">В каталог</a>
  </div></div>`;
}

const secondsLeft = deadline => Math.max(0, Math.ceil((deadline - Date.now() - serverClockOffset) / 1000));
const timeLeft = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function customerOrderCard(order) {
  const remaining = secondsLeft(order.editableUntil);
  const state = order.state === "forming" && !remaining ? "new" : order.state;
  return `<article class="admin-order order-customer">
    <header><h3>Заказ №${order.id} · ${money(order.total)}</h3><span class="access">${orderLabels[state]}</span></header>
    ${order.delivery ? `<p class="admin-order-info">Получатель: ${escapeHtml(order.delivery.fullName)}</p>
      <p class="admin-order-info">СДЭК №${escapeHtml(order.delivery.pointNumber)} · ${escapeHtml(order.delivery.address)}</p>` : ""}
    <ul>${order.items.map(item => `<li>${escapeHtml(item.title)} · ${item.quantity} шт. × ${money(item.price)}</li>`).join("")}</ul>
    ${order.tracking ? `<p class="admin-order-info">Трек-номер: ${escapeHtml(order.tracking)}</p>` : ""}
    ${order.state === "forming" && remaining ? `<div data-order-deadline="${order.editableUntil}">
      <p class="admin-order-info">До автоматического подтверждения <span data-order-timer>${timeLeft(remaining)}</span></p>
      <div class="order-actions">
        <button type="button" class="button ghost" data-order-action="edit" data-order-id="${order.id}">Изменить</button>
        <button type="button" class="button ghost" data-order-action="cancel" data-order-id="${order.id}">Отменить</button>
        <button type="button" class="button" data-order-action="confirm" data-order-id="${order.id}">Подтвердить</button>
      </div></div>` : ""}
  </article>`;
}

function help() {
  return `<div class="narrow">
    <a class="crumbs" href="#profile">‹ Профиль</a>
    <h1 class="heading">Частые вопросы</h1>
    <h2 class="label">Частые вопросы</h2>
    ${questions.map(([title, detail]) => `<details class="faq"><summary>${title}</summary><p>${detail}</p></details>`).join("")}
    <h2 class="label">Связаться с магазином</h2>${manager()}
    ${serverUser && serverUser.role !== "customer" ? '<a class="button ghost staff-shortcut" href="/admin">Админ-панель</a>' : ""}
  </div>`;
}

function profile() {
  const name = [serverUser?.firstName, serverUser?.lastName].filter(Boolean).join(" ") || serverUser?.username || "Гость";
  return `<div class="narrow">
    <h1 class="heading">Профиль</h1>
    <div class="info profile-account">${panelIcon("profile")}<div>
      <b>${escapeHtml(name)}</b>${serverUser?.username ? `<p>@${escapeHtml(serverUser.username)}</p>` : ""}
    </div>${serverUser ? '<button class="button ghost" type="button" data-account>Выйти</button>'
      : '<a class="button" href="/login">Войти через Telegram</a>'}</div>
    <div class="profile-links">
      <a class="info" href="#orders">${panelIcon("orders")}<b>Мои заказы</b>${icon("chevron", 16)}</a>
      <a class="info" href="#help">${panelIcon("help")}<b>Частые вопросы</b>${icon("chevron", 16)}</a>
      <a class="info" href="#news">${panelIcon("info")}<b>Новости</b>${icon("chevron", 16)}</a>
      ${serverUser && serverUser.role !== "customer" ? `<a class="info" href="/admin">${panelIcon("admin")}<b>Админ-панель</b>${icon("chevron", 16)}</a>` : ""}
    </div>
    <h2 class="label">Наши магазины в Ижевске</h2>
    <ul class="location-grid">${locations.map(address =>
      `<li class="info">${panelIcon("pin")}<b>${address}</b></li>`).join("")}</ul>
    ${manager()}
  </div>`;
}

function news() {
  return `<div class="narrow">
    <a class="crumbs" href="#home">‹ Главная</a>
    <h1 class="heading">Что нового в приложении</h1>
    <a class="info" href="${channelUrl}" target="_blank" rel="noopener noreferrer">
      ${panelIcon("info")}<div><b>Новости AMIRI VAPE</b><p>Обновления и поступления в Telegram</p></div>${icon("chevron", 16)}
    </a>
  </div>`;
}

function productPage() {
  const product = byId.get(hashParts()[1]);
  if (!product) {
    return `<div class="narrow empty"><h1>${!storefrontLoaded && serverUser ? "Загружаем товар…" : "Товар недоступен"}</h1>
      <a class="button" href="#shop">В каталог</a></div>`;
  }
  const variants = variantsByLine.get(lineKey(product));
  const cover = variants.find(variant => variant.image) || product;
  return `<div class="narrow product-page">
    <a class="crumbs" href="${escapeHtml(productBack)}">‹ Назад</a>
    ${photo(cover)}
    <h1 class="heading">${escapeHtml(product.line || product.title)}</h1>
    <p class="subtitle">${escapeHtml([categoryTitle(product.category), product.brand].filter(Boolean).join(" · "))}</p>
    ${product.line ? '<h2 class="label">Варианты</h2>' : ""}
    <div class="list product-options">${variants.map(variant => `<div class="info product-order">
      <div>${product.line ? `<strong>${formatTitle(variant.title)}</strong>` : ""}
        <b>${catalogPrice(variant)}</b><p>${variant.stock ? `В наличии: ${variant.stock} шт.` : "Нет в наличии"}</p></div>
      ${variant.price === null ? "" : quantityControls(variant, cart[variant.id] || 0)}
    </div>`).join("")}</div>
  </div>`;
}

function cartQuantity() {
  return Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
}

function updateNavigation(section) {
  const tabRoute = { product: "shop", help: "profile", news: "home" }[section] || section;
  tabs.forEach(tab => {
    if (tab.dataset.tab === tabRoute) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  const count = cartQuantity();
  cartCount.hidden = !count;
  cartCount.textContent = count;
  cartbar.hidden = !count || section === "cart";
  if (!cartbar.hidden) {
    const total = cartTotal(cartLines());
    cartbar.innerHTML = `<span>${icon("cart", 19)} Корзина · ${count} шт.</span><strong>${money(total)} ${icon("chevron", 16)}</strong>`;
  }
  const name = serverUser?.firstName || serverUser?.username || "Гость";
  const isStaff = serverUser && serverUser.role !== "customer";
  userName.textContent = serverUser ? name : "";
  document.querySelector("#admin-link").hidden = !isStaff;
  account.textContent = serverUser ? "Выйти" : "Войти";
}

const screens = new Map([
  ["home", home], ["shop", shop], ["cart", cartPage], ["orders", orders], ["profile", profile],
  ["help", help], ["news", news], ["product", productPage],
]);

function render({ scroll = true } = {}) {
  const [section] = hashParts();
  const route = screens.has(section) ? section : "home";
  document.body.dataset.section = route;
  view.innerHTML = screens.get(route)();
  updateNavigation(route);
  if (scroll) window.scrollTo(0, 0);
}

function showPanel(title, content) {
  delete panel.dataset.kind;
  panel.innerHTML = `<div class="dialog-head"><h2 id="panel-title">${escapeHtml(title)}</h2>
    <button type="button" data-close aria-label="Закрыть">×</button></div>${content}`;
  if (!panel.open) panel.showModal();
}

function openSearch() {
  panel.dataset.kind = "search";
  panel.innerHTML = `<h2 id="panel-title" class="visually-hidden">Поиск в каталоге</h2>
    <div class="search-head">
      <label>${icon("search", 20)}<input type="search" id="query" placeholder="Бренд, вкус или линейка" aria-label="Поиск в каталоге" autocomplete="off"></label>
      <button type="button" data-close>Отмена</button>
    </div><div id="search-results" class="search-results" aria-live="polite"></div>`;
  panel.showModal();
  panel.querySelector("#query").focus();
}

function searchProducts(query) {
  const needle = normalize(query);
  if (!needle) return "";
  const matches = products.filter(product => normalize(`${product.title} ${product.line} ${product.brand} ${categoryTitle(product.category)}`).includes(needle));
  const items = linesFor(matches).slice(0, 40);
  return items.length ? items.map(product => `<button class="search-result" type="button" data-product="${product.id}">
    ${photo(product)}<span><b>${formatTitle(product.title)}</b><small>${catalogPrice(product)}</small></span>${icon("chevron", 16)}
  </button>`).join("") : '<p class="empty-selection">Ничего не нашли.</p>';
}

function flyToCart(source) {
  if (!source || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const image = source.closest(".cart-item, .product-card, .product-page")?.querySelector(".photo img:not([hidden])");
  const target = [...document.querySelectorAll("[data-cart-target], .tabs [data-tab='cart']")]
    .find(element => element.getBoundingClientRect().width > 0);
  if (!image || !target || typeof image.animate !== "function") return;
  const start = image.getBoundingClientRect();
  const end = (target.querySelector("svg") || target).getBoundingClientRect();
  if (!start.width || !start.height) return;
  const size = Math.min(82, start.width, start.height);
  const dx = end.left + end.width / 2 - start.left - start.width / 2;
  const dy = end.top + end.height / 2 - start.top - start.height / 2;
  const flight = image.cloneNode();
  flight.className = "cart-flight";
  flight.alt = "";
  flight.setAttribute("aria-hidden", "true");
  flight.removeAttribute("loading");
  flight.style.width = flight.style.height = `${size}px`;
  flight.style.left = `${start.left + (start.width - size) / 2}px`;
  flight.style.top = `${start.top + (start.height - size) / 2}px`;
  document.body.append(flight);
  const animation = flight.animate([
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 55}px) scale(.72)`, opacity: .95, offset: .45 },
    { transform: `translate(${dx}px, ${dy}px) scale(.14)`, opacity: .2 },
  ], { duration: 600, easing: "cubic-bezier(.25,.65,.35,1)", fill: "forwards" });
  animation.finished.then(() => {
    flight.remove();
    if (target.isConnected) (target.querySelector("svg") || target).animate([
      { transform: "scale(1)" }, { transform: "scale(1.2)", offset: .4 }, { transform: "scale(1)" },
    ], { duration: 220, easing: "ease-out" });
  }, () => flight.remove());
}

function updateQuantity(id) {
  const quantity = cart[id] || 0;
  const product = byId.get(id);
  const limit = Math.min(999, product?.stock ?? 999);
  for (const controls of view.querySelectorAll(`[data-quantity-item="${id}"]`)) {
    controls.querySelector("output").value = quantity;
    controls.querySelector('[data-quantity="-1"]').disabled = quantity === 0;
    controls.querySelector('[data-quantity="1"]').disabled = quantity >= limit;
  }
  const row = view.querySelector(`[data-cart-item="${id}"]`);
  const items = cartLines();
  if (row) {
    if (!quantity) row.remove();
    else row.querySelector("[data-cart-line-status]").textContent =
      cartLineStatus(items.find(item => item.product.id === id));
  }
  const [section] = hashParts();
  if (section === "cart") {
    if (!items.length) return render({ scroll: false });
    view.querySelector("[data-cart-quantity]").textContent = `${cartQuantity()} шт.`;
    view.querySelector("[data-cart-summary]").innerHTML = cartSummary(items);
  }
  updateNavigation(section);
}

function changeQuantity(id, delta, source) {
  const product = byId.get(id);
  const old = cart[id] || 0;
  if (checkoutPending || pendingOrder || (delta > 0 && (product?.price == null || old >= product.stock))) return;
  const quantity = delta < 0 ? Math.max(0, old + delta) : Math.min(999, product.stock ?? 999, old + delta);
  if (quantity === old) return;
  if (quantity > old) flyToCart(source);
  if (quantity) cart[id] = quantity;
  else {
    delete cart[id];
    returnedTitles.delete(id);
  }
  saveCart();
  savePending(null);
  checkoutError = "";
  updateQuantity(id);
  if (source?.disabled) {
    view.querySelector(`[data-item="${id}"]:not(:disabled)`)?.focus();
  }
}

async function loadStorefront() {
  const request = ++storefrontRequest;
  try {
    const response = await fetch("/api/storefront", { signal: AbortSignal.timeout(10_000) });
    if (request !== storefrontRequest) return false;
    if (response.status === 401) return location.reload();
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (request !== storefrontRequest) return false;
    products = result.products;
    categories = result.categories;
    topProducts = result.top;
    byId = new Map(products.map(product => [product.id, product]));
    variantsByLine = new Map();
    for (const product of products) {
      const key = lineKey(product);
      if (!variantsByLine.has(key)) variantsByLine.set(key, []);
      variantsByLine.get(key).push(product);
    }
    ordersList = result.orders;
    serverClockOffset = result.serverTime - Date.now();
    storefrontError = "";
    storefrontLoaded = true;
    if (!pendingOrder) {
      let returned = false;
      for (const order of result.cartReturns ?? ordersList.filter(order => order.returnToCart)) {
        if (returnedOrders.has(order.id)) continue;
        for (const item of order.items) {
          cart[item.id] = item.quantity + (cart[item.id] || 0);
          returnedTitles.set(item.id, item.title);
        }
        returnedOrders.add(order.id);
        returned = true;
      }
      let changed = false;
      for (const [id, quantity] of Object.entries(cart)) {
        if (returnedTitles.has(id)) continue;
        const product = byId.get(id);
        const available = product?.price == null ? 0 : Math.min(quantity, product.stock);
        if (available === quantity) continue;
        changed = true;
        if (available) cart[id] = available;
        else delete cart[id];
      }
      if (changed || returned) {
        cartNotice = returned ? "Товары из отменённых заказов возвращены в корзину."
          : "Корзина обновлена с учётом текущих остатков и цен.";
        saveCart();
      }
    }
  } catch {
    if (request !== storefrontRequest) return false;
    storefrontError = "Не удалось обновить каталог и заказы.";
  }
  return true;
}

async function refreshStorefront() {
  const previousOrders = ordersList;
  if (!serverUser || !await loadStorefront()) return;
  render({ scroll: false });
  if (panel.open && panel.dataset.kind === "search") {
    panel.querySelector("#search-results").innerHTML = searchProducts(panel.querySelector("#query").value);
  }
  if (hashParts()[0] !== "orders" || orderActionPending) return;
  const confirmed = ordersList.find(order => order.state === "new" && previousOrders.some(previous =>
    previous.id === order.id && previous.state === "forming" && previous.editableUntil === order.updatedAt));
  if (!confirmed) return;
  if (panel.open) {
    const activeOrder = panel.querySelector("[data-deadline]")?.dataset;
    if (Number(activeOrder?.orderId ?? activeOrder?.editOrder) !== confirmed.id) return;
    panel.close();
  }
  showPurchaseCelebration();
}

function showPurchaseCelebration() {
  if (purchaseCelebration.open) return;
  const pieces = "<span></span>".repeat(8);
  for (const side of purchaseCelebration.querySelectorAll(".purchase-confetti")) side.innerHTML = pieces;
  purchaseCelebration.showModal();
}

function deliveryInputs(delivery = {}) {
  return `<label>Номер пункта СДЭК
    <input name="pointNumber" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 цифр" value="${escapeHtml(delivery.pointNumber || "")}" required></label>
    <label>Адрес пункта СДЭК
    <input name="address" minlength="5" maxlength="250" value="${escapeHtml(delivery.address || "")}" required></label>
    <label>ФИО получателя
    <input name="fullName" autocomplete="name" maxlength="120" value="${escapeHtml(delivery.fullName || "")}" required></label>
    <label class="order-age"><input name="ageConfirmed" type="checkbox" ${delivery.ageConfirmed ? "checked" : ""} required>
    Я подтверждаю, что мне исполнилось 18 лет</label>`;
}

function readDelivery(form) {
  const fields = form.elements;
  return {
    pointNumber: fields.pointNumber.value,
    address: fields.address.value.trim(),
    fullName: fields.fullName.value.trim(),
    ageConfirmed: fields.ageConfirmed.checked,
  };
}

function updateOrderForm(form) {
  const delivery = readDelivery(form);
  const quantities = [...form.querySelectorAll("[data-line-price]")];
  const total = quantities.reduce((sum, input) => sum + Number(input.dataset.linePrice) * input.valueAsNumber, 0);
  const summary = form.querySelector("[data-order-total]");
  if (summary) summary.textContent = Number.isFinite(total) ? `Итого ${money(total)} · минимум ${money(minimumOrderTotal)}` : "Укажите количество каждой позиции.";
  form.querySelector("[type=submit]").disabled = checkoutPending || orderActionPending || !form.matches(":valid") ||
    delivery.address.length < 5 || !/^\p{L}[\p{L}\p{M}'’\-]*(?:\s+\p{L}[\p{L}\p{M}'’\-]*)+$/u.test(delivery.fullName) ||
    Boolean(summary && (total < minimumOrderTotal || !secondsLeft(Number(form.dataset.deadline))));
}

function openCheckout() {
  if (checkoutPending || !serverUser) return;
  if (pendingOrder && checkoutDelivery) {
    void checkout(checkoutDelivery);
    return;
  }
  showPanel("Данные для доставки", `<form class="order-form" data-delivery-form>
    ${deliveryInputs(checkoutDelivery)}
    <p class="order-form-error" role="alert"></p>
    <button type="submit" class="button" disabled>Оформить заказ</button>
  </form>`);
}

function openCustomerOrderAction(order, action) {
  if (!order || orderActionPending || !secondsLeft(order.editableUntil)) return;
  orderActionError = "";
  if (action === "confirm" || action === "cancel") {
    const confirming = action === "confirm";
    const title = confirming ? "Подтвердить заказ" : "Отменить заказ";
    showPanel(`${title} №${order.id}?`, `<form class="order-form" data-order-choice="${action}" data-order-id="${order.id}" data-deadline="${order.editableUntil}">
      ${confirming ? "<p>Вы уверены, что хотите подтвердить заказ? После подтверждения отменить его можно будет только через менеджера.</p>" : ""}
      <p class="order-form-error" role="alert"></p>
      <div class="order-actions">
        <button type="button" class="button ghost" data-close>Назад</button>
        <button type="submit" class="button">${title}</button>
      </div></form>`);
    return;
  }
  showPanel(`Изменить заказ №${order.id}`, `<form class="order-form" data-edit-order="${order.id}"
      data-revision="${order.revision}" data-deadline="${order.editableUntil}">
    ${order.items.map(item => `<label>${escapeHtml(item.title)} · ${money(item.price)}
      <input type="number" name="${escapeHtml(item.id)}" data-line-price="${item.price}" min="0" max="999" step="1" value="${item.quantity}" required></label>`).join("")}
    <p class="admin-order-info">Укажите 0, чтобы убрать позицию.</p>
    <p data-order-total></p>
    ${deliveryInputs(order.delivery)}
    <p class="order-form-error" role="alert"></p>
    <button type="submit" class="button" disabled>Сохранить изменения</button>
  </form>`);
  updateOrderForm(panel.querySelector("[data-edit-order]"));
}

async function changeCustomerOrder(body, form) {
  if (orderActionPending) return;
  orderActionPending = true;
  orderActionError = "";
  const submit = form?.querySelector("[type=submit]");
  if (submit) submit.disabled = true;
  try {
    const response = await fetch("/api/orders/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return location.reload();
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    ordersList = ordersList.map(order => order.id === result.order.id ? result.order : order);
    if (form && panel.contains(form)) panel.close();
    if (body.action === "confirm") showPurchaseCelebration();
  } catch (error) {
    const message = error.message || "Не удалось обновить заказ.";
    if (form) form.querySelector("[role=alert]").textContent = message;
    else orderActionError = message;
  } finally {
    orderActionPending = false;
    if (form?.dataset.editOrder) updateOrderForm(form);
    else if (submit) submit.disabled = false;
    render({ scroll: false });
    void refreshStorefront();
  }
}

async function checkout(delivery, form) {
  if (!serverUser || (!pendingOrder && !storefrontLoaded) || checkoutPending) return;
  if (!pendingOrder) {
    const lines = cartLines();
    if (lines.some(({ quantity, available }) => quantity > available) || cartTotal(lines) < minimumOrderTotal) return;
    const items = lines.map(({ product, quantity }) => ({ id: product.id, quantity, price: product.price }));
    savePending({ key: crypto.randomUUID(), items });
  }
  checkoutDelivery = delivery;
  checkoutPending = true;
  checkoutError = "";
  if (form) updateOrderForm(form);
  render({ scroll: false });
  try {
    const response = await fetch("/api/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pendingOrder, delivery }), signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return location.reload();
    const result = await response.json();
    if (!response.ok) {
      checkoutError = result.error;
      if (response.status < 500) savePending(null);
      await loadStorefront();
      return;
    }
    cart = {};
    returnedTitles.clear();
    cartNotice = "";
    saveCart();
    savePending(null);
    checkoutDelivery = undefined;
    if (form && panel.contains(form)) panel.close();
    ordersList = [result.order, ...ordersList.filter(order => order.id !== result.order.id)];
    await loadStorefront();
    location.hash = "#orders";
  } catch {
    checkoutError = "Ответ от сервера не получен. Повторите проверку оформления.";
  } finally {
    checkoutPending = false;
    if (form && panel.open && panel.contains(form)) {
      form.querySelector("[role=alert]").textContent = checkoutError;
      updateOrderForm(form);
    }
    render({ scroll: false });
  }
}

document.querySelectorAll("[data-icon]").forEach(node => { node.outerHTML = icon(node.dataset.icon); });

document.addEventListener("error", event => {
  if (event.target instanceof HTMLImageElement && event.target.closest(".photo, .catalog-banner")) {
    event.target.hidden = true;
  }
}, true);

account.addEventListener("click", async () => {
  if (serverUser) {
    account.disabled = true;
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      location.reload();
    } catch {
      showPanel("Не удалось выйти", "<p>Попробуйте ещё раз.</p>");
      account.disabled = false;
    }
    return;
  }
  location.assign("/login");
});

document.addEventListener("click", event => {
  if (event.target === panel) {
    const bounds = panel.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) panel.close();
    return;
  }
  const target = event.target.closest("button");
  if (!target) return;
  const data = target.dataset;
  if ("close" in data) panel.close();
  if ("account" in data && !account.disabled) account.click();
  if ("openSearch" in data) openSearch();
  if (data.selection) {
    selected = data.selection;
    view.querySelectorAll("[data-selection]").forEach(button =>
      button.setAttribute("aria-pressed", button.dataset.selection === selected));
    document.querySelector("#highlight-results").innerHTML = highlights();
  }
  if (data.product && byId.has(data.product)) {
    productBack = location.hash || "#home";
    if (panel.open) panel.close();
    location.hash = "product/" + data.product;
  }
  if (data.quantity) changeQuantity(data.item, Number(data.quantity), target);
  if ("checkout" in data) openCheckout();
  if (data.orderAction) openCustomerOrderAction(ordersList.find(order => order.id === Number(data.orderId)), data.orderAction);
  if ("refreshStore" in data) void refreshStorefront();
});

panel.addEventListener("input", event => {
  if (event.target.id === "query") {
    panel.querySelector("#search-results").innerHTML = searchProducts(event.target.value);
  }
  const form = event.target.closest("[data-delivery-form], [data-edit-order]");
  if (form) updateOrderForm(form);
});

panel.addEventListener("submit", event => {
  const form = event.target;
  if (!form.matches("[data-delivery-form], [data-edit-order], [data-order-choice]")) return;
  event.preventDefault();
  if (form.querySelector("[type=submit]").disabled) return;
  if (form.matches("[data-delivery-form]")) {
    void checkout(readDelivery(form), form);
  } else if (secondsLeft(Number(form.dataset.deadline))) {
    if (form.dataset.orderChoice) {
      void changeCustomerOrder({ id: Number(form.dataset.orderId), action: form.dataset.orderChoice }, form);
    } else {
      const items = [...form.querySelectorAll("[data-line-price]")].map(input => ({ id: input.name, quantity: input.valueAsNumber }));
      void changeCustomerOrder({ id: Number(form.dataset.editOrder), action: "edit",
        revision: Number(form.dataset.revision), items, delivery: readDelivery(form) }, form);
    }
  }
});

if (checkingSession) setInterval(() => {
  let expired = false;
  for (const controls of view.querySelectorAll("[data-order-deadline]")) {
    const remaining = secondsLeft(Number(controls.dataset.orderDeadline));
    controls.querySelector("[data-order-timer]").textContent = timeLeft(remaining);
    if (!remaining) expired = true;
  }
  const form = panel.open ? panel.querySelector("[data-deadline]") : null;
  if (form && !secondsLeft(Number(form.dataset.deadline))) {
    form.querySelector("[type=submit]").disabled = true;
    if (!orderActionPending) form.querySelector("[role=alert]").textContent = form.dataset.orderChoice === "confirm"
      ? "Заказ подтверждён автоматически." : "Время для изменения или отмены заказа истекло.";
  }
  if (expired) {
    render({ scroll: false });
    void refreshStorefront();
  }
}, 500);

window.addEventListener("hashchange", () => {
  if (panel.open) panel.close();
  render();
  const [section] = hashParts();
  if (section === "orders" || section === "shop" || section === "cart") void refreshStorefront();
});
render();

if (checkingSession) {
  if (typeof BroadcastChannel === "function") {
    const catalogUpdates = new BroadcastChannel("amiri-catalog");
    catalogUpdates.addEventListener("message", event => {
      if (event.data === "changed") void refreshStorefront();
    });
  }
  window.addEventListener("focus", () => void refreshStorefront());
  window.addEventListener("pageshow", event => {
    if (event.persisted) void refreshStorefront();
  });
  fetch("/api/session", { signal: AbortSignal.timeout(10_000) })
    .then(response => response.ok ? response.json() : null)
    .then(async session => {
      checkingSession = false;
      if (!session?.user) return render({ scroll: false });
      serverUser = session.user;
      cartKey = "amiri-cart-" + serverUser.id;
      cart = restoreCart(cartKey);
      pendingOrder = readLocal(cartKey + "-pending");
      await refreshStorefront();
    })
    .catch(() => {
      checkingSession = false;
      storefrontError = "Не удалось загрузить каталог.";
      render({ scroll: false });
    });
}
