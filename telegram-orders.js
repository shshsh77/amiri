import { setTimeout as delay } from "node:timers/promises";
import { orderTransitions, ShopError } from "./shop-store.js";

const statusLabels = {
  forming: "Заказ формируется", new: "Новый", accepted: "Принят", packing: "На сборке",
  shipped: "Отправлен", completed: "Завершён", cancelled: "Отменён",
};
const actionLabels = {
  accepted: "Принять", cancelled: "Отклонить", packing: "Передать на сборку",
  shipped: "Отметить отправленным", completed: "Завершить", undo: "Откатить статус",
};
const canAdjust = state => state === "new" || state === "accepted";
const manager = "@amirivapemanager1";
const rubles = new Intl.NumberFormat("ru-RU");
const formatMoney = amount => `${rubles.format(amount)} ₽`;
const code = /^ord:(\d{1,16}):(\d{1,16}):([a-z]+)(?::(\d{1,2}))?$/;
const lookupCode = /^lookup:(filters|[a-z]+:[1-9]\d{0,15})$/;
const shopGroup = chat => chat?.type === "group" || chat?.type === "supergroup";

function button(order, text, action, item) {
  return { text, callback_data: `ord:${order.id}:${order.revision}:${action}${item === undefined ? "" : `:${item}`}` };
}

function orderText(order) {
  const items = order.items.map(item => `• ${item.title} — ${item.quantity} шт.`).join("\n");
  return [
    `Заказ №${order.id} · ${formatMoney(order.total)}`,
    `Статус: ${statusLabels[order.state]}`,
    order.tracking && `Трек-номер: ${order.tracking}`,
    items.length > 3650 ? items.slice(0, 3650) + "…" : items,
  ].filter(Boolean).join("\n\n");
}

function card(order) {
  const actions = orderTransitions[order.state].map(action => button(order,
    action === "cancelled" && order.state !== "new" ? "Отменить заказ" : actionLabels[action], action));
  const tools = [];
  if (canAdjust(order.state)) tools.push(button(order, "Изменить количество", "items"));
  if (order.statusUndo) tools.push(button(order, actionLabels.undo, "undo"));
  return { text: orderText(order), reply_markup: { inline_keyboard: [actions, tools].filter(row => row.length) } };
}

const lookupButton = (text, data) => ({ text, callback_data: `lookup:${data}` });
const allOrdersLabel = "Все заказы";

function statusMenu() {
  const buttons = Object.entries(statusLabels).map(([state, label]) => lookupButton(label, `${state}:1`));
  const rows = [[lookupButton(allOrdersLabel, "all:1")]];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { text: "Выберите статус заказов", reply_markup: { inline_keyboard: rows } };
}

function customerMessage(event, publicOrigin, miniAppUrl) {
  const status = `Статус заказа: ${statusLabels[event.state]}`;
  if (event.state === "cancelled") {
    const cart = miniAppUrl ? new URL(miniAppUrl) : new URL("/#cart", publicOrigin);
    if (miniAppUrl) cart.searchParams.set("cart", "1");
    return {
      text: `Заказ №${event.order_id} отменён.\n\nВсе товары перенесены обратно в корзину.`,
      reply_markup: { inline_keyboard: [
        [{ text: "Связаться с менеджером", url: `https://t.me/${manager.slice(1)}` }],
        [{ text: "Перейти в корзину", ...(miniAppUrl ? { web_app: { url: cart.href } } : { url: cart.href }) }],
      ] },
    };
  }
  const heading = event.state === "forming" ? "Ваш заказ сформирован!"
    : event.state === "shipped" ? "Ваш заказ передан в доставку" : "Статус заказа изменился";
  const tracking = event.state === "shipped" ? `\n\nТрек-номер: ${event.tracking || "уточняется у менеджера"}` : "";
  return { text: `${heading}\n\nНомер заказа: ${event.order_id}\n\nTelegram для связи с менеджером: ${manager}\n\n${status}${tracking}` };
}

export function createTelegramOrders({ store, callTelegram, groupId, adminIds, publicOrigin, miniAppUrl, username }) {
  const shop = store.shop;
  const lookups = new Map();
  const memberStatuses = new Set(["administrator", "member"]);
  const isStaff = from => {
    if (!Number.isSafeInteger(from?.id) || from.id <= 0 || from.is_bot) return false;
    const id = String(from.id);
    return (adminIds.has(id) || store.isEditor(id)) && !store.isBlocked(id);
  };
  const send = (chat, body, signal) => callTelegram("sendMessage", { chat_id: chat, ...body }, signal);
  const answer = (callback, text) => callTelegram("answerCallbackQuery", {
    callback_query_id: callback.id, ...(text ? { text, show_alert: true } : {}),
  });

  async function edit(messageId, body, signal) {
    try {
      await callTelegram("editMessageText", { chat_id: groupId, message_id: messageId, ...body }, signal);
    } catch (error) {
      if (error.status !== 400 || !/message is not modified/i.test(error.details || "")) throw error;
    }
  }

  async function showItems(messageId, order) {
    await edit(messageId, {
      text: `Заказ №${order.id}\n\nКакой товар вы хотите изменить?`,
      reply_markup: { inline_keyboard: [
        [button(order, "Назад", "back")],
        ...order.items.map((item, index) => [button(order, `${item.title.slice(0, 54)} · ${item.quantity} шт.`, "item", index)]),
      ] },
    });
  }

  async function requestValue(messageId, order, from, item) {
    const tracking = item === undefined;
    const label = tracking ? "Отправьте номер СДЭК." : `Укажите корректное количество товара.\n${item.title}`;
    await edit(messageId, {
      text: `Заказ №${order.id}\n\n${label}\nОтправьте значение сообщением в эту группу.`,
      reply_markup: { inline_keyboard: [[button(order, "Назад", tracking ? "back" : "items")]] },
    });
    lookups.delete(from.id);
    await restorePrompts(shop.saveTelegramPrompt(groupId, messageId, order, from.id, item?.id ?? null));
  }

  async function restorePrompts(prompts) {
    for (const prompt of prompts) {
      const previous = shop.telegramOrder(prompt.order_id);
      if (previous?.revision !== prompt.revision) continue;
      try { await edit(prompt.message_id, card(previous)); }
      catch (error) { console.error(error.message); }
    }
  }

  async function showOrder(id) {
    const order = shop.telegramOrder(id);
    await send(groupId, { text: order ? orderText(order) : `Заказ №${id} не найден.` });
    return Boolean(order);
  }

  async function handleLookupCallback(callback, payload) {
    const messageId = callback.message.message_id;
    if (payload === "filters") {
      await edit(messageId, statusMenu());
    } else {
      const [state, value] = payload.split(":");
      const number = Number(value);
      if (!Number.isSafeInteger(number)) return answer(callback, "Неверный номер.");
      if (state === "order") {
        await showOrder(number);
      } else {
        const all = state === "all";
        if (!all && !Object.hasOwn(statusLabels, state)) return answer(callback, "Неизвестный статус.");
        const { orders, page, pages } = shop.orders(all ? "" : state, number, 8);
        const rows = orders.map(order => [lookupButton(`№${order.id} · ${formatMoney(order.total)}`, `order:${order.id}`)]);
        const navigation = [];
        if (page > 1) navigation.push(lookupButton("‹ Назад", `${state}:${page - 1}`));
        if (page < pages) navigation.push(lookupButton("Далее ›", `${state}:${page + 1}`));
        if (navigation.length) rows.push(navigation);
        rows.push([lookupButton("Выбрать статус", "filters")]);
        const details = orders.length ? `Выберите заказ · страница ${page} из ${pages}`
          : all ? "Заказов пока нет." : "Заказов с этим статусом нет.";
        const title = all ? allOrdersLabel : statusLabels[state];
        await edit(messageId, { text: `${title}\n\n${details}`, reply_markup: { inline_keyboard: rows } });
      }
    }
    await answer(callback);
  }

  async function handleLookup(message) {
    if (typeof message.text !== "string") return false;
    const text = message.text.trim();
    const command = /^\/(show_all|show_id)(?:@([A-Za-z0-9_]+))?$/i.exec(text);
    if (command) {
      if (!isStaff(message.from) || (command[2] && command[2].toLowerCase() !== username?.toLowerCase())) return true;
      const actor = message.from.id;
      const oldPrompts = shop.clearTelegramPromptsForActor(groupId, actor);
      if (command[1].toLowerCase() === "show_all") {
        lookups.delete(actor);
        await send(groupId, statusMenu());
      } else {
        const prompt = await send(groupId, { text: "Укажите номер заказа" });
        lookups.set(actor, prompt.message_id);
      }
      await restorePrompts(oldPrompts);
      return true;
    }
    if (!isStaff(message.from) || !lookups.has(message.from.id) || text.startsWith("/")) return false;
    const actor = message.from.id;
    if (message.reply_to_message && message.reply_to_message.message_id !== lookups.get(actor)) return false;
    const match = /^№?\s*([1-9]\d{0,15})$/.exec(text);
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      await send(groupId, { text: "Укажите номер заказа цифрами." });
      return true;
    }
    if (await showOrder(Number(match[1]))) lookups.delete(actor);
    return true;
  }

  async function handleCallback(callback) {
    const match = code.exec(callback.data || "");
    const lookup = lookupCode.exec(callback.data || "");
    if (!match && !lookup) return false;
    if (!isStaff(callback.from)) {
      await answer(callback, "У вас нет доступа к управлению заказами.");
      return true;
    }
    if (lookup) {
      await handleLookupCallback(callback, lookup[1]);
      return true;
    }
    const [, key, version, action, index] = match;
    const id = Number(key);
    const order = shop.telegramOrder(id);
    const messageId = callback.message.message_id;
    if (!order || shop.telegramCardMessage(groupId, id) !== messageId || order.revision !== Number(version)) {
      await answer(callback, "Заказ изменился. Используйте актуальную карточку.");
      return true;
    }
    try {
      if (action === "items" && canAdjust(order.state)) {
        await showItems(messageId, order);
      } else if (action === "item" && canAdjust(order.state) && order.items[Number(index)]) {
        await requestValue(messageId, order, callback.from, order.items[Number(index)]);
        await answer(callback);
        return true;
      } else if (action === "back") {
        await edit(messageId, card(order));
      } else if (action === "undo") {
        shop.undoOrderStatus(id, order.revision);
      } else if (action === "shipped" && order.state === "packing") {
        await requestValue(messageId, order, callback.from);
        await answer(callback);
        return true;
      } else {
        shop.updateOrder(id, order.state, action, "", order.revision);
      }
      shop.clearTelegramPrompt(groupId, messageId);
      await answer(callback);
    } catch (error) {
      if (!(error instanceof ShopError)) throw error;
      await answer(callback, error.message);
    }
    return true;
  }

  async function handleValue(message) {
    if (!isStaff(message.from) || typeof message.text !== "string") return false;
    const replyTo = message.reply_to_message?.message_id;
    const prompt = Number.isSafeInteger(replyTo) ? shop.telegramPrompt(groupId, replyTo)
      : shop.telegramPromptForActor(groupId, message.from.id);
    if (!prompt || message.from.id !== prompt.actor_id) return false;
    const messageId = prompt.message_id;
    const order = shop.telegramOrder(prompt.order_id);
    const value = message.text.trim();
    const respond = text => send(groupId, { text, reply_parameters: { message_id: message.message_id } });
    try {
      if (!order || prompt.revision !== order.revision || shop.telegramCardMessage(groupId, order.id) !== messageId) {
        shop.clearTelegramPrompt(groupId, messageId);
        throw new ShopError(409, "Заказ изменился. Откройте его карточку заново.");
      }
      if (prompt.product_id) {
        if (!/^\d{1,3}$/.test(value)) throw new ShopError(400, "Укажите целое количество от 0 до 999.");
        const items = order.items.map(item => ({ id: item.id, quantity: item.id === prompt.product_id ? Number(value) : item.quantity }));
        shop.adjustOrder(order.id, order.revision, items);
      } else {
        if (!/^(?=.*\d)[\p{L}\d][\p{L}\d-]{0,99}$/u.test(value)) {
          throw new ShopError(400, "Отправьте трек-номер СДЭК без пробелов. Можно использовать цифры, буквы и дефис.");
        }
        shop.updateOrder(order.id, "packing", "shipped", value, order.revision);
      }
      shop.clearTelegramPrompt(groupId, messageId);
      await respond(prompt.product_id ? `Заказ №${order.id}: количество обновлено.` : `Заказ №${order.id}: трек-номер сохранён.`);
    } catch (error) {
      if (!(error instanceof ShopError)) throw error;
      await respond(error.message);
    }
    return true;
  }

  async function handle(update) {
    const membership = update.my_chat_member;
    const message = update.message;
    const callback = update.callback_query;
    const chat = membership?.chat ?? message?.chat ?? callback?.message?.chat;
    if (shopGroup(chat)) {
      if (groupId === undefined) return false;
      if (chat.id !== groupId) {
        const member = membership?.new_chat_member;
        if (!membership || memberStatuses.has(member?.status) || member?.is_member === true) {
          await callTelegram("leaveChat", { chat_id: chat.id });
        }
        return true;
      }
      if (callback) return handleCallback(callback);
      if (message) return await handleLookup(message) || handleValue(message);
    }
    if (message?.chat?.type === "private" && Number.isSafeInteger(message.from?.id) &&
        message.from.id === message.chat.id && !message.from.is_bot) {
      shop.resumeTelegramNotifications(String(message.from.id));
    }
    return false;
  }

  async function sendNotifications(signal) {
    for (const event of shop.telegramNotifications()) {
      if (signal.aborted) return;
      try {
        await send(Number(event.telegram_id), customerMessage(event, publicOrigin, miniAppUrl), signal);
        shop.finishTelegramNotification(event.id);
      } catch (error) {
        if (signal.aborted) return;
        const wait = error.status === 403 || error.status === 400 ? 3_600_000 : (error.retryAfter || 15) * 1000;
        shop.retryTelegramNotification(event.id, wait);
        if (error.status === 429) return;
      }
    }
  }

  async function syncCards(signal) {
    for (const { order, messageId } of shop.pendingTelegramCards(groupId)) {
      if (signal.aborted) return;
      let savedMessage = messageId;
      if (messageId) {
        shop.clearTelegramPrompt(groupId, messageId);
        try {
          await edit(messageId, card(order), signal);
        } catch (error) {
          if (error.status !== 400 || !/message to edit not found|message can't be edited/i.test(error.details || "")) throw error;
          savedMessage = null;
        }
      }
      if (!savedMessage) savedMessage = (await send(groupId, card(order), signal)).message_id;
      shop.saveTelegramCard(groupId, order, savedMessage);
    }
  }

  async function run(signal) {
    async function repeat(job) {
      while (!signal.aborted) {
        let wait = 1000;
        try { await job(signal); }
        catch (error) {
          if (signal.aborted) return;
          console.error(error.message);
          wait = Math.max(15, error.retryAfter || 0) * 1000;
        }
        await delay(wait, undefined, { signal }).catch(() => {});
      }
    }
    await Promise.all([repeat(sendNotifications), ...(groupId === undefined ? [] : [repeat(syncCards)])]);
  }

  return { handle, run };
}
