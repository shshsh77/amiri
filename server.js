import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openAuthStore } from "./auth-store.js";
import { createRegistrationHandler, createTelegramClient, pollTelegram } from "./bot.js";
import { ShopError } from "./shop-store.js";
import { miniMenu, verifyMiniLaunch } from "./telegram-mini.js";
import { createTelegramOrders } from "./telegram-orders.js";

const directory = dirname(fileURLToPath(import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".woff": "font/woff", ".svg": "image/svg+xml",
};
const staticFiles = new Set([
  "/style.css", "/app.js", "/catalog-data.cjs", "/login.js", "/admin.js", "/admin-shop.js", "/mini-app.js",
  "/dist/navigation.js", "/dist/navigation.css", "/assets/amiri-logo.svg",
]);
const telegramIdPattern = /^[1-9]\d{0,15}$/;
const loginToken = /^[A-Za-z0-9_-]{32}$/;
const browserToken = /^[A-Za-z0-9_-]{43}$/;
const sessionToken = /^[a-f0-9]{64}$/;
const pageSize = 30;
const productId = /^[a-z0-9-]{1,64}$/;
const staticImagePath = /^\/img\/[A-Za-z0-9_-]{1,96}\.(?:webp|png|jpe?g)$/;
const catalogImagePath = /^\/img\/[A-Za-z0-9_-]{1,96}\.png$/;
const productBadges = new Set(["", "new", "restock"]);
const orderKey = /^[0-9a-f-]{36}$/;
const orderStates = new Set(["forming", "new", "accepted", "packing", "shipped", "completed", "cancelled"]);
const intIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const pageNumber = url => Math.max(1, Math.floor(Number(url.searchParams.get("page"))) || 1);

function productFields(body) {
  if (!body || typeof body.title !== "string" || typeof body.visible !== "boolean") return null;
  const title = body.title.trim();
  if (!title || title.length > 120 || !intIn(body.category, 0, Number.MAX_SAFE_INTEGER) ||
      (body.price !== null && !intIn(body.price, 1, 1_000_000)) || !intIn(body.stock, 0, 1_000_000)) return null;
  if (body.id !== undefined && (typeof body.id !== "string" || !productId.test(body.id) || !intIn(body.revision, 1, Number.MAX_SAFE_INTEGER))) return null;
  if (body.image !== undefined && typeof body.image !== "string") return null;
  const image = body.image?.trim();
  if (image && !catalogImagePath.test(image)) return null;
  if (body.badge !== undefined && !productBadges.has(body.badge)) return null;
  if (body.brand !== undefined && (typeof body.brand !== "string" || body.brand.trim().length > 60)) return null;
  if (body.line !== undefined && (typeof body.line !== "string" || body.line.trim().length > 120)) return null;
  return { ...body, title, image, brand: body.brand?.trim(), line: body.line?.trim() };
}

function categoryFields(body) {
  if (!body || typeof body.title !== "string" || typeof body.image !== "string") return null;
  const title = body.title.trim();
  const image = body.image.trim();
  if (!title || title.length > 64 || (image && !catalogImagePath.test(image)) ||
      (body.id !== undefined && !intIn(body.id, 0, Number.MAX_SAFE_INTEGER))) return null;
  return { id: body.id, title, image };
}

function validOrder(body) {
  if (typeof body?.key !== "string" || !orderKey.test(body.key) ||
      !Array.isArray(body.items) || !intIn(body.items.length, 1, 50)) return false;
  const ids = new Set();
  for (const item of body.items) {
    if (typeof item?.id !== "string" || !productId.test(item.id) || ids.has(item.id) ||
        !intIn(item.quantity, 1, 999) || !intIn(item.price, 1, 1_000_000)) return false;
    ids.add(item.id);
  }
  return true;
}

function validAdjustment(body) {
  if (!intIn(body?.id, 1, Number.MAX_SAFE_INTEGER) || !intIn(body.revision, 1, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(body.items) || !intIn(body.items.length, 1, 50)) return false;
  const ids = new Set();
  for (const item of body.items) {
    if (typeof item?.id !== "string" || !productId.test(item.id) || ids.has(item.id) ||
        !intIn(item.quantity, 0, 999)) return false;
    ids.add(item.id);
  }
  return true;
}

function deliveryFields(body) {
  if (typeof body?.pointNumber !== "string" || !/^\d{6}$/.test(body.pointNumber) ||
      typeof body.address !== "string" || typeof body.fullName !== "string" || body.ageConfirmed !== true) return null;
  const address = body.address.trim();
  const fullName = body.fullName.trim().replace(/\s+/g, " ");
  if (address.length < 5 || address.length > 250 || fullName.length > 120 ||
      !/^\p{L}[\p{L}\p{M}'’\-]*(?: \p{L}[\p{L}\p{M}'’\-]*)+$/u.test(fullName)) return null;
  return { pointNumber: body.pointNumber, address, fullName, ageConfirmed: true };
}

function cookie(request, name, pattern) {
  const prefix = name + "=";
  const entry = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  const value = entry?.slice(prefix.length);
  return value && pattern.test(value) ? value : "";
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function sendFile(response, path, head = false, status = 200, transform) {
  let body;
  try {
    body = await readFile(resolve(directory, path));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return sendJson(response, 404, { error: "Файл не найден" });
  }
  if (transform) body = Buffer.from(transform(body.toString("utf8")));
  response.writeHead(status, { "Content-Type": types[extname(path)], "Content-Length": body.length });
  response.end(head ? undefined : body);
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return null;
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 16_384) return null;
  }
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

const sdkTag = '<script src="https://telegram.org/js/telegram-web-app.js?65" defer></script>';
const miniBrowserName = "__Host-amiri_mini_browser";
const miniSessionName = "__Host-amiri_mini_session";
const miniShell = html => html
  .replace('<script src="catalog-data.cjs"', sdkTag + '\n  <script src="/mini-app.js" defer></script>\n  <script src="catalog-data.cjs"')
  .replace("<body>", '<body class="telegram-mini">');

export function createWebServer({
  store, publicOrigin, miniOrigin = "", botToken = "", botUsername = "", adminIds = new Set(), guestPreview = false,
}) {
  const webOrigin = new URL(publicOrigin);
  const miniHost = miniOrigin ? new URL(miniOrigin).host : "";
  const browserName = webOrigin.protocol === "https:" ? "__Host-amiri_browser" : "amiri_browser";
  const sessionName = webOrigin.protocol === "https:" ? "__Host-amiri_session" : "amiri_session";
  const makeCookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${webOrigin.protocol === "https:" ? "; Secure" : ""}`;
  const makeMiniCookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
  const starts = new Map();

  function limited(address) {
    const now = Date.now();
    for (const [ip, value] of starts) if (value.until <= now) starts.delete(ip);
    let entry = starts.get(address);
    if (!entry) {
      if (starts.size >= 5000) return true;
      entry = { until: now + 60_000, count: 0 };
      starts.set(address, entry);
    }
    return ++entry.count > 25;
  }

  function publicUser(user) {
    const isAdmin = adminIds.has(user.telegram_id);
    const role = isAdmin ? "owner" : store.isEditor(user.telegram_id) ? "editor" : "customer";
    return {
      id: user.telegram_id, firstName: user.first_name, lastName: user.last_name, username: user.username,
      isAdmin, role,
    };
  }

  async function route(request, response) {
    const host = request.headers.host?.toLowerCase();
    const mini = Boolean(miniHost && botToken && host === miniHost);
    const origin = mini ? miniOrigin : publicOrigin;
    const url = new URL(request.url, origin);
    const path = url.pathname;
    const method = request.method;
    const head = method === "HEAD";
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy",
      `default-src 'self'; script-src 'self'${mini ? " https://telegram.org/js/telegram-web-app.js" : ""}; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${mini ? "https://web.telegram.org" : "'none'"}; form-action 'self'`);
    if (miniHost && !mini && host !== webOrigin.host) {
      return sendJson(response, 421, { error: "Адрес сайта не настроен." });
    }

    if (method === "GET" || head) {
      if (staticFiles.has(path) || staticImagePath.test(path) || /^\/fonts\/[\w-]+\.woff$/.test(path)) {
        return sendFile(response, path.slice(1), head);
      }
      if (path === "/favicon.ico") return sendFile(response, "assets/amiri-logo.svg", head);
    }
    const auth = cookie(request, mini ? miniSessionName : sessionName, sessionToken);
    const user = store.session(auth);
    const isAdmin = user && adminIds.has(user.telegram_id);
    const isStaff = user && (isAdmin || store.isEditor(user.telegram_id));

    if (method === "GET" || head) {
      if (mini && path === "/mini") {
        const browser = cookie(request, miniBrowserName, browserToken) || randomBytes(32).toString("base64url");
        response.setHeader("Set-Cookie", makeMiniCookie(miniBrowserName, browser, 20 * 60));
        return sendFile(response, "mini.html", head);
      }
      if (mini && ["/", "/mini-app", "/index.html", "/app", "/app/"].includes(path)) {
        if (path === "/mini-app" && user) return sendFile(response, "index.html", head, 200, miniShell);
        response.writeHead(302, { Location: user ? "/mini-app" : "/mini" });
        return response.end();
      }
      if (path === "/app" || path === "/app/") {
        response.writeHead(308, { Location: "/" });
        return response.end();
      }
      if (path === "/" || path === "/index.html") {
        return sendFile(response, user || guestPreview ? "index.html" : "login.html", head);
      }
      if (!mini && path === "/login") {
        if (!user) return sendFile(response, "login.html", head);
        response.writeHead(302, { Location: "/" });
        return response.end();
      }
      if (path === "/admin" || path === "/admin/") {
        if (mini && !user) {
          response.writeHead(302, { Location: "/mini" });
          return response.end();
        }
        return sendFile(response, !user ? "login.html" : isStaff ? "admin.html" : "forbidden.html", head, user && !isStaff ? 403 : 200);
      }
    }
    if (method === "GET" && path === "/api/session") {
      return sendJson(response, 200, { user: user ? publicUser(user) : null, botUsername });
    }

    if (method === "POST" && request.headers.origin !== origin) {
      return sendJson(response, 403, { error: "Недопустимый источник запроса" });
    }
    if (method === "POST" && path === "/api/auth/telegram" && mini) {
      const browser = cookie(request, miniBrowserName, browserToken);
      const body = await readJson(request);
      const launch = verifyMiniLaunch(body?.initData, botToken);
      if (!browser || !launch) {
        return sendJson(response, 401, { error: "Не удалось подтвердить вход. Закройте приложение и откройте его заново из меню бота." });
      }
      const result = store.miniSession(launch, browser);
      if (result.status !== "authenticated") {
        return sendJson(response, result.status === "denied" ? 403 : 401, {
          error: result.status === "denied" ? "Доступ к магазину ограничен." : "Запуск уже использован. Откройте приложение заново из меню бота.",
        });
      }
      if (auth && auth !== result.session) store.logout(auth);
      response.setHeader("Set-Cookie", makeMiniCookie(miniSessionName, result.session, Math.max(1, Math.ceil((result.expiresAt - Date.now()) / 1000))));
      return sendJson(response, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/auth/start" && !mini) {
      if (!botUsername) return sendJson(response, 503, { error: "Бот ещё не настроен." });
      if (limited(request.socket.remoteAddress)) return sendJson(response, 429, { error: "Слишком много запросов. Попробуйте через минуту." });
      const browser = cookie(request, browserName, browserToken) || randomBytes(32).toString("base64url");
      const result = store.createChallenge(browser);
      response.setHeader("Set-Cookie", makeCookie(browserName, browser, 20 * 60));
      return sendJson(response, 200, { ...result, url: `https://t.me/${botUsername}?start=web_${result.token}` });
    }
    if (method === "POST" && path === "/api/auth/status" && !mini) {
      const browser = cookie(request, browserName, browserToken);
      const body = await readJson(request);
      if (!browser || typeof body?.token !== "string" || !loginToken.test(body.token)) {
        return sendJson(response, 400, { error: "Запрос на вход недействителен. Создайте новый." });
      }
      const { status, session, expiresAt } = store.exchange(body.token, browser);
      if (session) {
        response.setHeader("Set-Cookie", makeCookie(sessionName, session, Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))));
      }
      return sendJson(response, 200, { status });
    }
    if (method === "POST" && path === "/api/auth/logout") {
      store.logout(auth);
      response.setHeader("Set-Cookie", mini ? makeMiniCookie(miniSessionName, "", 0) : makeCookie(sessionName, "", 0));
      return sendJson(response, 200, { ok: true });
    }

    if (["/api/storefront", "/api/orders", "/api/orders/action"].includes(path)) {
      if (!user) return sendJson(response, 401, { error: "Войдите через Telegram." });
      if (method === "GET" && path === "/api/storefront") {
        return sendJson(response, 200, {
          products: store.shop.products(), categories: store.shop.categories(),
          orders: store.shop.customerOrders(user.telegram_id), cartReturns: store.shop.cartReturns(user.telegram_id),
          top: store.shop.topProducts(), serverTime: Date.now(),
        });
      }
      if (method === "POST") {
        const body = await readJson(request);
        if (path === "/api/orders") {
          if (!validOrder(body)) return sendJson(response, 400, { error: "Проверьте позиции в корзине." });
          const delivery = deliveryFields(body.delivery);
          if (!delivery) return sendJson(response, 400, { error: "Проверьте номер и адрес пункта СДЭК, ФИО и подтверждение возраста." });
          return sendJson(response, 201, { order: store.shop.submit(user.telegram_id, body.key, body.items, delivery) });
        }
        if (path === "/api/orders/action") {
          if (!intIn(body?.id, 1, Number.MAX_SAFE_INTEGER) || !["edit", "cancel", "confirm"].includes(body.action)) {
            return sendJson(response, 400, { error: "Проверьте действие с заказом." });
          }
          const delivery = body.action === "edit" ? deliveryFields(body.delivery) : null;
          if (body.action === "edit" && (!delivery || !validAdjustment(body))) {
            return sendJson(response, 400, { error: "Проверьте количество позиций и данные доставки." });
          }
          return sendJson(response, 200, {
            order: store.shop.changeCustomerOrder(user.telegram_id, body.id, body.action, body.revision, body.items, delivery),
          });
        }
      }
    }

    if (path.startsWith("/api/admin/")) {
      if (!user) return sendJson(response, 401, { error: "Войдите через Telegram." });
      if (!isStaff || (path.startsWith("/api/admin/users") && !isAdmin)) {
        return sendJson(response, 403, { error: "У вас нет доступа к этому разделу." });
      }
      if (method === "GET" && path === "/api/admin/users") {
        const query = (url.searchParams.get("q") || "").trim().slice(0, 128);
        const page = pageNumber(url);
        const { users, stats, page: currentPage, count } = store.users(query, page, pageSize);
        return sendJson(response, 200, {
          users: users.map(record => ({
            ...publicUser(record), registeredAt: record.created_at, lastLogin: record.last_login, blocked: Boolean(record.blocked),
          })),
          stats, page: currentPage, pages: Math.max(1, Math.ceil(count / pageSize)),
        });
      }
      if (method === "POST" && path === "/api/admin/users/access") {
        const body = await readJson(request);
        if (typeof body?.id !== "string" || !telegramIdPattern.test(body.id) || typeof body.blocked !== "boolean") {
          return sendJson(response, 400, { error: "Некорректное изменение доступа." });
        }
        if (adminIds.has(body.id)) return sendJson(response, 409, { error: "Доступ администратора задаётся в конфигурации сервера." });
        if (!store.setBlocked(body.id, body.blocked)) return sendJson(response, 404, { error: "Пользователь не найден." });
        return sendJson(response, 200, { ok: true });
      }
      if (method === "POST" && path === "/api/admin/users/role") {
        const body = await readJson(request);
        if (typeof body?.id !== "string" || !telegramIdPattern.test(body.id) || !["editor", "customer"].includes(body.role)) {
          return sendJson(response, 400, { error: "Некорректная роль пользователя." });
        }
        if (adminIds.has(body.id)) return sendJson(response, 409, { error: "Права владельца задаются в конфигурации сервера." });
        if (!store.setEditor(body.id, body.role === "editor")) return sendJson(response, 404, { error: "Пользователь не найден." });
        return sendJson(response, 200, { ok: true });
      }
      if (path === "/api/admin/products") {
        if (method === "GET") return sendJson(response, 200, { products: store.shop.products(true), categories: store.shop.categories() });
        if (method === "POST") {
          const fields = productFields(await readJson(request));
          if (!fields) return sendJson(response, 400, { error: "Проверьте поля позиции. Для фото укажите путь к PNG вида /img/product.png." });
          return sendJson(response, fields.id ? 200 : 201, { product: store.shop.saveProduct(fields.id, fields) });
        }
      }
      if (method === "POST" && path === "/api/admin/products/delete") {
        const body = await readJson(request);
        if (typeof body?.id !== "string" || !productId.test(body.id) || !intIn(body.revision, 1, Number.MAX_SAFE_INTEGER)) {
          return sendJson(response, 400, { error: "Проверьте позицию для удаления." });
        }
        store.shop.deleteProduct(body.id, body.revision);
        return sendJson(response, 200, { ok: true });
      }
      if (path === "/api/admin/categories") {
        if (method === "GET") return sendJson(response, 200, { categories: store.shop.categories() });
        if (method === "POST") {
          const fields = categoryFields(await readJson(request));
          if (!fields) return sendJson(response, 400, { error: "Проверьте название категории и путь к PNG-баннеру." });
          return sendJson(response, fields.id === undefined ? 201 : 200, { category: store.shop.saveCategory(fields) });
        }
      }
      if (method === "POST" && path === "/api/admin/categories/delete") {
        const body = await readJson(request);
        if (!intIn(body?.id, 0, Number.MAX_SAFE_INTEGER)) {
          return sendJson(response, 400, { error: "Проверьте категорию для удаления." });
        }
        store.shop.deleteCategory(body.id);
        return sendJson(response, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/admin/orders") {
        const state = url.searchParams.get("state") || "";
        if (state && !orderStates.has(state)) return sendJson(response, 400, { error: "Неизвестный статус." });
        return sendJson(response, 200, store.shop.orders(state, pageNumber(url), pageSize));
      }
      if (method === "POST" && path === "/api/admin/orders/status") {
        const body = await readJson(request);
        if (!intIn(body?.id, 1, Number.MAX_SAFE_INTEGER) || !orderStates.has(body.expected) || !orderStates.has(body.state) ||
            (body.revision !== undefined && !intIn(body.revision, 1, Number.MAX_SAFE_INTEGER)) ||
            (body.tracking !== undefined && (typeof body.tracking !== "string" || body.tracking.trim().length > 100))) {
          return sendJson(response, 400, { error: "Проверьте статус заказа и трек-номер." });
        }
        const order = store.shop.updateOrder(body.id, body.expected, body.state, body.tracking?.trim() || "", body.revision);
        return sendJson(response, 200, { order });
      }
      if (method === "POST" && path === "/api/admin/orders/status/undo") {
        const body = await readJson(request);
        if (!intIn(body?.id, 1, Number.MAX_SAFE_INTEGER) || !intIn(body.revision, 1, Number.MAX_SAFE_INTEGER)) {
          return sendJson(response, 400, { error: "Проверьте заказ для отката статуса." });
        }
        return sendJson(response, 200, { order: store.shop.undoOrderStatus(body.id, body.revision) });
      }
      if (method === "POST" && path === "/api/admin/orders/items") {
        const body = await readJson(request);
        if (!validAdjustment(body)) return sendJson(response, 400, { error: "Проверьте количество позиций." });
        return sendJson(response, 200, { order: store.shop.adjustOrder(body.id, body.revision, body.items) });
      }
    }
    return sendJson(response, 404, { error: "Страница не найдена" });
  }

  return createServer((request, response) => {
    route(request, response).catch(error => {
      if (error instanceof ShopError && !response.headersSent && !response.destroyed) {
        return sendJson(response, error.status, { error: error.message });
      }
      console.error(error.message);
      if (!response.headersSent && !response.destroyed) sendJson(response, 500, { error: "Внутренняя ошибка сервера." });
      else response.destroy();
    });
  });
}

async function main() {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3031);
  const origin = new URL(process.env.PUBLIC_ORIGIN || `http://localhost:${port}`);
  if (origin.href !== origin.origin + "/" || !["http:", "https:"].includes(origin.protocol)) throw new Error("PUBLIC_ORIGIN должен содержать схему, домен и при необходимости порт.");
  if (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("Для внешнего адреса PUBLIC_ORIGIN требуется HTTPS.");
  }

  const adminIds = new Set((process.env.ADMIN_TELEGRAM_IDS || "").split(/[,\s]+/).filter(Boolean));
  if ([...adminIds].some(id => !telegramIdPattern.test(id))) throw new Error("В ADMIN_TELEGRAM_IDS ожидаются числовые Telegram ID.");
  const mode = process.env.TELEGRAM_MODE || "off";
  if (!["off", "poll", "embedded"].includes(mode)) throw new Error("TELEGRAM_MODE должен быть off, poll или embedded.");
  const configuredGroup = (process.env.TELEGRAM_ORDERS_GROUP_ID || "").trim();
  const groupId = configuredGroup ? Number(configuredGroup) : undefined;
  if (configuredGroup && (!/^-[1-9]\d*$/.test(configuredGroup) || !Number.isSafeInteger(groupId))) {
    throw new Error("В TELEGRAM_ORDERS_GROUP_ID ожидается отрицательный ID группы.");
  }
  const username = (process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");
  if (mode !== "off" && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new Error("Укажите имя в TELEGRAM_BOT_USERNAME.");
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (mode === "poll" && !/^\d+:[\w-]+$/.test(token)) throw new Error("Укажите токен в TELEGRAM_BOT_TOKEN.");
  const miniAddress = (process.env.MINI_APP_ORIGIN || "").trim();
  const miniUrl = miniAddress ? new URL(miniAddress) : null;
  if (miniUrl && (miniUrl.protocol !== "https:" || miniUrl.href !== miniUrl.origin + "/")) {
    throw new Error("MINI_APP_ORIGIN должен содержать публичный адрес HTTPS без пути.");
  }
  if (miniUrl && (mode === "off" || !/^\d+:[\w-]+$/.test(token))) {
    throw new Error("Для Mini App нужно подключить бота и указать TELEGRAM_BOT_TOKEN.");
  }
  const callTelegram = mode === "poll" ? createTelegramClient(token) : null;
  if (callTelegram) {
    const bot = await callTelegram("getMe");
    if (bot.username?.toLowerCase() !== username.toLowerCase()) throw new Error("Токен Telegram относится к другому боту.");
  }

  const dbFile = resolve(process.env.DB_PATH || resolve(directory, "data", "amiri.sqlite"));
  await mkdir(dirname(dbFile), { recursive: true });
  const store = openAuthStore(dbFile);
  for (const id of adminIds) store.setBlocked(id, false);
  const server = createWebServer({
    store, publicOrigin: origin.origin, miniOrigin: miniUrl?.origin, botToken: token,
    adminIds, botUsername: mode === "off" ? "" : username,
    guestPreview: mode === "off" && ["127.0.0.1", "::1"].includes(host),
  });
  const stop = new AbortController();
  const miniAppUrl = miniUrl && miniMenu(miniUrl).web_app.url;
  const registration = callTelegram && createRegistrationHandler({ store, callTelegram, publicOrigin: origin.origin, username, miniAppUrl });
  const telegramOrders = callTelegram && createTelegramOrders({ store, callTelegram, groupId, adminIds, publicOrigin: origin.origin, miniAppUrl, username });
  server.listen(port, host, () => console.log(`AMIRI VAPE · ${origin.origin} · админ-панель /admin`));
  const background = telegramOrders ? Promise.all([
    pollTelegram({ callTelegram, handler: async update => await telegramOrders.handle(update) || registration(update), signal: stop.signal }),
    telegramOrders.run(stop.signal),
  ]) : Promise.resolve();
  function shutdown() {
    stop.abort();
    server.close(async () => {
      await background;
      store.close();
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
