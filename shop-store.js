import { randomUUID } from "node:crypto";
import catalog from "./catalog-data.cjs";

export const orderTransitions = {
  forming: [],
  new: ["accepted", "cancelled"],
  accepted: ["packing", "cancelled"],
  packing: ["shipped", "cancelled"],
  shipped: ["completed"],
  completed: [],
  cancelled: [],
};

export class ShopError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const publicProduct = ({ deleted_at, price_pending, ...row }) => ({
  ...row, price: price_pending ? null : row.price, visible: Boolean(row.visible),
});

export function createShopStore(db, transaction, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      image TEXT NOT NULL DEFAULT '',
      deleted_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category INTEGER NOT NULL,
      price INTEGER NOT NULL CHECK (price > 0),
      price_pending INTEGER NOT NULL DEFAULT 0 CHECK (price_pending IN (0, 1)),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
      image TEXT NOT NULL DEFAULT '',
      badge TEXT NOT NULL DEFAULT '' CHECK (badge IN ('', 'new', 'restock')),
      brand TEXT NOT NULL DEFAULT '',
      line TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS shop_orders (
      id INTEGER PRIMARY KEY,
      telegram_id TEXT NOT NULL REFERENCES users (telegram_id),
      request_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'new',
      total INTEGER NOT NULL,
      tracking TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (telegram_id, request_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS shop_orders_user ON shop_orders (telegram_id, id DESC);
    CREATE TABLE IF NOT EXISTS shop_order_lines (
      order_id INTEGER NOT NULL REFERENCES shop_orders (id),
      product_id TEXT NOT NULL REFERENCES products (id),
      title TEXT NOT NULL,
      price INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (order_id, product_id)
    ) STRICT;
  `);

  transaction(() => {
    const columns = new Set(db.prepare("PRAGMA table_info(products)").all().map(column => column.name));
    if (!columns.has("image")) db.exec("ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT ''");
    if (!columns.has("badge")) db.exec("ALTER TABLE products ADD COLUMN badge TEXT NOT NULL DEFAULT '' CHECK (badge IN ('', 'new', 'restock'))");
    if (!columns.has("brand")) db.exec("ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT ''");
    if (!columns.has("line")) db.exec("ALTER TABLE products ADD COLUMN line TEXT NOT NULL DEFAULT ''");
    if (!columns.has("deleted_at")) db.exec("ALTER TABLE products ADD COLUMN deleted_at INTEGER");
    if (!columns.has("price_pending")) {
      db.exec("ALTER TABLE products ADD COLUMN price_pending INTEGER NOT NULL DEFAULT 0 CHECK (price_pending IN (0, 1))");
    }
    const orderColumns = new Set(db.prepare("PRAGMA table_info(shop_orders)").all().map(column => column.name));
    if (!orderColumns.has("editable_until")) db.exec("ALTER TABLE shop_orders ADD COLUMN editable_until INTEGER");
    if (!orderColumns.has("delivery")) db.exec("ALTER TABLE shop_orders ADD COLUMN delivery TEXT");
    if (!orderColumns.has("status_undo")) db.exec("ALTER TABLE shop_orders ADD COLUMN status_undo TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_order_notifications (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL,
        telegram_id TEXT NOT NULL,
        state TEXT NOT NULL,
        tracking TEXT NOT NULL,
        available_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS telegram_order_notifications_recipient ON telegram_order_notifications (telegram_id, id);
      CREATE TABLE IF NOT EXISTS telegram_order_cards (
        chat_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (chat_id, order_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS telegram_order_prompts (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        actor_id INTEGER NOT NULL,
        product_id TEXT,
        PRIMARY KEY (chat_id, message_id)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS telegram_order_created AFTER INSERT ON shop_orders BEGIN
        INSERT INTO telegram_order_notifications (order_id, telegram_id, state, tracking)
        VALUES (NEW.id, NEW.telegram_id, NEW.state, NEW.tracking);
      END;
      CREATE TRIGGER IF NOT EXISTS telegram_order_status_changed AFTER UPDATE OF state ON shop_orders
      WHEN OLD.state <> NEW.state BEGIN
        INSERT INTO telegram_order_notifications (order_id, telegram_id, state, tracking)
        VALUES (NEW.id, NEW.telegram_id, NEW.state, NEW.tracking);
      END;
    `);
    db.exec("CREATE INDEX IF NOT EXISTS shop_orders_forming ON shop_orders (editable_until) WHERE state = 'forming'");
    if (!db.prepare("PRAGMA table_info(categories)").all().some(column => column.name === "deleted_at")) {
      db.exec("ALTER TABLE categories ADD COLUMN deleted_at INTEGER");
    }
    const ensureCategory = db.prepare("INSERT OR IGNORE INTO categories (id, title) VALUES (?, ?)");
    catalog.categories.forEach((title, id) => ensureCategory.run(id, title));
  });

  const product = db.prepare("SELECT * FROM products WHERE id = ?");
  const categoryById = db.prepare("SELECT deleted_at FROM categories WHERE id = ?");
  const insertProduct = db.prepare(`
    INSERT INTO products (id, title, category, price, price_pending, stock, visible, image, badge, brand, line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `);

  const findOrder = db.prepare("SELECT * FROM shop_orders WHERE id = ?");
  const lineRows = db.prepare("SELECT product_id AS id, title, price, quantity FROM shop_order_lines WHERE order_id = ? ORDER BY rowid");
  const insertOrder = db.prepare(`
    INSERT INTO shop_orders (telegram_id, request_key, total, created_at, updated_at, state, editable_until, delivery)
    VALUES (?, ?, ?, ?, ?, 'forming', ?, ?)
  `);
  const insertLine = db.prepare("INSERT INTO shop_order_lines (order_id, product_id, title, price, quantity) VALUES (?, ?, ?, ?, ?)");
  const changeStock = db.prepare("UPDATE products SET stock = stock + ?, revision = revision + 1 WHERE id = ?");
  const expiredOrder = db.prepare("SELECT 1 FROM shop_orders WHERE state = 'forming' AND editable_until <= ? LIMIT 1");
  const confirmExpired = db.prepare(`
    UPDATE shop_orders SET state = 'new', updated_at = editable_until, revision = revision + 1
    WHERE state = 'forming' AND editable_until <= ?
  `);
  const orderForDisplay = row => ({
    id: row.id, state: row.state, total: row.total, tracking: row.tracking, createdAt: row.created_at,
    updatedAt: row.updated_at, revision: row.revision, items: lineRows.all(row.id),
    editableUntil: row.state === "forming" ? row.editable_until : null,
    delivery: row.delivery ? JSON.parse(row.delivery) : null,
    ...(row.first_name === undefined ? {} : {
      customer: { id: row.telegram_id, firstName: row.first_name, lastName: row.last_name, username: row.username },
    }),
  });

  const statusUndo = order => order.status_undo ? JSON.parse(order.status_undo) : null;

  function staffOrder(row) {
    const undo = statusUndo(row);
    return { ...orderForDisplay(row), statusUndo: undo && { state: undo.state } };
  }

  function advanceExpiredOrders() {
    const timestamp = now();
    if (expiredOrder.get(timestamp)) confirmExpired.run(timestamp);
  }

  function checkMinimum(total) {
    if (total < catalog.minimumOrderTotal) throw new ShopError(400, "Минимальная сумма заказа — 1 500 ₽.");
  }

  function adjustLines(order, items, delivery) {
    const existing = lineRows.all(order.id);
    const quantities = new Map(items.map(item => [item.id, item.quantity]));
    if (existing.length !== quantities.size || existing.some(row => !quantities.has(row.id)) ||
        items.every(item => item.quantity === 0)) {
      throw new ShopError(400, "В заказе должна остаться хотя бы одна позиция.");
    }
    const total = existing.reduce((sum, row) => sum + row.price * quantities.get(row.id), 0);
    if (delivery || order.delivery) checkMinimum(total);
    const update = db.prepare("UPDATE shop_order_lines SET quantity = ? WHERE order_id = ? AND product_id = ?");
    const remove = db.prepare("DELETE FROM shop_order_lines WHERE order_id = ? AND product_id = ?");
    for (const row of existing) {
      const quantity = quantities.get(row.id);
      const difference = row.quantity - quantity;
      if (difference < 0) {
        const current = product.get(row.id);
        if (!current.visible || current.stock < -difference) throw new ShopError(409, "Недостаточный остаток для увеличения количества.");
      }
      if (difference) {
        changeStock.run(difference, row.id);
        if (quantity) update.run(quantity, order.id, row.id);
        else remove.run(order.id, row.id);
      }
    }
    db.prepare("UPDATE shop_orders SET total = ?, delivery = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(total, delivery ? JSON.stringify(delivery) : order.delivery, now(), order.id);
    return orderForDisplay(findOrder.get(order.id));
  }

  return {
    categories() {
      return db.prepare("SELECT id, title, image FROM categories WHERE deleted_at IS NULL ORDER BY id").all();
    },
    saveCategory({ id, title, image }) {
      if (id === undefined) {
        return db.prepare("INSERT INTO categories (title, image) VALUES (?, ?) RETURNING id, title, image").get(title, image);
      }
      const category = db.prepare(`
        UPDATE categories SET title = ?, image = ?
        WHERE id = ? AND deleted_at IS NULL RETURNING id, title, image
      `).get(title, image, id);
      if (!category) throw new ShopError(404, "Категория не найдена.");
      return category;
    },
    deleteCategory(id) {
      const { changes } = db.prepare(`
        UPDATE categories SET deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM products WHERE category = categories.id AND deleted_at IS NULL)
      `).run(now(), id);
      if (changes) return;
      const category = categoryById.get(id);
      if (!category) throw new ShopError(404, "Категория не найдена.");
      if (category.deleted_at === null) {
        throw new ShopError(409, "Перенесите или удалите все позиции этой категории.");
      }
    },
    products(includeHidden = false) {
      return db.prepare(`SELECT * FROM products WHERE deleted_at IS NULL ${includeHidden ? "" : "AND visible = 1"} ORDER BY rowid`)
        .all().map(publicProduct);
    },
    topProducts() {
      const rows = db.prepare(`
        SELECT products.id, products.category, products.brand, products.line, SUM(items.quantity) AS sold
        FROM shop_order_lines AS items
        JOIN shop_orders AS orders ON orders.id = items.order_id
        JOIN products ON products.id = items.product_id
        WHERE orders.state = 'completed' AND orders.updated_at >= ?
          AND products.visible = 1 AND products.price_pending = 0 AND products.deleted_at IS NULL
        GROUP BY items.product_id
        ORDER BY sold DESC, products.id
      `).all(now() - 30 * 86_400_000);
      const lines = new Map();
      for (const row of rows) {
        const key = catalog.lineKey(row);
        const line = lines.get(key);
        if (line) line.sold += row.sold;
        else lines.set(key, { id: row.id, sold: row.sold });
      }
      return [...lines.values()].sort((a, b) => b.sold - a.sold).slice(0, catalog.topProductLimit).map(line => line.id);
    },
    saveProduct(id, fields) {
      return transaction(() => {
        if (categoryById.get(fields.category)?.deleted_at !== null) {
          throw new ShopError(400, "Выберите существующую категорию.");
        }
        const pricePending = fields.price === null;
        // Unpriced products use a positive storage value to satisfy the existing SQLite constraint.
        const values = [fields.title, fields.category, fields.price ?? 1, Number(pricePending), fields.stock, Number(fields.visible)];
        if (!id) {
          return publicProduct(insertProduct.get(randomUUID(), ...values, fields.image ?? "", fields.badge ?? "", fields.brand ?? "", fields.line ?? ""));
        }
        const updated = db.prepare(`
          UPDATE products SET title = ?, category = ?, price = ?, price_pending = ?, stock = ?, visible = ?,
            image = COALESCE(?, image), badge = COALESCE(?, badge), brand = COALESCE(?, brand),
            line = COALESCE(?, line), revision = revision + 1
          WHERE id = ? AND revision = ? AND deleted_at IS NULL RETURNING *
        `).get(...values, fields.image ?? null, fields.badge ?? null, fields.brand ?? null, fields.line ?? null, id, fields.revision);
        if (!updated) throw new ShopError(409, "Позиция изменилась. Откройте её заново.");
        return publicProduct(updated);
      });
    },
    deleteProduct(id, revision) {
      // Keep the product row for existing orders and their inventory adjustments.
      const { changes } = db.prepare(`
        UPDATE products SET deleted_at = ?, visible = 0, revision = revision + 1
        WHERE id = ? AND revision = ? AND deleted_at IS NULL
      `).run(now(), id, revision);
      if (changes) return;
      const current = product.get(id);
      if (!current) throw new ShopError(404, "Позиция не найдена.");
      if (current.deleted_at === null) throw new ShopError(409, "Позиция изменилась. Откройте её заново.");
    },
    submit(telegramId, key, items, delivery) {
      advanceExpiredOrders();
      return transaction(() => {
        const existing = db.prepare("SELECT * FROM shop_orders WHERE telegram_id = ? AND request_key = ?")
          .get(telegramId, key);
        if (existing) return orderForDisplay(existing);
        const lines = items.map(({ id, quantity, price }) => {
          const current = product.get(id);
          if (!current?.visible || current.price_pending || current.deleted_at !== null || current.stock < quantity) {
            throw new ShopError(409, "Остатки изменились. Проверьте корзину.");
          }
          if (current.price !== price) throw new ShopError(409, "Цены изменились. Проверьте корзину.");
          return { ...current, quantity };
        });
        const total = lines.reduce((sum, row) => sum + row.price * row.quantity, 0);
        checkMinimum(total);
        const timestamp = now();
        const id = Number(insertOrder.run(telegramId, key, total, timestamp, timestamp, timestamp + 180_000,
          JSON.stringify(delivery)).lastInsertRowid);
        for (const row of lines) {
          changeStock.run(-row.quantity, row.id);
          insertLine.run(id, row.id, row.line ? row.line + " · " + row.title : row.title, row.price, row.quantity);
        }
        return orderForDisplay(findOrder.get(id));
      });
    },
    changeCustomerOrder(telegramId, id, action, revision, items, delivery) {
      advanceExpiredOrders();
      return transaction(() => {
        const order = findOrder.get(id);
        if (order?.telegram_id !== telegramId) throw new ShopError(404, "Заказ не найден.");
        const timestamp = now();
        if (order.state !== "forming" || timestamp >= order.editable_until) {
          throw new ShopError(409, "Заказ больше нельзя изменить или отменить.");
        }
        if (action === "edit") {
          if (order.revision !== revision) throw new ShopError(409, "Заказ изменился. Откройте его заново.");
          return adjustLines(order, items, delivery);
        }
        if (action === "cancel") {
          for (const row of lineRows.all(id)) changeStock.run(row.quantity, row.id);
        }
        db.prepare("UPDATE shop_orders SET state = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(action === "cancel" ? "cancelled" : "new", timestamp, id);
        return orderForDisplay(findOrder.get(id));
      });
    },
    customerOrders(telegramId) {
      advanceExpiredOrders();
      return db.prepare("SELECT * FROM shop_orders WHERE telegram_id = ? ORDER BY id DESC LIMIT 100")
        .all(telegramId).map(row => ({ ...orderForDisplay(row), returnToCart: row.state === "cancelled" }));
    },
    cartReturns(telegramId) {
      const cancelled = db.prepare("SELECT id FROM shop_orders WHERE telegram_id = ? AND state = 'cancelled' ORDER BY id")
        .all(telegramId);
      return cancelled.map(({ id }) => ({ id, items: lineRows.all(id) }));
    },
    orders(state, page, limit) {
      advanceExpiredOrders();
      const from = "FROM shop_orders AS orders JOIN users USING (telegram_id) WHERE (? = '' OR orders.state = ?)";
      const count = db.prepare(`SELECT count(*) AS count ${from}`).get(state, state).count;
      const pages = Math.max(1, Math.ceil(count / limit));
      const currentPage = Math.min(page, pages);
      const orders = db.prepare(`
        SELECT orders.*, users.first_name, users.last_name, users.username ${from} ORDER BY orders.id DESC LIMIT ? OFFSET ?
      `).all(state, state, limit, (currentPage - 1) * limit);
      return { orders: orders.map(staffOrder), page: currentPage, pages };
    },
    updateOrder(id, expected, next, tracking, revision) {
      advanceExpiredOrders();
      return transaction(() => {
        const order = findOrder.get(id);
        if (!order) throw new ShopError(404, "Заказ не найден.");
        if (order.state !== expected || (revision !== undefined && revision !== order.revision) || !orderTransitions[order.state].includes(next)) {
          throw new ShopError(409, "Статус заказа изменился. Обновите список.");
        }
        if (next === "cancelled") {
          for (const row of lineRows.all(id)) changeStock.run(row.quantity, row.id);
        }
        const undo = { state: order.state, tracking: order.tracking };
        db.prepare(`
          UPDATE shop_orders SET state = ?, tracking = ?, updated_at = ?, revision = revision + 1, status_undo = ? WHERE id = ?
        `).run(next, next === "shipped" ? tracking : order.tracking, now(), JSON.stringify(undo), id);
        return staffOrder(findOrder.get(id));
      });
    },
    undoOrderStatus(id, revision) {
      return transaction(() => {
        const order = findOrder.get(id);
        if (!order) throw new ShopError(404, "Заказ не найден.");
        const undo = statusUndo(order);
        if (!undo || order.revision !== revision) throw new ShopError(409, "Откат недоступен или заказ уже изменился. Обновите список.");
        if (order.state === "cancelled") {
          const lines = lineRows.all(id);
          if (lines.some(row => product.get(row.id).stock < row.quantity)) {
            throw new ShopError(409, "Недостаточно товара на складе, чтобы восстановить заказ.");
          }
          for (const row of lines) changeStock.run(-row.quantity, row.id);
        }
        db.prepare(`
          UPDATE shop_orders SET state = ?, tracking = ?, updated_at = ?, revision = revision + 1, status_undo = NULL WHERE id = ?
        `).run(undo.state, undo.tracking, now(), id);
        return staffOrder(findOrder.get(id));
      });
    },
    adjustOrder(id, revision, items) {
      advanceExpiredOrders();
      return transaction(() => {
        const order = findOrder.get(id);
        if (!order) throw new ShopError(404, "Заказ не найден.");
        if (order.revision !== revision || !["new", "accepted"].includes(order.state)) {
          throw new ShopError(409, "Заказ изменился или уже передан на сборку.");
        }
        return adjustLines(order, items);
      });
    },
    telegramOrder(id) {
      const order = findOrder.get(id);
      return order ? staffOrder(order) : null;
    },
    telegramNotifications() {
      advanceExpiredOrders();
      return db.prepare(`
        SELECT events.* FROM telegram_order_notifications AS events
        WHERE events.available_at <= ? AND NOT EXISTS (
          SELECT 1 FROM telegram_order_notifications AS earlier
          WHERE earlier.telegram_id = events.telegram_id AND earlier.id < events.id
        ) ORDER BY events.id LIMIT 8
      `).all(now());
    },
    finishTelegramNotification(id) {
      db.prepare("DELETE FROM telegram_order_notifications WHERE id = ?").run(id);
    },
    retryTelegramNotification(id, wait) {
      db.prepare("UPDATE telegram_order_notifications SET available_at = ? WHERE id = ?").run(now() + wait, id);
    },
    resumeTelegramNotifications(telegramId) {
      db.prepare("UPDATE telegram_order_notifications SET available_at = 0 WHERE telegram_id = ? AND available_at > ?")
        .run(telegramId, now() + 60_000);
    },
    pendingTelegramCards(chatId) {
      return db.prepare(`
        SELECT orders.*, cards.message_id FROM shop_orders AS orders
        LEFT JOIN telegram_order_cards AS cards ON cards.chat_id = ? AND cards.order_id = orders.id
        WHERE (cards.message_id IS NULL AND orders.state NOT IN ('cancelled', 'completed'))
           OR cards.revision < orders.revision
        ORDER BY orders.id LIMIT 8
      `).all(chatId).map(row => ({ order: staffOrder(row), messageId: row.message_id }));
    },
    saveTelegramCard(chatId, order, messageId) {
      db.prepare(`
        INSERT INTO telegram_order_cards (chat_id, order_id, message_id, revision) VALUES (?, ?, ?, ?)
        ON CONFLICT (chat_id, order_id) DO UPDATE SET message_id = excluded.message_id, revision = excluded.revision
      `).run(chatId, order.id, messageId, order.revision);
    },
    telegramCardMessage(chatId, orderId) {
      return db.prepare("SELECT message_id FROM telegram_order_cards WHERE chat_id = ? AND order_id = ?")
        .get(chatId, orderId)?.message_id;
    },
    saveTelegramPrompt(chatId, messageId, order, actor, productId) {
      return transaction(() => {
        const replaced = db.prepare(`
          DELETE FROM telegram_order_prompts WHERE chat_id = ? AND actor_id = ? AND message_id <> ? RETURNING *
        `).all(chatId, actor, messageId);
        db.prepare(`
          INSERT INTO telegram_order_prompts VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (chat_id, message_id) DO UPDATE SET
            order_id = excluded.order_id, revision = excluded.revision, actor_id = excluded.actor_id, product_id = excluded.product_id
        `).run(chatId, messageId, order.id, order.revision, actor, productId);
        return replaced;
      });
    },
    telegramPrompt(chatId, messageId) {
      return db.prepare("SELECT * FROM telegram_order_prompts WHERE chat_id = ? AND message_id = ?").get(chatId, messageId);
    },
    telegramPromptForActor(chatId, actor) {
      const prompts = db.prepare("SELECT * FROM telegram_order_prompts WHERE chat_id = ? AND actor_id = ? LIMIT 2").all(chatId, actor);
      return prompts.length === 1 ? prompts[0] : undefined;
    },
    clearTelegramPromptsForActor(chatId, actor) {
      return db.prepare("DELETE FROM telegram_order_prompts WHERE chat_id = ? AND actor_id = ? RETURNING *").all(chatId, actor);
    },
    clearTelegramPrompt(chatId, messageId) {
      db.prepare("DELETE FROM telegram_order_prompts WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
    },
  };
}
