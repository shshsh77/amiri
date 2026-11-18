import { bindShopAdmin } from "./admin-shop.js";

const $ = selector => document.querySelector(selector);
const search = $("#user-search");
const users = $("#users");
const message = $("#admin-status");
const prev = $("#prev");
const next = $("#next");
const dialog = $("#access-dialog");
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });
let page = 1;
let searchTimer;
let requestNumber = 0;
let pendingBlock;

async function api(path, body) {
  const options = body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {};
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(10_000) });
  if (response.status === 401 || response.status === 403) location.reload();
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

function appendCell(row, text) {
  const cell = row.insertCell();
  if (text) cell.textContent = text;
  return cell;
}

async function changeAccess(user) {
  try {
    await api("/api/admin/users/access", { id: user.id, blocked: !user.blocked });
    await load();
  } catch (error) {
    showMessage(error.message || "Не удалось изменить доступ.");
  }
}

function renderUser(user) {
  const row = users.insertRow();
  const name = appendCell(row);
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Пользователь";
  const title = document.createElement("strong");
  title.textContent = user.role === "customer" ? fullName : "Admin " + (user.firstName || user.username || fullName);
  name.append(title);
  if (user.username) {
    const username = document.createElement("small");
    username.textContent = "@" + user.username;
    name.append(username);
  }
  appendCell(row, user.id);
  appendCell(row, date.format(user.registeredAt));
  appendCell(row, user.lastLogin === null ? "—" : date.format(user.lastLogin));
  const flag = document.createElement("span");
  flag.className = "access" + (user.blocked ? " access-blocked" : "");
  flag.textContent = user.blocked ? "Заблокирован" : { owner: "Владелец", editor: "Редактор", customer: "Клиент" }[user.role];
  appendCell(row).append(flag);
  const actions = appendCell(row);
  if (user.isAdmin) return;
  const role = document.createElement("button");
  role.type = "button";
  role.className = "button ghost";
  role.textContent = user.role === "editor" ? "Снять права редактора" : "Сделать редактором";
  role.addEventListener("click", async () => {
    role.disabled = true;
    try {
      await api("/api/admin/users/role", { id: user.id, role: user.role === "editor" ? "customer" : "editor" });
      await load();
    } catch (error) {
      showMessage(error.message || "Не удалось изменить роль.");
    } finally {
      role.disabled = false;
    }
  });
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button ghost";
  button.textContent = user.blocked ? "Разблокировать" : "Заблокировать";
  button.addEventListener("click", () => {
    if (user.blocked) {
      button.disabled = true;
      void changeAccess(user).finally(() => { button.disabled = false; });
      return;
    }
    pendingBlock = user;
    dialog.returnValue = "";
    $("#access-description").textContent = `${fullName} потеряет доступ к сайту, включая открытые сеансы.`;
    dialog.showModal();
  });
  actions.className = "user-actions";
  actions.append(role, button);
}

async function load() {
  const request = ++requestNumber;
  const query = new URLSearchParams({ q: search.value.trim(), page: String(page) });
  try {
    const result = await api("/api/admin/users?" + query);
    if (request !== requestNumber) return;
    $("#registered").textContent = result.stats.total;
    $("#active-users").textContent = result.stats.total - result.stats.blocked;
    $("#blocked").textContent = result.stats.blocked;
    users.replaceChildren();
    result.users.forEach(renderUser);
    $("#users-table").hidden = !result.users.length;
    showMessage(result.users.length ? "" : search.value.trim() ? "Пользователи не найдены." : "Зарегистрированных пользователей пока нет.");
    page = result.page;
    $("#page").textContent = `${page} из ${result.pages}`;
    $("#pagination").hidden = result.pages <= 1;
    prev.disabled = page <= 1;
    next.disabled = page >= result.pages;
  } catch (error) {
    if (request === requestNumber) showMessage(error.message || "Не удалось загрузить пользователей.");
  }
}

search.addEventListener("input", () => {
  page = 1;
  requestNumber++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 220);
});
prev.addEventListener("click", () => { page--; void load(); });
next.addEventListener("click", () => { page++; void load(); });
dialog.addEventListener("close", () => {
  if (dialog.returnValue === "confirm" && pendingBlock) void changeAccess(pendingBlock);
  pendingBlock = undefined;
});
$("#admin-logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", {});
    location.replace("/");
  } catch (error) {
    showMessage(error.message || "Не удалось выйти.");
  }
});
const { user: staff } = await api("/api/session");
if (!staff || staff.role === "customer") {
  location.reload();
} else {
  $("#staff-name").textContent = "Admin " + (staff.firstName || staff.username || staff.id);
  const shopTabs = bindShopAdmin(api);
  const loaders = { ...shopTabs, users: load };
  const navigation = [...document.querySelectorAll("[data-admin-tab]")];
  const sections = Object.fromEntries(navigation.map(button => [button.dataset.adminTab, $("#admin-" + button.dataset.adminTab)]));
  function open(name) {
    for (const button of navigation) {
      button.setAttribute("aria-pressed", button.dataset.adminTab === name);
      sections[button.dataset.adminTab].hidden = button.dataset.adminTab !== name;
    }
    void loaders[name]();
  }
  for (const button of navigation) {
    button.addEventListener("click", () => open(button.dataset.adminTab));
    if (button.dataset.adminTab === "users") button.hidden = staff.role !== "owner";
  }
  open("orders");
}
