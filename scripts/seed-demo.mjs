import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { openAuthStore } from "../auth-store.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dbPath = resolve(process.env.DB_PATH || resolve(root, "data/amiri.sqlite"));
for (let index = 1; index <= 20; index++) {
  const number = String(index).padStart(2, "0");
  if (!existsSync(resolve(root, `img/demo-placeholder-${number}.png`))) {
    throw new Error(`Missing demo image ${number}`);
  }
}

const backupDirectory = resolve(root, ".local-tools/data-backups");
mkdirSync(backupDirectory, { recursive: true });
const db = new DatabaseSync(dbPath);
try {
  await backup(db, resolve(backupDirectory, `before-demo-${Date.now()}.sqlite`));
} finally {
  db.close();
}

const store = openAuthStore(dbPath);
try {
  const category = store.shop.categories().find(item => item.title === "Демо-каталог")
    || store.shop.saveCategory({ title: "Демо-каталог", image: "" });
  const existing = store.shop.products(true);
  let added = 0;
  for (let index = 1; index <= 20; index++) {
    const number = String(index).padStart(2, "0");
    const title = `Демо-товар ${number}`;
    if (existing.some(item => item.category === category.id && item.title === title)) continue;
    store.shop.saveProduct(undefined, {
      title, category: category.id, price: null, stock: 0, visible: true,
      image: `/img/demo-placeholder-${number}.png`, badge: "", brand: "", line: "",
    });
    added++;
  }
  const cards = store.shop.products().filter(item => item.category === category.id);
  console.log(JSON.stringify({ category: category.title, added, cards: cards.length }));
} finally {
  store.close();
}
