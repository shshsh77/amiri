import { createHmac, timingSafeEqual } from "node:crypto";

export const miniLaunchLifetime = 10 * 60 * 1000;

export function verifyMiniLaunch(data, botToken, now = Date.now()) {
  if (typeof data !== "string" || !botToken || data.length > 8192) return null;
  const fields = new Map();
  for (const [key, value] of new URLSearchParams(data)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || fields.has(key)) return null;
    fields.set(key, value);
  }
  const digest = fields.get("hash");
  const authDate = fields.get("auth_date");
  if (!/^[a-f0-9]{64}$/.test(digest || "") || !/^\d{1,12}$/.test(authDate || "")) return null;
  const issued = Number(authDate) * 1000;
  const expiresAt = issued + miniLaunchLifetime;
  if (issued > now + 30_000 || expiresAt <= now) return null;
  fields.delete("hash");
  const check = [...fields.keys()].sort().map(key => `${key}=${fields.get(key)}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", key).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(digest, "hex"))) return null;
  let user;
  try {
    user = JSON.parse(fields.get("user"));
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.is_bot || typeof user.first_name !== "string") return null;
  return { user, digest, expiresAt };
}

export function miniMenu(origin) {
  return { type: "web_app", text: "Открыть магазин", web_app: { url: new URL("/mini", origin).href } };
}
