import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openAuthStore } from "../auth-store.js";
import { createTelegramOrders } from "../telegram-orders.js";

test("Telegram order cards use site staff permissions and share order status and inventory with the website", async t => {
  let now = Date.now();
  const store = openAuthStore(":memory:", () => now);
  const shop = store.shop;
  const stop = new AbortController();
  const admin = { id: 10, first_name: "Админ" };
  const customer = { id: 20, first_name: "Покупатель" };
  const group = { id: -1001234567890, type: "supergroup" };
  const outside = { id: -99, type: "group" };
  store.register(admin);
  store.register(customer);
  const product = shop.saveProduct(null, { title: "Тестовая позиция", category: 0, price: 500, stock: 20, visible: true });
  const orders = [];
  const cards = new Map();
  const calls = [];
  let nextMessage = 0;
  const bot = createTelegramOrders({
    store, groupId: group.id, adminIds: new Set(["10"]), publicOrigin: "https://store.example",
    miniAppUrl: "https://mini.example/mini",
    async callTelegram(method, body) {
      calls.push({ method, body });
      if (method === "sendMessage") {
        const messageId = ++nextMessage;
        if (body.chat_id === group.id) cards.set(messageId, body);
        if (String(body.chat_id) === "20") orders.push(body);
        return { message_id: messageId };
      }
      if (method === "editMessageText") cards.set(body.message_id, body);
      return true;
    },
  });
  const worker = bot.run(stop.signal);
  t.after(async () => { stop.abort(); await worker; store.close(); });

  async function until(condition) {
    for (let i = 0; i < 300; i++) {
      const result = condition();
      if (result) return result;
      await delay(20);
    }
    throw new Error("Timed out waiting for Telegram delivery");
  }

  const create = () => shop.submit("20", randomUUID(), [{ id: product.id, quantity: 3, price: 500 }], {
    pointNumber: "001234", address: "Тестовый адрес", fullName: "Иванов Иван", ageConfirmed: true,
  });
  const order = create();
  await bot.handle({ my_chat_member: { chat: outside, new_chat_member: { status: "member" } } });
  assert.deepEqual(calls.find(entry => entry.method === "leaveChat").body, { chat_id: outside.id });
  const messageId = await until(() => shop.telegramCardMessage(group.id, order.id));
  const findButton = text => cards.get(messageId)?.reply_markup.inline_keyboard.flat().find(button => button.text === text);
  const click = (button, from = admin, chat = group) => bot.handle({ callback_query: {
    id: "callback", from, data: button.callback_data, message: { chat, message_id: messageId },
  } });
  const input = (text, from = admin, replyTo) => bot.handle({ message: {
    chat: group, from, text, message_id: 777,
    ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
  } });

  await until(() => orders.some(message => message.text.startsWith("Ваш заказ сформирован!")));
  assert.equal(findButton("Принять"), undefined);
  now = order.editableUntil;
  const accept = await until(() => findButton("Принять"));
  await click(accept, customer);
  assert.equal(shop.telegramOrder(order.id).state, "new");
  assert.match(calls.at(-1).body.text, /нет доступа/);
  await click(accept);
  await until(() => findButton("Передать на сборку"));
  await click(findButton("Изменить количество"));
  assert.match(cards.get(messageId).text, /Какой товар вы хотите изменить/);
  await click(findButton("Назад"));
  await click(findButton("Изменить количество"));
  await click(findButton("Тестовая позиция · 3 шт."));
  assert.match(cards.get(messageId).text, /Укажите корректное количество/);
  await click(findButton("Назад"));
  await click(findButton("Тестовая позиция · 3 шт."));
  await input("4", customer);
  await input("4", admin, 111);
  assert.equal(shop.telegramOrder(order.id).items[0].quantity, 3);
  await input("4");
  assert.equal(shop.telegramOrder(order.id).items[0].quantity, 4);
  assert.match(calls.at(-1).body.text, /количество обновлено/);
  assert.equal(shop.products()[0].stock, 16);
  const adjusted = shop.telegramOrder(order.id);
  shop.updateOrder(order.id, "accepted", "packing", "", adjusted.revision);
  await click(await until(() => findButton("Отметить отправленным")));
  assert.match(cards.get(messageId).text, /Отправьте номер СДЭК/);
  await input("Сейчас пришлю");
  assert.equal(shop.telegramOrder(order.id).state, "packing");
  await input("1234567890");
  assert.equal(shop.telegramOrder(order.id).tracking, "1234567890");
  assert.match(calls.at(-1).body.text, /трек-номер сохранён/);
  await until(() => orders.some(message => message.text.includes("Трек-номер: 1234567890")));
  assert.ok(orders.some(message => message.text.startsWith("Статус заказа изменился")));
  await click(await until(() => findButton("Завершить")));
  assert.equal(shop.telegramOrder(order.id).state, "completed");

  const cancelled = create();
  shop.changeCustomerOrder("20", cancelled.id, "cancel");
  assert.equal(shop.customerOrders("20").find(row => row.id === cancelled.id).returnToCart, true);
  assert.equal(shop.products()[0].stock, 16);
  const notice = await until(() => orders.find(message => message.text.startsWith(`Заказ №${cancelled.id} отменён`)));
  const [contact, cart] = notice.reply_markup.inline_keyboard.flat();
  assert.equal(contact.url, "https://t.me/amirivapemanager1");
  assert.equal(cart.web_app.url, "https://mini.example/mini?cart=1");
});

test("Telegram group order lookups include archived orders and are restricted to staff", async t => {
  const store = openAuthStore(":memory:");
  t.after(() => store.close());
  const shop = store.shop;
  const admin = { id: 10, first_name: "Админ" };
  const customer = { id: 20, first_name: "Покупатель" };
  const chat = { id: -1001234567890, type: "supergroup" };
  store.register(customer);
  const product = shop.saveProduct(null, { title: "Позиция из истории", category: 0, price: 1500, stock: 20, visible: true });
  const orders = Array.from({ length: 9 }, () => {
    const order = shop.submit("20", randomUUID(), [{ id: product.id, quantity: 1, price: 1500 }], {
      pointNumber: "001234", address: "Тестовый адрес", fullName: "Иванов Иван", ageConfirmed: true,
    });
    shop.changeCustomerOrder("20", order.id, "cancel");
    return order;
  });
  const active = shop.submit("20", randomUUID(), [{ id: product.id, quantity: 1, price: 1500 }], {
    pointNumber: "001234", address: "Тестовый адрес", fullName: "Иванов Иван", ageConfirmed: true,
  });
  const calls = [];
  const bot = createTelegramOrders({ store, groupId: chat.id, adminIds: new Set(["10"]), username: "local_bot",
    callTelegram: async (method, body) => { calls.push({ method, body }); return { message_id: calls.length }; },
  });
  const message = (text, from = admin) => bot.handle({ message: { chat, from, text } });
  const click = (data, from = admin) => bot.handle({ callback_query: { id: "test", data, from, message: { chat, message_id: 1 } } });
  const latest = method => calls.findLast(call => call.method === method)?.body;

  await message("/show_all", customer);
  assert.equal(calls.length, 0);
  await message("/show_all@local_bot");
  const menu = latest("sendMessage");
  assert.equal(menu.text, "Выберите статус заказов");
  assert.equal(menu.reply_markup.inline_keyboard.flat().length, 8);
  const all = menu.reply_markup.inline_keyboard[0][0];
  assert.equal(all.text, "Все заказы");
  await click(all.callback_data);
  const firstPage = latest("editMessageText");
  assert.match(firstPage.text, /Все заказы[\s\S]*страница 1 из 2/);
  assert.equal(firstPage.reply_markup.inline_keyboard[0][0].callback_data, `lookup:order:${active.id}`);
  assert.equal(firstPage.reply_markup.inline_keyboard[1][0].callback_data, `lookup:order:${orders.at(-1).id}`);
  await click("lookup:all:2");
  assert.equal(latest("editMessageText").reply_markup.inline_keyboard[1][0].callback_data, `lookup:order:${orders[0].id}`);
  await click("lookup:cancelled:1", customer);
  assert.match(latest("answerCallbackQuery").text, /нет доступа/);
  await click("lookup:cancelled:1");
  assert.match(latest("editMessageText").text, /страница 1 из 2/);
  await click("lookup:cancelled:2");
  const archived = latest("editMessageText").reply_markup.inline_keyboard[0][0];
  assert.equal(archived.callback_data, `lookup:order:${orders[0].id}`);
  await click(archived.callback_data);
  assert.match(latest("sendMessage").text, /Отменён[\s\S]*Позиция из истории/);

  await message("/show_id");
  assert.equal(latest("sendMessage").text, "Укажите номер заказа");
  await message(String(orders[0].id), customer);
  assert.equal(latest("sendMessage").text, "Укажите номер заказа");
  await message("№" + orders[0].id);
  assert.match(latest("sendMessage").text, /Позиция из истории/);
  assert.equal(latest("sendMessage").reply_markup, undefined);
  assert.equal(shop.cartReturns("20").length, 9);
  assert.equal(shop.cartReturns("10").length, 0);
});
