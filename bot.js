import { setTimeout as delay } from "node:timers/promises";

const tokenPattern = "[A-Za-z0-9_-]{32}";
const startLink = new RegExp(`^web_(${tokenPattern})$`);
const decision = new RegExp(`^amiri_(yes|no):(${tokenPattern})$`);

function privateSender(chat, from) {
  return Boolean(from) && chat?.type === "private" && chat.id === from.id &&
    Number.isSafeInteger(from.id) && from.id > 0 && !from.is_bot;
}

export function createTelegramClient(botToken) {
  return async (method, body = {}, signal) => {
    const timeout = AbortSignal.timeout(method === "getUpdates" ? 40_000 : 10_000);
    let response;
    let result;
    try {
      response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      result = await response.json();
    } catch {
      throw new Error(`Telegram ${method}: нет ответа`);
    }
    if (!response.ok || !result.ok) {
      const status = result.error_code || response.status;
      throw Object.assign(new Error(`Telegram ${method}: ошибка ${status}`), {
        status,
        details: result.description,
        retryAfter: result.parameters?.retry_after,
      });
    }
    return result.result;
  };
}

// An existing bot can pass just its login and registration updates to this handler.
export function createRegistrationHandler({ store, callTelegram, publicOrigin, username, miniAppUrl }) {
  const site = new URL(publicOrigin).host;
  const send = (chatId, text, options = {}) =>
    callTelegram("sendMessage", { chat_id: chatId, text, ...options });
  const shopButton = miniAppUrl ? { reply_markup: { inline_keyboard: [[
    { text: "Открыть магазин", web_app: { url: miniAppUrl } },
  ]] } } : {};

  return async function handleRegistration(update) {
    const message = update.message;
    if (privateSender(message?.chat, message?.from) && typeof message.text === "string") {
      const [rawCommand, argument = ""] = message.text.trim().split(/\s+/, 2);
      const [command, mentioned] = rawCommand.split("@", 2);
      if (mentioned && mentioned.toLowerCase() !== username.toLowerCase()) return false;
      if (command === "/id") {
        await send(message.chat.id, `Ваш Telegram ID: ${message.from.id}`);
        return true;
      }
      if (command === "/register") {
        const user = store.register(message.from);
        await send(message.chat.id, user.blocked
          ? "Доступ к сайту ограничен. Обратитесь к администратору."
          : miniAppUrl ? "Аккаунт зарегистрирован. Магазин открывается прямо в Telegram."
            : "Аккаунт зарегистрирован. Для входа откройте сайт и нажмите «Войти через Telegram».",
        user.blocked ? {} : shopButton);
        return true;
      }
      if (command === "/start") {
        const match = startLink.exec(argument);
        if (match) {
          const [, token] = match;
          const code = store.claim(token, String(message.from.id));
          if (!code) {
            await send(message.chat.id, "Эта ссылка уже использована или истекла. Запросите новую на сайте.");
            return true;
          }
          await send(message.chat.id, `Запрос на вход в AMIRI VAPE (${site}).\nКод: ${code}\n\nПодтвердите вход, если вы сами открыли сайт и видите там тот же код.`, {
            reply_markup: { inline_keyboard: [[
              { text: "Да, это я", callback_data: `amiri_yes:${token}` },
              { text: "Отменить", callback_data: `amiri_no:${token}` },
            ]] },
          });
          return true;
        }
        if (argument && !argument.startsWith("web_")) return false;
        if (argument) {
          await send(message.chat.id, "Ссылка на вход недействительна. Запросите новую на сайте.");
        } else {
          await send(message.chat.id, miniAppUrl
            ? "Магазин откроется прямо в Telegram. Чтобы узнать свой Telegram ID, отправьте /id."
            : "Для входа нажмите «Войти через Telegram» на сайте и подтвердите запрос здесь. Для регистрации из чата используйте /register, чтобы узнать свой ID — /id.", shopButton);
        }
        return true;
      }
    }

    const callback = update.callback_query;
    const match = decision.exec(callback?.data || "");
    if (!match || !privateSender(callback.message?.chat, callback.from)) return false;
    const [, answer, token] = match;
    const result = store.decide(token, callback.from, answer === "yes");
    const label = {
      approved: "Вход подтверждён. Вернитесь на сайт.",
      denied: "Вход отменён.",
      blocked: "Доступ к сайту ограничен.",
      expired: "Запрос уже обработан или истёк.",
    }[result];
    await callTelegram("answerCallbackQuery", { callback_query_id: callback.id, text: label });
    if (result !== "expired") {
      await callTelegram("editMessageText", {
        chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: label,
      });
    }
    return true;
  };
}

export async function pollTelegram({ callTelegram, handler, signal }) {
  let offset = 0;
  while (!signal.aborted) {
    try {
      const updates = await callTelegram("getUpdates", {
        offset, timeout: 28, allowed_updates: ["message", "callback_query", "my_chat_member"],
      }, signal);
      for (const update of updates) {
        if (signal.aborted) return;
        try {
          await handler(update);
        } catch (error) {
          if (!error.status || error.status === 429 || error.status >= 500) throw error;
          console.error(error.message);
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 409) {
        console.error("Telegram уже передаёт обновления другому процессу или вебхуку. Подключите обработчик в существующем боте.");
        return;
      }
      if (error.status === 401 || error.status === 404) {
        console.error("Telegram отклонил токен бота.");
        return;
      }
      console.error(error.message);
      await delay(Math.max(2, error.retryAfter || 0) * 1000, undefined, { signal }).catch(() => {});
    }
  }
}
