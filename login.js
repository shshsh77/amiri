const login = document.querySelector("#telegram-login");
const status = document.querySelector("#login-status");
const code = document.querySelector("#login-code");
const retry = document.querySelector("#login-retry");
const botLink = document.querySelector("#bot-link");
let challenge;
let timer;
let polling = false;

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function stop(message, showRetry = true) {
  clearTimeout(timer);
  challenge = undefined;
  login.removeAttribute("href");
  login.setAttribute("aria-disabled", "true");
  code.hidden = true;
  retry.hidden = !showRetry;
  status.textContent = message;
}

async function prepare() {
  stop("Готовим ссылку…", false);
  try {
    challenge = await post("/api/auth/start", {});
    login.href = challenge.url;
    login.removeAttribute("aria-disabled");
    status.textContent = "";
  } catch (error) {
    stop(error.message || "Не удалось подготовить вход.");
  }
}

async function poll() {
  if (polling || !challenge || code.hidden) return;
  const current = challenge;
  if (Date.now() >= current.expiresAt) return stop("Ссылка истекла. Запросите новую.");
  polling = true;
  try {
    const result = await post("/api/auth/status", { token: current.token });
    if (challenge !== current) return;
    if (result.status === "authenticated") {
      status.textContent = "Вход подтверждён.";
      location.reload();
      return;
    }
    if (result.status === "denied") return stop("Вход отменён или доступ ограничен.");
    if (result.status === "expired") return stop("Ссылка истекла. Запросите новую.");
    status.textContent = "Откройте Telegram и нажмите «Да, это я» в боте.";
  } catch {
    status.textContent = "Не удалось проверить вход. Повторяем запрос…";
  } finally {
    polling = false;
  }
  clearTimeout(timer);
  if (challenge === current) timer = setTimeout(poll, 2000);
}

login.addEventListener("click", event => {
  if (!challenge || Date.now() >= challenge.expiresAt) {
    event.preventDefault();
    if (challenge) stop("Ссылка истекла. Запросите новую.");
    return;
  }
  code.querySelector("strong").textContent = challenge.code;
  code.hidden = false;
  status.textContent = "Откройте Telegram и нажмите «Да, это я» в боте.";
  void poll();
});

retry.addEventListener("click", prepare);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void poll();
});

try {
  const response = await fetch("/api/session", { signal: AbortSignal.timeout(10_000) });
  const { botUsername } = await response.json();
  if (botUsername) {
    botLink.textContent = "@" + botUsername;
    botLink.href = "https://t.me/" + botUsername;
    document.querySelector("#bot-note").hidden = false;
    await prepare();
  } else {
    stop("Бот ещё не настроен.", false);
  }
} catch {
  stop("Сервер недоступен. Обновите страницу.", false);
}
