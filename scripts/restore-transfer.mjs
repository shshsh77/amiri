import { createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const keyPath = process.argv[2];
if (!keyPath) throw new Error("Укажите путь к файлу ключа amiri-transfer.key.");

const keyText = readFileSync(keyPath, "utf8").trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(keyText)) throw new Error("Неверный формат ключа.");
const key = Buffer.from(keyText, "base64url");

const snapshot = readFileSync(new URL("../transfer/amiri-runtime.enc", import.meta.url));
const header = Buffer.from("AMIRI1");
if (snapshot.length <= 34 || !snapshot.subarray(0, 6).equals(header)) {
  throw new Error("Неверный формат архива.");
}
const decipher = createDecipheriv("aes-256-gcm", key, snapshot.subarray(6, 18));
decipher.setAAD(header);
decipher.setAuthTag(snapshot.subarray(18, 34));
let files;
try {
  const payload = Buffer.concat([decipher.update(snapshot.subarray(34)), decipher.final()]);
  files = JSON.parse(payload.toString("utf8"));
} catch {
  throw new Error("Проверьте ключ и целостность файла архива.");
}

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const dataDirectory = new URL("../data/", import.meta.url);
const dbPath = fileURLToPath(new URL("amiri.sqlite", dataDirectory));
if ([envPath, dbPath, dbPath + "-wal", dbPath + "-shm"].some(path => existsSync(path))) {
  throw new Error("Восстанавливайте архив в свежем клоне. Настройки или база уже существуют.");
}
mkdirSync(dataDirectory, { recursive: true });
writeFileSync(envPath, Buffer.from(files.env, "base64"), { flag: "wx", mode: 0o600 });
try {
  writeFileSync(dbPath, Buffer.from(files.db, "base64"), { flag: "wx", mode: 0o600 });
} catch (error) {
  unlinkSync(envPath);
  throw error;
}
console.log("Восстановлены .env и data/amiri.sqlite.");
