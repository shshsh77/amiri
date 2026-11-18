import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { openAuthStore } from "../auth-store.js";
import { createRegistrationHandler } from "../bot.js";
import { createWebServer } from "../server.js";

const admin = { id: 101, first_name: "Админ", username: "local_admin" };
const customer = { id: 202, first_name: "Алёна", username: "local_customer" };

function tgMessage(from, text, type = "private") {
  return { message: { chat: { id: from.id, type }, from, text } };
}

function tgCallback(from, data) {
  return { callback_query: { id: "callback", data, from, message: { message_id: 1, chat: { id: from.id, type: "private" } } } };
}

test("Telegram login is bound to the requesting browser and the confirming Telegram user", async t => {
  const store = openAuthStore(":memory:");
  const web = createWebServer({
    store, publicOrigin: "http://localhost", adminIds: new Set(["101"]), botUsername: "local_test_bot",
  });
  const calls = [];
  const handle = createRegistrationHandler({
    store, publicOrigin: "http://localhost", username: "local_test_bot",
    callTelegram: async (method, body) => { calls.push({ method, body }); },
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) => web.close(error => error ? reject(error) : resolve()));
    store.close();
  });
  const base = `http://127.0.0.1:${web.address().port}`;
  async function request(path, { body, cookies = "", origin = "http://localhost" } = {}) {
    return fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { Cookie: cookies, ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  const getCookie = response => response.headers.get("set-cookie")?.split(";")[0];

  async function start() {
    const response = await request("/api/auth/start", { body: {} });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    return { ...(await response.json()), browser: getCookie(response) };
  }

  async function approve(login, from) {
    const payload = new URL(login.url).searchParams.get("start");
    assert.equal(await handle(tgMessage(from, `/start ${payload}`, "group")), false);
    assert.equal(await handle(tgMessage(from, `/start ${payload}`)), true);
    const prompt = calls.at(-1).body;
    assert.match(prompt.text, new RegExp(`localhost.*\\nКод: ${login.code}`));
    const callback = prompt.reply_markup.inline_keyboard[0][0].callback_data;
    const other = from.id === admin.id ? customer : admin;
    await handle(tgCallback(other, callback));
    assert.match(calls.at(-1).body.text, /истёк/);
    await handle(tgCallback(from, callback));
    return callback;
  }

  assert.equal((await request("/api/admin/users")).status, 401);
  assert.match(await (await request("/admin")).text(), /Вход в AMIRI VAPE/);
  assert.equal((await request("/.env")).status, 404);
  assert.equal((await request("/data/amiri.sqlite")).status, 404);
  assert.equal((await request("/api/auth/start", { body: {}, origin: "http://elsewhere" })).status, 403);

  const adminLogin = await start();
  const customerLogin = await start();
  const check = (login, browser = login.browser) =>
    request("/api/auth/status", { body: { token: login.token }, cookies: browser });

  assert.deepEqual(await (await check(adminLogin)).json(), { status: "pending" });
  const adminCallback = await approve(adminLogin, admin);
  assert.deepEqual(await (await check(adminLogin, customerLogin.browser)).json(), { status: "expired" });
  const authenticated = await check(adminLogin);
  assert.deepEqual(await authenticated.json(), { status: "authenticated" });
  const adminCookie = getCookie(authenticated);
  assert.equal(getCookie(await check(adminLogin)), adminCookie);
  await handle(tgCallback(admin, adminCallback));
  assert.match(calls.at(-1).body.text, /уже обработан/);
  assert.match(await (await request("/admin", { cookies: adminCookie })).text(), /Админ-панель/);

  await handle(tgMessage(customer, "/register"));
  await approve(customerLogin, customer);
  const customerCookie = getCookie(await check(customerLogin));
  assert.equal((await request("/admin", { cookies: customerCookie })).status, 403);
  assert.equal((await request("/api/admin/users", { cookies: customerCookie })).status, 403);
  const page = await (await request("/api/admin/users?q=" + encodeURIComponent("АЛЕНА"), { cookies: adminCookie })).json();
  assert.equal(page.stats.total, 2);
  assert.equal(page.users.length, 1);
  assert.equal(page.users[0].id, "202");
  assert.equal(page.users[0].isAdmin, false);
  assert.ok(page.users[0].lastLogin);

  const block = (id, blocked) => request("/api/admin/users/access", { body: { id, blocked }, cookies: adminCookie });
  assert.equal((await block("101", true)).status, 409);
  assert.equal((await block("202", true)).status, 200);
  assert.deepEqual((await (await request("/api/session", { cookies: customerCookie })).json()).user, null);
  const blockedLogin = await start();
  await approve(blockedLogin, customer);
  assert.deepEqual(await (await check(blockedLogin)).json(), { status: "denied" });
  assert.equal((await block("202", false)).status, 200);
  const newLogin = await start();
  await approve(newLogin, customer);
  assert.deepEqual(await (await check(newLogin)).json(), { status: "authenticated" });

  assert.equal((await request("/api/auth/logout", { body: {}, cookies: adminCookie })).status, 200);
  assert.deepEqual(await (await check(adminLogin)).json(), { status: "expired" });
});

test("expired and cancelled requests cannot create a session", () => {
  let now = 1_000_000;
  const store = openAuthStore(":memory:", () => now);
  try {
    const expired = store.createChallenge("first-browser");
    assert.ok(store.claim(expired.token, String(customer.id)));
    now = expired.expiresAt;
    assert.equal(store.decide(expired.token, customer, true), "expired");
    assert.deepEqual(store.exchange(expired.token, "first-browser"), { status: "expired" });

    const cancelled = store.createChallenge("second-browser");
    assert.ok(store.claim(cancelled.token, String(customer.id)));
    assert.equal(store.decide(cancelled.token, customer, false), "denied");
    assert.equal(store.decide(cancelled.token, customer, true), "expired");
    assert.deepEqual(store.exchange(cancelled.token, "second-browser"), { status: "denied" });
    assert.equal(store.users("", 1, 30).stats.total, 0);
  } finally {
    store.close();
  }
});
