import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openAuthStore } from "../auth-store.js";
import { createWebServer } from "../server.js";
import { createShopStore } from "../shop-store.js";

test("editors manage products and orders, while inventory and customer boundaries remain consistent", async t => {
  const store = openAuthStore(":memory:");
  const origin = "http://localhost";
  const server = createWebServer({ store, publicOrigin: origin, adminIds: new Set(["10"]) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });

  function session(id, firstName) {
    const browser = randomUUID();
    const { token } = store.createChallenge(browser);
    store.claim(token, String(id));
    store.decide(token, { id, first_name: firstName }, true);
    return "amiri_session=" + store.exchange(token, browser).session;
  }

  const owner = session(10, "Lexx");
  const editor = session(20, "Олег");
  const customer = session(30, "Клиент");
  const other = session(40, "Другой клиент");

  function call(path, cookie, body) {
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, ...(body && { origin, "Content-Type": "application/json" }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  const json = async (path, cookie, body, status = 200) => {
    const response = await call(path, cookie, body);
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };

  await json("/api/admin/products", editor, null, 403);
  await json("/api/admin/users/role", owner, { id: "20", role: "editor" });
  assert.equal((await json("/api/session", editor)).user.role, "editor");
  await json("/api/admin/users", editor, null, 403);
  assert.equal((await call("/admin", editor)).status, 200);
  await json("/api/admin/orders", customer, null, 403);
  await json("/api/admin/categories", customer, null, 403);
  await json("/api/admin/categories", editor, { title: "Расходники", image: "/img/catalog.webp" }, 400);
  const { category } = await json("/api/admin/categories", editor, { title: "Расходники", image: "/img/catalog.png" }, 201);
  await json("/api/admin/categories", editor, { ...category, title: "Картриджи" });
  assert.equal((await json("/api/storefront", customer)).categories.find(row => row.id === category.id).title, "Картриджи");

  const fields = { title: "Проверочная позиция", category: category.id, price: 2500, stock: 10, visible: true };
  await json("/api/admin/products", editor, { ...fields, image: "/img/../private.png" }, 400);
  await json("/api/admin/products", editor, { ...fields, image: "/img/test-pod.jpg" }, 400);
  await json("/api/admin/products", editor, { ...fields, badge: "featured" }, 400);
  const { product } = await json("/api/admin/products", editor, {
    ...fields, image: "/img/test-pod.png", badge: "restock", brand: "Пример", line: "Линейка 1",
  }, 201);
  await json("/api/admin/products", editor, { ...fields, id: product.id, revision: product.revision, price: 2600 });
  await json("/api/admin/products", editor, { ...product, price: 2400 }, 409);
  const listedProduct = async () => (await json("/api/storefront", customer)).products.find(row => row.id === product.id);
  assert.equal((await listedProduct()).image, "/img/test-pod.png");
  assert.equal((await listedProduct()).badge, "restock");
  assert.equal((await listedProduct()).brand, "Пример");
  assert.equal((await listedProduct()).line, "Линейка 1");
  const stock = async () => (await listedProduct()).stock;

  const request = { key: randomUUID(), items: [{ id: product.id, price: 2600, quantity: 3 }] };
  await json("/api/orders", customer, { ...request, items: [{ ...request.items[0], price: 2500 }] }, 409);
  assert.equal(await stock(), 10);
  const { order } = await json("/api/orders", customer, request, 201);
  assert.equal(order.items[0].title, "Линейка 1 · Проверочная позиция");
  assert.equal((await json("/api/orders", customer, request, 201)).order.id, order.id);
  assert.equal(await stock(), 7);
  assert.equal((await json("/api/storefront", other)).orders.length, 0);

  const adjustment = { id: order.id, revision: order.revision, items: [{ id: product.id, quantity: 2 }] };
  const adjusted = (await json("/api/admin/orders/items", editor, adjustment)).order;
  assert.equal(adjusted.total, 5200);
  assert.equal(await stock(), 8);
  await json("/api/admin/orders/items", editor, adjustment, 409);
  await json("/api/admin/orders/items", editor, { ...adjustment, revision: adjusted.revision, items: [{ id: product.id, quantity: 999 }] }, 409);
  await json("/api/admin/orders/status", editor, { id: order.id, expected: "new", state: "cancelled" });
  await json("/api/admin/orders/status", editor, { id: order.id, expected: "new", state: "cancelled" }, 409);
  assert.equal(await stock(), 10);

  const shipment = (await json("/api/orders", customer, { ...request, key: randomUUID() }, 201)).order;
  const move = (expected, state, tracking) =>
    json("/api/admin/orders/status", editor, { id: shipment.id, expected, state, tracking });
  await move("new", "accepted");
  await move("accepted", "packing");
  await json("/api/admin/orders/items", editor, { ...adjustment, id: shipment.id }, 409);
  await move("packing", "shipped", "QA-42");
  const delivered = await move("shipped", "completed");
  assert.equal(delivered.order.tracking, "QA-42");
  assert.equal((await json("/api/admin/orders?state=completed", editor)).orders.length, 1);
  assert.equal((await json("/api/storefront", customer)).orders[0].tracking, "QA-42");
  assert.deepEqual((await json("/api/storefront", other)).top, [product.id]);

  await json("/api/admin/categories/delete", editor, { id: category.id }, 409);
  const activeOrder = (await json("/api/orders", customer, { ...request, key: randomUUID() }, 201)).order;
  const { revision } = await listedProduct();
  const productDeletion = { id: product.id, revision };
  await json("/api/admin/products/delete", customer, productDeletion, 403);
  await json("/api/admin/products/delete", editor, { ...productDeletion, revision: revision - 1 }, 409);
  await json("/api/admin/products/delete", editor, productDeletion);
  await json("/api/admin/products/delete", editor, productDeletion);
  assert.equal((await json("/api/admin/products", editor)).products.length, 0);
  assert.equal(await listedProduct(), undefined);
  assert.deepEqual((await json("/api/storefront", other)).top, []);
  await json("/api/orders", customer, { ...request, key: randomUUID() }, 409);
  await json("/api/admin/categories/delete", editor, { id: category.id });
  await json("/api/admin/categories/delete", editor, { id: category.id });
  await json("/api/admin/products", editor, fields, 400);
  assert.ok(!(await json("/api/storefront", customer)).categories.some(row => row.id === category.id));
  await json("/api/admin/orders/status", editor, { id: activeOrder.id, expected: "new", state: "cancelled" });
  const archived = (await json("/api/storefront", customer)).orders.find(row => row.id === shipment.id);
  assert.deepEqual(archived.items, shipment.items);

  const draftFields = { ...fields, category: 0, price: null, stock: 99, visible: false };
  const { product: draft } = await json("/api/admin/products", editor, draftFields, 201);
  assert.equal(draft.price, null);
  assert.deepEqual((await json("/api/storefront", customer)).products, []);
  const { product: visibleDraft } = await json("/api/admin/products", editor, { ...draft, visible: true });
  assert.deepEqual((await json("/api/storefront", customer)).products, [visibleDraft]);
  assert.deepEqual((await json("/api/admin/products", editor)).products, [visibleDraft]);
  await json("/api/orders", customer, {
    key: randomUUID(), items: [{ id: visibleDraft.id, quantity: 1, price: 1 }],
  }, 409);
  assert.equal((await json("/api/storefront", customer)).products[0].stock, 99);
  const { product: priced } = await json("/api/admin/products", editor, { ...visibleDraft, price: 350, stock: 1 });
  assert.deepEqual((await json("/api/storefront", customer)).products, [priced]);

  await json("/api/admin/users/role", owner, { id: "20", role: "customer" });
  await json("/api/admin/products", editor, null, 403);
});

test("opening a preexisting catalog adds optional card fields without losing products", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE users (telegram_id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT) STRICT;
      CREATE TABLE categories (id INTEGER PRIMARY KEY, title TEXT NOT NULL, image TEXT NOT NULL DEFAULT '') STRICT;
      CREATE TABLE products (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, category INTEGER NOT NULL, price INTEGER NOT NULL,
        stock INTEGER NOT NULL, visible INTEGER NOT NULL, revision INTEGER NOT NULL
      ) STRICT;
      INSERT INTO products VALUES ('existing', 'Старая позиция', 0, 500, 2, 1, 4);
    `);
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = createShopStore(database, action => action(), Date.now);
      assert.deepEqual(store.products(), [{
        id: "existing", title: "Старая позиция", category: 0, price: 500, stock: 2,
        visible: true, revision: 4, image: "", badge: "", brand: "", line: "",
      }]);
      if (attempt === 0) store.deleteCategory(1);
      else assert.ok(!store.categories().some(category => category.id === 1));
    }
  } finally {
    database.close();
  }
});
