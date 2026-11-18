import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import { openAuthStore } from "../auth-store.js";
import { createWebServer } from "../server.js";
import { verifyMiniLaunch } from "../telegram-mini.js";

const token = "12345:fictional-test-token";
const miniOrigin = "https://mini.example.test";
const user = { id: 10001, first_name: "Lexx", username: "test_lexx" };

function signedData(fields) {
  const ordered = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", key).update(ordered).digest("hex") }).toString();
}

test("Telegram launch signatures reject forged identities and stale timestamps", () => {
  const now = 1790000000000;
  const values = { auth_date: String(now / 1000), query_id: "test-query", signature: "test-signature", user: JSON.stringify(user) };
  const signed = signedData(values);
  assert.equal(verifyMiniLaunch(signed, token, now).user.id, user.id);
  assert.equal(verifyMiniLaunch(signed, "another-bot", now), null);
  assert.equal(verifyMiniLaunch(signed + "&auth_date=" + values.auth_date, token, now), null);
  assert.equal(verifyMiniLaunch(signed.replace(String(user.id), "10002"), token, now), null);
  assert.equal(verifyMiniLaunch(signed, token, now + 601_000), null);
  assert.equal(verifyMiniLaunch(signed, token, now - 31_000), null);
});

test("the public Mini App creates a browser-bound session without changing local login", async t => {
  const store = openAuthStore(":memory:");
  const server = createWebServer({ store, publicOrigin: "http://localhost:3000", miniOrigin, botToken: token, botUsername: "qa_bot" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  function call(path, options = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = request({
        hostname: "127.0.0.1", port: server.address().port, path, method: options.body ? "POST" : "GET",
        headers: {
          host: options.host || "mini.example.test", cookie: options.cookie || "",
          ...(options.body && { origin: options.origin || miniOrigin, "content-type": "application/json" }),
        },
      }, incoming => {
        incoming.setEncoding("utf8");
        let data = "";
        incoming.on("data", chunk => { data += chunk; });
        incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, data }));
      });
      outgoing.on("error", reject);
      outgoing.end(options.body ? JSON.stringify(options.body) : undefined);
    });
  }
  const cookieFrom = result => result.headers["set-cookie"][0].split(";")[0];
  const local = await call("/", { host: "localhost:3000" });
  assert.match(local.data, /Вход в AMIRI VAPE/);
  assert.equal((await call("/mini", { host: "localhost:3000" })).status, 404);
  const boot = await call("/mini");
  assert.match(boot.data, /telegram-web-app\.js/);
  assert.match(boot.headers["content-security-policy"], /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.match(boot.headers["set-cookie"][0], /HttpOnly; Secure; SameSite=None; Partitioned/);
  const browser = cookieFrom(boot);
  const initData = signedData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const login = options => call("/api/auth/telegram", { cookie: browser, body: { initData }, ...options });
  assert.equal((await login({ origin: "https://evil.example" })).status, 403);
  const confirmed = await login();
  assert.equal(confirmed.status, 200);
  const session = cookieFrom(confirmed);
  assert.equal(cookieFrom(await login()), session);
  assert.equal((await login({ cookie: cookieFrom(await call("/mini")) })).status, 401);
  assert.equal((await call("/api/auth/start", { body: {} })).status, 404);
  const shop = await call("/mini-app", { cookie: session });
  assert.match(shop.data, /class="telegram-mini"/);
  assert.equal(JSON.parse((await call("/api/session", { cookie: session })).data).user.id, String(user.id));
  assert.equal(JSON.parse((await call("/api/session", { host: "localhost:3000", cookie: session })).data).user, null);
  assert.equal((await call("/api/auth/logout", { cookie: session, body: {} })).status, 200);
  assert.equal((await login()).status, 401);
});
