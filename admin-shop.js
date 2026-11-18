const $ = selector => document.querySelector(selector);
const statusLabels = {
  new: "Новый", accepted: "Принят", packing: "На сборке", shipped: "Отправлен",
  completed: "Завершён", cancelled: "Отменён",
};
const actions = {
  new: [["accepted", "Принять"], ["cancelled", "Отменить"]],
  accepted: [["packing", "Передать на сборку"], ["cancelled", "Отменить"]],
  packing: [["shipped", "Отметить отправленным"], ["cancelled", "Отменить"]],
  shipped: [["completed", "Завершить"]],
  completed: [], cancelled: [],
};
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });
const rubles = new Intl.NumberFormat("ru-RU");
const money = amount => `${rubles.format(amount)} ₽`;

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className = "button ghost") {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

export function bindShopAdmin(api) {
  const catalogUpdates = typeof BroadcastChannel === "function" ? new BroadcastChannel("amiri-catalog") : null;
  const productForm = $("#product-form");
  const productDialog = $("#product-dialog");
  const productSearch = $("#product-search");
  const productList = $("#admin-product-list");
  const categoryForm = $("#category-form");
  const categoryDialog = $("#category-dialog");
  const categoryList = $("#admin-category-list");
  const deleteDialog = $("#delete-catalog-dialog");
  const deleteForm = $("#delete-catalog-form");
  const deleteSubmit = deleteForm.querySelector("[type=submit]");
  const deleteCancel = deleteForm.querySelector("[data-close-dialog]");
  const orderFilter = $("#order-filter");
  const orderDialog = $("#order-dialog");
  const orderForm = $("#order-form");
  const itemsDialog = $("#order-items-dialog");
  const itemsForm = $("#order-items-form");
  const orderList = $("#admin-order-list");
  let catalog = { products: [], categories: [] };
  let productReady = false;
  let editedProduct;
  let editedCategory;
  let pendingDelete;
  let orderPage = 1;
  let orderRequest = 0;
  let editedOrder;
  let itemOrder;

  function openProduct(product) {
    if (!productReady) return;
    editedProduct = product;
    $("#product-dialog-title").textContent = product ? "Редактировать позицию" : "Добавить позицию";
    $("#product-error").textContent = "";
    productForm.elements.title.value = product?.title || "";
    productForm.elements.category.value = product?.category ?? catalog.categories[0]?.id ?? "";
    productForm.elements.brand.value = product?.brand ?? "";
    productForm.elements.line.value = product?.line ?? "";
    productForm.elements.price.value = product?.price ?? "";
    productForm.elements.stock.value = product?.stock ?? 0;
    productForm.elements.image.value = product?.image ?? "";
    productForm.elements.badge.value = product?.badge ?? "";
    productForm.elements.visible.checked = product?.visible ?? true;
    productDialog.showModal();
  }

  function showProducts() {
    const query = productSearch.value.trim().toLowerCase();
    productList.replaceChildren();
    const products = catalog.products.filter(product => `${product.title} ${product.line} ${product.brand}`.toLowerCase().includes(query));
    for (const product of products) {
      const row = productList.insertRow();
      const category = catalog.categories.find(option => option.id === product.category);
      const title = [product.line, product.title].filter(Boolean).join(" · ");
      const price = product.price === null ? "Не указана" : money(product.price);
      const visibility = product.visible ? "Показывается" : "Скрыта";
      for (const label of [title, category?.title || "—", price, product.stock, visibility]) {
        row.insertCell().textContent = label;
      }
      const actions = row.insertCell();
      actions.className = "user-actions";
      actions.append(
        button("Редактировать", () => openProduct(product)),
        button("Удалить", () => confirmDelete("products", product.id, title, product.revision), "button ghost danger"),
      );
    }
    $("#product-status").textContent = products.length ? "" :
      catalog.categories.length ? "Позиции не найдены." : "Сначала добавьте категорию.";
  }

  async function loadProducts() {
    try {
      catalog = await api("/api/admin/products");
      productForm.elements.category.replaceChildren(...catalog.categories.map(({ id, title }) => new Option(title, id)));
      productReady = true;
      $("#new-product").disabled = !catalog.categories.length;
      showProducts();
    } catch (error) {
      $("#product-status").textContent = error.message;
    }
  }

  async function saveProduct(event) {
    event.preventDefault();
    const data = new FormData(productForm);
    const price = data.get("price");
    const submit = productForm.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      await api("/api/admin/products", {
        ...(editedProduct && { id: editedProduct.id, revision: editedProduct.revision }),
        title: data.get("title"), category: Number(data.get("category")),
        price: price === "" ? null : Number(price), stock: Number(data.get("stock")), visible: data.has("visible"),
        image: data.get("image"), badge: data.get("badge"), brand: data.get("brand"), line: data.get("line"),
      });
      catalogUpdates?.postMessage("changed");
      productDialog.close();
      await loadProducts();
    } catch (error) {
      $("#product-error").textContent = error.message;
      if (error.status === 409) await loadProducts();
    } finally {
      submit.disabled = false;
    }
  }

  function openCategory(category) {
    editedCategory = category;
    $("#category-dialog-title").textContent = category ? "Редактировать категорию" : "Добавить категорию";
    $("#category-error").textContent = "";
    categoryForm.elements.title.value = category?.title || "";
    categoryForm.elements.image.value = category?.image || "";
    categoryDialog.showModal();
  }

  async function loadCategories() {
    try {
      const { categories } = await api("/api/admin/categories");
      categoryList.replaceChildren();
      for (const category of categories) {
        const row = categoryList.insertRow();
        row.insertCell().textContent = category.title;
        row.insertCell().textContent = category.image || "По умолчанию";
        const actions = row.insertCell();
        actions.className = "user-actions";
        actions.append(
          button("Редактировать", () => openCategory(category)),
          button("Удалить", () => confirmDelete("categories", category.id, category.title), "button ghost danger"),
        );
      }
      $("#category-status").textContent = categories.length ? "" : "Категорий пока нет.";
    } catch (error) {
      $("#category-status").textContent = error.message;
    }
  }

  function confirmDelete(resource, id, title, revision) {
    const isProduct = resource === "products";
    pendingDelete = { resource, body: { id, revision } };
    $("#delete-catalog-title").textContent = isProduct ? "Удалить позицию?" : "Удалить категорию?";
    $("#delete-catalog-description").textContent = isProduct
      ? `«${title}» исчезнет из каталога. В оформленных заказах позиция сохранится.`
      : `«${title}» исчезнет из каталога. Сначала перенесите или удалите её позиции.`;
    $("#delete-catalog-error").textContent = "";
    deleteDialog.showModal();
  }

  deleteDialog.addEventListener("cancel", event => {
    if (deleteSubmit.disabled) event.preventDefault();
  });
  deleteForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!pendingDelete || deleteSubmit.disabled) return;
    const { resource, body } = pendingDelete;
    deleteSubmit.disabled = deleteCancel.disabled = true;
    $("#delete-catalog-error").textContent = "";
    try {
      await api(`/api/admin/${resource}/delete`, body);
      catalogUpdates?.postMessage("changed");
    } catch (error) {
      $("#delete-catalog-error").textContent = error.message;
      if (error.status === 409 && resource === "products") await loadProducts();
      return;
    } finally {
      deleteSubmit.disabled = deleteCancel.disabled = false;
    }
    deleteDialog.close();
    if (resource === "products") {
      await loadProducts();
      $("#product-search").focus();
    } else {
      await loadCategories();
      $("#new-category").focus();
    }
  });

  async function saveCategory(event) {
    event.preventDefault();
    const data = new FormData(categoryForm);
    const submit = categoryForm.querySelector("[type=submit]");
    submit.disabled = true;
    $("#category-error").textContent = "";
    try {
      await api("/api/admin/categories", {
        ...(editedCategory && { id: editedCategory.id }),
        title: data.get("title"), image: data.get("image"),
      });
      catalogUpdates?.postMessage("changed");
      categoryDialog.close();
      await loadCategories();
    } catch (error) {
      $("#category-error").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  function openOrder(order, state) {
    editedOrder = { id: order.id, expected: order.state, state };
    $("#order-dialog-title").textContent = `${actions[order.state].find(([key]) => key === state)[1]} заказ №${order.id}?`;
    $("#tracking-field").hidden = state !== "shipped";
    $("#order-dialog-error").textContent = "";
    orderForm.reset();
    orderDialog.showModal();
  }

  function orderCard(order) {
    const card = element("article", "", "admin-order");
    const header = element("header", "");
    header.append(element("h3", `№${order.id} · ${money(order.total)}`), element("span", statusLabels[order.state], "access"));
    const name = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ") || "Клиент";
    const customer = order.customer.username ? `${name} · @${order.customer.username}` : name;
    const info = element("p", `${customer} · ${date.format(order.createdAt)}`, "admin-order-info");
    const lines = element("ul", "");
    for (const item of order.items) lines.append(element("li", `${item.title} · ${item.quantity} шт. × ${money(item.price)}`));
    const controls = element("div", "", "order-actions");
    if (["new", "accepted"].includes(order.state)) {
      controls.append(button("Изменить количество", () => openItems(order)));
    }
    for (const [state, title] of actions[order.state]) controls.append(button(title, () => openOrder(order, state), state === "cancelled" ? "button ghost" : "button"));
    card.append(header, info, lines);
    if (order.tracking) card.append(element("p", `Трек-номер: ${order.tracking}`, "admin-order-info"));
    if (controls.childElementCount) card.append(controls);
    return card;
  }

  function openItems(order) {
    itemOrder = order;
    $("#order-items-title").textContent = `Позиции заказа №${order.id}`;
    $("#order-items-error").textContent = "";
    $("#order-item-fields").replaceChildren(...order.items.map(item => {
      const label = element("label", item.title);
      const field = document.createElement("input");
      field.type = "number";
      field.name = item.id;
      field.min = 0;
      field.max = 999;
      field.required = true;
      field.value = item.quantity;
      label.append(field);
      return label;
    }));
    itemsDialog.showModal();
  }

  async function loadOrders() {
    const request = ++orderRequest;
    const query = new URLSearchParams({ state: orderFilter.value, page: orderPage });
    try {
      const result = await api("/api/admin/orders?" + query);
      if (request !== orderRequest) return;
      orderPage = result.page;
      orderList.replaceChildren(...result.orders.map(orderCard));
      $("#order-status").textContent = result.orders.length ? "" : "Заказов пока нет.";
      $("#order-pagination").hidden = result.pages <= 1;
      $("#order-page").textContent = `${result.page} из ${result.pages}`;
      $("#order-prev").disabled = result.page <= 1;
      $("#order-next").disabled = result.page >= result.pages;
    } catch (error) {
      if (request === orderRequest) $("#order-status").textContent = error.message;
    }
  }

  $("#new-product").disabled = true;
  $("#new-product").addEventListener("click", () => openProduct());
  $("#new-category").addEventListener("click", () => openCategory());
  productSearch.addEventListener("input", showProducts);
  productForm.addEventListener("submit", saveProduct);
  categoryForm.addEventListener("submit", saveCategory);
  for (const dialog of [productDialog, categoryDialog, deleteDialog, orderDialog, itemsDialog]) {
    dialog.querySelector("[data-close-dialog]").addEventListener("click", () => dialog.close());
  }
  orderFilter.replaceChildren(new Option("Все статусы", ""), ...Object.entries(statusLabels).map(([key, label]) => new Option(label, key)));
  orderFilter.addEventListener("change", () => { orderPage = 1; void loadOrders(); });
  $("#order-prev").addEventListener("click", () => { orderPage--; void loadOrders(); });
  $("#order-next").addEventListener("click", () => { orderPage++; void loadOrders(); });
  orderForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = orderForm.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      await api("/api/admin/orders/status", { ...editedOrder, tracking: orderForm.elements.tracking.value });
      orderDialog.close();
      await loadOrders();
    } catch (error) {
      $("#order-dialog-error").textContent = error.message;
      if (error.status === 409) await loadOrders();
    } finally {
      submit.disabled = false;
    }
  });
  itemsForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = itemsForm.querySelector("[type=submit]");
    const items = [...new FormData(itemsForm)].map(([id, quantity]) => ({ id, quantity: Number(quantity) }));
    submit.disabled = true;
    try {
      await api("/api/admin/orders/items", { id: itemOrder.id, revision: itemOrder.revision, items });
      itemsDialog.close();
      await loadOrders();
    } catch (error) {
      $("#order-items-error").textContent = error.message;
      if (error.status === 409) await loadOrders();
    } finally {
      submit.disabled = false;
    }
  });
  return { orders: loadOrders, products: loadProducts, categories: loadCategories };
}
