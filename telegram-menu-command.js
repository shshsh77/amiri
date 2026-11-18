import { createTelegramClient } from "./bot.js";
import { miniMenu } from "./telegram-mini.js";

async function configureMenu() {
  const origin = new URL(process.env.MINI_APP_ORIGIN || "http://localhost");
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const username = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === "--chat-id" && /^[1-9]\d{0,15}$/.test(args[1]))) {
    throw new Error("Укажите числовой Telegram ID после --chat-id.");
  }
  const scope = args.length ? { chat_id: Number(args[1]) } : {};
  if (origin.protocol !== "https:" || !token || !username) {
    throw new Error("Укажите MINI_APP_ORIGIN, TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME.");
  }
  const menu = miniMenu(origin);
  const call = createTelegramClient(token);
  const bot = await call("getMe");
  if (bot.username?.toLowerCase() !== username.toLowerCase()) throw new Error("Токен относится к другому боту.");
  const page = await fetch(menu.web_app.url, { signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!page.ok || !(await page.text()).includes('id="mini-status"')) throw new Error("Страница Mini App недоступна по HTTPS.");
  const current = await call("getChatMenuButton", scope);
  if (current.type !== menu.type || current.text !== menu.text || current.web_app?.url !== menu.web_app.url) {
    await call("setChatMenuButton", { ...scope, menu_button: menu });
  }
  const saved = await call("getChatMenuButton", scope);
  if (saved.type !== menu.type || saved.text !== menu.text || saved.web_app?.url !== menu.web_app.url) {
    throw new Error("Telegram не подтвердил новую кнопку меню.");
  }
  console.log(`@${bot.username} · ${saved.text} · ${saved.web_app.url}`);
}

configureMenu().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
