"use strict";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_CENTS = 100000000; // $1,000,000 ceiling on any single amount

/** Calendar parts for `date` as seen in `timeZone`. */
function localDateParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    ym: `${parts.year}-${parts.month}`,
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(parts.weekday),
    hour: Number(parts.hour),
  };
}

/** True if `tz` is an IANA time zone this runtime understands. */
function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Key identifying the interest period that is due today, or null if none is due.
 * monthly: paid on the 1st, keyed by YYYY-MM. weekly: paid Sundays, keyed by date.
 */
function interestPeriodKey(period, parts) {
  if (period === "weekly") return parts.weekday === 0 ? `W:${parts.ymd}` : null;
  return parts.day === 1 ? `M:${parts.ym}` : null;
}

/** Interest in whole cents, rounded down. capCents of 0 means no cap. */
function computeInterest(balanceCents, ratePct, capCents = 0) {
  if (!(balanceCents > 0) || !(ratePct > 0)) return 0;
  const base = capCents > 0 ? Math.min(balanceCents, capCents) : balanceCents;
  return Math.floor((base * ratePct) / 100);
}

function isAllowanceDue(kid, parts) {
  return (
    !kid.archived &&
    Number.isInteger(kid.allowanceCents) &&
    kid.allowanceCents > 0 &&
    kid.allowanceDay === parts.weekday &&
    kid.lastAllowanceDate !== parts.ymd
  );
}

/** Validates an integer cent amount. Returns it or throws a message string. */
function checkCents(value, { allowZero = false } = {}) {
  if (!Number.isInteger(value)) throw "Amount must be a whole number of cents.";
  if (value < 0 || (!allowZero && value === 0)) throw "Amount must be more than zero.";
  if (value > MAX_CENTS) throw "Amount is too large.";
  return value;
}

function checkPin(pin) {
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) throw "PIN must be 4 to 6 digits.";
  return pin;
}

function checkWeekday(day) {
  if (!Number.isInteger(day) || day < 0 || day > 6) throw "Allowance day must be 0 (Sun) to 6 (Sat).";
  return day;
}

function checkRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw "Interest rate must be between 0 and 100 percent.";
  }
  return Math.round(rate * 100) / 100;
}

const MAX_CHORES = 20;

/**
 * Validates a parent's chore list: [{ id?, name, amountCents }]. Returns a clean list with
 * stable ids (existing ids are kept so kids' open requests still make sense).
 */
function checkChores(list) {
  if (!Array.isArray(list)) throw "Chores must be a list.";
  if (list.length > MAX_CHORES) throw `Keep it to ${MAX_CHORES} chores or fewer.`;
  const seen = new Set();
  return list.map((c, i) => {
    const name = cleanText(c?.name, 40);
    if (!name) throw `Chore ${i + 1} needs a name.`;
    const amountCents = checkCents(c?.amountCents);
    let id = typeof c?.id === "string" && /^[a-z0-9]{1,12}$/.test(c.id) ? c.id : "";
    if (!id || seen.has(id)) {
      do id = Math.random().toString(36).slice(2, 10); while (seen.has(id));
    }
    seen.add(id);
    return { id, name, amountCents };
  });
}

/**
 * Validates a notification webhook URL (Zapier, Make, IFTTT...). Empty string clears it.
 * Must be https; plain http is allowed only for localhost so the emulator tests can use it.
 */
function checkWebhookUrl(value, { allowLocalHttp = false } = {}) {
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value !== "string" || value.length > 500) throw "That doesn't look like a web address.";
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw "That doesn't look like a web address.";
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:")) {
    throw "The address must start with https://";
  }
  if (url.username || url.password) throw "Remove the username and password from the address.";
  return url.toString();
}

function cleanText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

module.exports = {
  WEEKDAYS,
  MAX_CENTS,
  MAX_CHORES,
  localDateParts,
  isValidTimeZone,
  checkChores,
  checkWebhookUrl,
  interestPeriodKey,
  computeInterest,
  isAllowanceDue,
  checkCents,
  checkPin,
  checkWeekday,
  checkRate,
  cleanText,
};
