(() => {
  const telegram = window.Telegram?.WebApp;
  const status = document.querySelector("#mini-status");

  if (telegram) {
    const color = "#101010";
    telegram.ready();
    telegram.expand();
    if (telegram.isVersionAtLeast("6.1")) {
      telegram.setHeaderColor(color);
      telegram.setBackgroundColor(color);
    }
    if (telegram.isVersionAtLeast("7.10")) telegram.setBottomBarColor(color);
  }

  if (!status) {
    if (!telegram?.BackButton || !telegram.isVersionAtLeast("6.1")) return;
    const panel = document.querySelector("#panel");
    const canGoBack = () => panel.open || Boolean(location.hash && location.hash !== "#home");
    const syncBack = () => {
      if (canGoBack()) telegram.BackButton.show();
      else telegram.BackButton.hide();
    };
    telegram.BackButton.onClick(() => {
      if (panel.open) panel.close();
      else location.hash = "#home";
    });
    window.addEventListener("hashchange", syncBack);
    new MutationObserver(syncBack).observe(panel, { attributes: true, attributeFilter: ["open"] });
    syncBack();
    return;
  }

  async function start() {
    if (!telegram?.initData) {
      status.textContent = "Откройте магазин кнопкой «Открыть магазин» в меню бота.";
      const { botUsername } = await (await fetch("/api/session", { signal: AbortSignal.timeout(10_000) })).json();
      if (botUsername) {
        const link = document.querySelector("#mini-bot");
        link.href = "https://t.me/" + botUsername;
        link.hidden = false;
      }
      return;
    }

    const response = await fetch("/api/auth/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: telegram.initData }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!response.ok) {
      status.textContent = result.error;
      return;
    }
    const session = await fetch("/api/session", { signal: AbortSignal.timeout(10_000) });
    if (!(await session.json()).user) {
      status.textContent = "Telegram не сохранил сеанс. Попробуйте открыть магазин в мобильном или настольном приложении.";
      return;
    }
    location.replace("/mini-app");
  }

  void start().catch(() => {
    status.textContent = "Не удалось открыть магазин. Попробуйте ещё раз из меню бота.";
  });
})();
