import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltHex, hashHex] = stored.split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const next = scryptSync(password, Buffer.from(saltHex, "hex"), 32);
  const prev = Buffer.from(hashHex, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function loadAppKey(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "app.key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600 });
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error("app.key must be 32 bytes");
  return key;
}

export function encrypt(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1$${iv.toString("hex")}$${tag.toString("hex")}$${body.toString("hex")}`;
}

export function decrypt(key, payload) {
  if (!payload) return "";
  const [ver, ivHex, tagHex, bodyHex] = payload.split("$");
  if (ver !== "v1") return "";
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(bodyHex, "hex")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

export function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(8)}${value.slice(-4)}`;
}
