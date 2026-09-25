// Recurring runs for a configuration: every N days at HH:MM on the admin's wall clock, counted from a start date.
// Stored in `configs.schedule_json`; the last slot that fired is `configs.schedule_last_at`.

export const SCHEDULE_MAX_DAYS = 30;
// A slot missed while the server was off still runs if the server is back within this window; older ones are skipped.
export const SCHEDULE_GRACE_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function serverTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of an instant in a time zone.
function zonedParts(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function zoneOffset(ms, zone) {
  const p = zonedParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time happens in a zone; a time skipped by a DST jump lands just after the jump.
function zonedToUtc(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall - zoneOffset(wall, zone);
  guess = wall - zoneOffset(guess, zone);
  return guess;
}

function parseDate(text) {
  const match = DATE.exec(String(text || ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function todayIn(zone, now = Date.now()) {
  const p = zonedParts(now, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function readStored(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Validates what the dialog sends. An absent schedule stays off.
export function normalizeSchedule(value, now = Date.now()) {
  const input = readStored(value);
  const enabled = Boolean(input.enabled);
  const timeZone = String(input.timeZone || "").trim() || serverTimeZone();
  if (!validTimeZone(timeZone)) throw new Error(`Geçersiz saat dilimi: ${timeZone}`);
  const everyDays = Math.trunc(Number(input.everyDays ?? 1));
  const time = String(input.time || "").trim();
  const startDate = String(input.startDate || "").trim() || todayIn(timeZone, now);
  if (enabled) {
    if (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > SCHEDULE_MAX_DAYS) throw new Error(`Zamanlama sıklığı 1–${SCHEDULE_MAX_DAYS} gün olmalı`);
    if (!TIME.test(time)) throw new Error("Zamanlama saati SS:DD biçiminde olmalı (örn. 09:00)");
    if (!parseDate(startDate)) throw new Error("Zamanlama başlangıç tarihi YYYY-AA-GG biçiminde olmalı");
  }
  return {
    enabled,
    everyDays: Number.isFinite(everyDays) && everyDays >= 1 && everyDays <= SCHEDULE_MAX_DAYS ? everyDays : 1,
    time: TIME.test(time) ? time : "09:00",
    startDate: parseDate(startDate) ? startDate : todayIn(timeZone, now),
    timeZone,
  };
}

// Only these fields decide when a schedule fires; changing any of them restarts it from the save time.
export function sameTiming(a, b) {
  return ["enabled", "everyDays", "time", "startDate", "timeZone"].every((key) => a?.[key] === b?.[key]);
}

export function parseSchedule(value) {
  const stored = readStored(value);
  if (!stored.enabled) return null;
  try {
    return { ...normalizeSchedule(stored), since: stored.since || null, userId: stored.userId ?? null };
  } catch {
    return null;
  }
}

function slotAt(schedule, index) {
  const start = parseDate(schedule.startDate);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const day = new Date(Date.UTC(start.year, start.month - 1, start.day) + index * schedule.everyDays * DAY_MS);
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, schedule.timeZone);
}

function slotIndexNear(schedule, ms) {
  const start = parseDate(schedule.startDate);
  const p = zonedParts(ms, schedule.timeZone);
  const days = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(start.year, start.month - 1, start.day)) / DAY_MS);
  return Math.floor(days / schedule.everyDays);
}

// First slot strictly after `afterMs`.
export function nextSlot(schedule, afterMs) {
  let index = Math.max(0, slotIndexNear(schedule, afterMs) - 1);
  while (slotAt(schedule, index) <= afterMs) index += 1;
  return slotAt(schedule, index);
}

// Latest slot at or before `nowMs`, or null before the first one.
export function lastSlot(schedule, nowMs) {
  let index = slotIndexNear(schedule, nowMs) + 1;
  while (index >= 0 && slotAt(schedule, index) > nowMs) index -= 1;
  return index >= 0 ? slotAt(schedule, index) : null;
}

// What the scheduler should do now: nothing, run the slot, or skip a slot missed for too long.
export function dueSlot(schedule, lastFiredMs, nowMs, graceMs = SCHEDULE_GRACE_MS) {
  if (!schedule) return null;
  const since = Math.max(Date.parse(schedule.since || "") || 0, lastFiredMs || 0);
  const slot = lastSlot(schedule, nowMs);
  if (slot === null || slot <= since) return null;
  return { slot, action: nowMs - slot > graceMs ? "skip" : "run" };
}

export function nextRunAt(schedule, lastFiredMs, nowMs = Date.now()) {
  if (!schedule) return null;
  const since = Math.max(Date.parse(schedule.since || "") || 0, lastFiredMs || 0);
  return new Date(nextSlot(schedule, Math.max(since, nowMs))).toISOString();
}
