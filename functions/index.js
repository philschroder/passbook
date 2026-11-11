"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("node:crypto");
const core = require("./lib/core");

initializeApp();
const db = getFirestore();

// Each family stores its own time zone (detected from the parent's browser at signup).
// FAMILY_TIMEZONE is only the fallback for families created before that existed.
const TZ = process.env.FAMILY_TIMEZONE || "America/New_York";
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";
const PAYOUT_HOUR = 6; // local time; the hourly job pays the first run at or after this hour
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_PENDING_REQUESTS = 10;

setGlobalOptions({ region: process.env.FUNCTIONS_REGION || "us-central1", maxInstances: 10 });

// ---------- helpers ----------

/** Wraps a handler so validation strings thrown by core become clean client errors. */
function callable(handler) {
  return onCall(async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      if (typeof err === "string") throw new HttpsError("invalid-argument", err);
      console.error(err);
      throw new HttpsError("internal", "Something went wrong. Try again.");
    }
  });
}

function requireParent(req) {
  const t = req.auth?.token;
  if (!t || t.role !== "parent" || !t.familyId) {
    throw new HttpsError("permission-denied", "Sign in as a parent to do that.");
  }
  return t.familyId;
}

function requireKid(req) {
  const t = req.auth?.token;
  if (!t || t.role !== "kid" || !t.familyId || !t.kidId) {
    throw new HttpsError("permission-denied", "Sign in with your PIN to do that.");
  }
  return { familyId: t.familyId, kidId: t.kidId };
}

const kidRef = (fid, kidId) => db.doc(`families/${fid}/kids/${kidId}`);
const secretRef = (fid, kidId) => db.doc(`families/${fid}/kidSecrets/${kidId}`);
// Parent-only settings that kids must not see (rules: parent read, no writes).
const privateRef = (fid) => db.doc(`families/${fid}/private/settings`);

const familyTz = (f) => (core.isValidTimeZone(f?.timeZone) ? f.timeZone : TZ);

/** "Now", or a fixed instant passed by the e2e test (emulator only) so date math is testable. */
function nowFor(req) {
  if (IS_EMULATOR && req?.data?.asOf) {
    const d = new Date(req.data.asOf);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(pin, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
function randomCode(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Writes one ledger entry inside a transaction. All reads must already be done.
 * delta is signed cents. Returns the new balance.
 */
function writeEntry(t, ref, kid, { type, delta, memo, by }) {
  const balanceAfterCents = kid.balanceCents + delta;
  if (balanceAfterCents < 0) {
    throw new HttpsError("failed-precondition", `${kid.name} doesn't have enough saved for that.`);
  }
  t.update(ref, { balanceCents: balanceAfterCents });
  t.set(ref.collection("transactions").doc(), {
    type,
    amountCents: delta,
    balanceAfterCents,
    memo: memo || "",
    by,
    createdAt: FieldValue.serverTimestamp(),
  });
  return balanceAfterCents;
}

// ---------- parent: family setup ----------

exports.createFamily = callable(async (req) => {
  const uid = req.auth?.uid;
  const provider = req.auth?.token?.firebase?.sign_in_provider;
  // Only email/password (or other real) accounts can own a family, never a kid's session.
  if (!uid || provider === "custom" || provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign in as a parent first.");
  }
  if (req.auth.token.familyId) throw new HttpsError("already-exists", "You already have a family.");

  const name = core.cleanText(req.data?.name, 40) || "Our family";
  const timeZone = core.isValidTimeZone(req.data?.timeZone) ? req.data.timeZone : TZ;
  const familyRef = db.collection("families").doc();

  let code;
  for (let i = 0; i < 5 && !code; i++) {
    const candidate = randomCode();
    try {
      await db.doc(`codes/${candidate}`).create({ familyId: familyRef.id });
      code = candidate;
    } catch (e) {
      if (e.code !== 6) throw e; // 6 = ALREADY_EXISTS, try another code
    }
  }
  if (!code) throw new HttpsError("internal", "Couldn't create a family code. Try again.");

  await familyRef.set({
    name,
    code,
    parentUids: [uid],
    interestRatePct: 0,
    interestPeriod: "monthly",
    interestCapCents: 0,
    chores: [],
    timeZone,
    createdAt: FieldValue.serverTimestamp(),
  });
  await getAuth().setCustomUserClaims(uid, { role: "parent", familyId: familyRef.id });
  return { familyId: familyRef.id, code };
});

exports.updateSettings = callable(async (req) => {
  const fid = requireParent(req);
  const d = req.data || {};
  const update = {};
  if (d.name !== undefined) update.name = core.cleanText(d.name, 40) || "Our family";
  if (d.interestRatePct !== undefined) update.interestRatePct = core.checkRate(d.interestRatePct);
  if (d.interestPeriod !== undefined) {
    if (!["weekly", "monthly"].includes(d.interestPeriod)) throw "Interest period must be weekly or monthly.";
    update.interestPeriod = d.interestPeriod;
  }
  if (d.interestCapCents !== undefined) update.interestCapCents = core.checkCents(d.interestCapCents, { allowZero: true });
  if (d.timeZone !== undefined) {
    if (!core.isValidTimeZone(d.timeZone)) throw "Pick a time zone from the list.";
    update.timeZone = d.timeZone;
  }
  if (d.chores !== undefined) update.chores = core.checkChores(d.chores);

  const batch = db.batch();
  if (Object.keys(update).length) batch.update(db.doc(`families/${fid}`), update);
  if (d.webhookUrl !== undefined) {
    batch.set(privateRef(fid), { webhookUrl: core.checkWebhookUrl(d.webhookUrl, { allowLocalHttp: IS_EMULATOR }) }, { merge: true });
  }
  await batch.commit();
  return { ok: true };
});

/** Sends a sample event to the family's webhook so parents can map fields in Zapier/Make. */
exports.testWebhook = callable(async (req) => {
  const fid = requireParent(req);
  const url = (await privateRef(fid).get()).data()?.webhookUrl;
  if (!url) throw new HttpsError("failed-precondition", "Save a notification address first.");
  const fam = (await db.doc(`families/${fid}`).get()).data();
  const ok = await sendWebhook(url, {
    event: "test",
    family: fam.name,
    saver: "Sample Saver",
    summary: `Test from ${fam.name}'s Passbook. If you can read this, notifications work.`,
    kind: "deposit",
    amount: "5.00",
    amountCents: 500,
    balance: "25.00",
    balanceCents: 2500,
    memo: "Sample entry",
    at: new Date().toISOString(),
  });
  if (!ok) throw new HttpsError("unavailable", "The address didn't accept the test. Check it and try again.");
  return { ok: true };
});

// ---------- parent: kids ----------

exports.addKid = callable(async (req) => {
  const fid = requireParent(req);
  const d = req.data || {};
  const name = core.cleanText(d.name, 30);
  if (!name) throw "Enter a name.";
  const pin = core.checkPin(d.pin);
  const allowanceCents = core.checkCents(d.allowanceCents ?? 0, { allowZero: true });
  const allowanceDay = core.checkWeekday(d.allowanceDay ?? 0);

  const ref = db.collection(`families/${fid}/kids`).doc();
  const batch = db.batch();
  batch.set(ref, {
    name,
    balanceCents: 0,
    allowanceCents,
    allowanceDay,
    goal: null,
    archived: false,
    lastAllowanceDate: null,
    lastInterestKey: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(secretRef(fid, ref.id), { pinHash: hashPin(pin), failedAttempts: 0, lockedUntil: 0 });
  await batch.commit();
  return { kidId: ref.id };
});

exports.updateKid = callable(async (req) => {
  const fid = requireParent(req);
  const d = req.data || {};
  const ref = kidRef(fid, String(d.kidId || ""));
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "Kid not found.");

  const update = {};
  if (d.name !== undefined) {
    update.name = core.cleanText(d.name, 30);
    if (!update.name) throw "Enter a name.";
  }
  if (d.allowanceCents !== undefined) update.allowanceCents = core.checkCents(d.allowanceCents, { allowZero: true });
  if (d.allowanceDay !== undefined) update.allowanceDay = core.checkWeekday(d.allowanceDay);
  if (d.archived !== undefined) update.archived = Boolean(d.archived);

  const batch = db.batch();
  if (Object.keys(update).length) batch.update(ref, update);
  if (d.pin) {
    batch.set(secretRef(fid, ref.id), {
      pinHash: hashPin(core.checkPin(d.pin)),
      failedAttempts: 0,
      lockedUntil: 0,
    });
  }
  await batch.commit();
  return { ok: true };
});

/**
 * Parent adds or takes out money. Pass kidId for one saver or kidIds for several at once
 * ("give everyone $5"); a multi-kid entry is all-or-nothing.
 */
exports.postEntry = callable(async (req) => {
  const fid = requireParent(req);
  const d = req.data || {};
  if (!["deposit", "withdrawal"].includes(d.kind)) throw "Choose deposit or withdrawal.";
  const amount = core.checkCents(d.amountCents);
  const memo = core.cleanText(d.memo, 80);
  const ids = [...new Set((Array.isArray(d.kidIds) ? d.kidIds : [d.kidId]).map((x) => String(x || "")))];
  if (!ids.length || ids.some((x) => !x)) throw "Pick at least one saver.";
  if (ids.length > 50) throw "That's too many savers at once.";
  const refs = ids.map((id) => kidRef(fid, id));

  await db.runTransaction(async (t) => {
    const snaps = await t.getAll(...refs);
    if (snaps.some((s) => !s.exists)) throw new HttpsError("not-found", "Kid not found.");
    snaps.forEach((snap, i) => {
      writeEntry(t, refs[i], snap.data(), {
        type: d.kind,
        delta: d.kind === "deposit" ? amount : -amount,
        memo,
        by: "parent",
      });
    });
  });
  return { ok: true, count: ids.length };
});

exports.resolveRequest = callable(async (req) => {
  const fid = requireParent(req);
  const reqRef = db.doc(`families/${fid}/requests/${String(req.data?.requestId || "")}`);
  const approve = Boolean(req.data?.approve);

  await db.runTransaction(async (t) => {
    const rSnap = await t.get(reqRef);
    if (!rSnap.exists) throw new HttpsError("not-found", "Request not found.");
    const r = rSnap.data();
    if (r.status !== "pending") throw new HttpsError("failed-precondition", "That request was already handled.");

    const ref = kidRef(fid, r.kidId);
    const kSnap = approve ? await t.get(ref) : null;
    if (approve) {
      if (!kSnap.exists) throw new HttpsError("not-found", "Kid not found.");
      writeEntry(t, ref, kSnap.data(), {
        type: r.kind,
        delta: r.kind === "deposit" ? r.amountCents : -r.amountCents,
        memo: r.memo,
        by: "request",
      });
    }
    t.update(reqRef, {
      status: approve ? "approved" : "denied",
      resolvedAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true };
});

// ---------- kid sign-in ----------

/** Unauthenticated: returns first names for a family code so kids can pick themselves. */
exports.listKidsForCode = callable(async (req) => {
  const code = core.cleanText(req.data?.code, 10).toUpperCase();
  const codeSnap = await db.doc(`codes/${code}`).get();
  if (!codeSnap.exists) throw new HttpsError("not-found", "That family code doesn't match. Check with a parent.");
  const kids = await db
    .collection(`families/${codeSnap.data().familyId}/kids`)
    .where("archived", "==", false)
    .get();
  // Only first name and avatar emoji, so kids can spot themselves on the sign-in screen.
  return { kids: kids.docs.map((k) => ({ kidId: k.id, name: k.data().name, avatar: k.data().look?.avatar || null })) };
});

/**
 * Kid sign-in. The kid's device first signs in anonymously (which by itself can read nothing);
 * if the PIN is right, this marks that anonymous account as the kid with custom claims.
 * Setting claims needs no extra Google Cloud permissions, unlike signing custom tokens.
 */
exports.kidLogin = callable(async (req) => {
  const caller = req.auth;
  if (!caller?.uid || caller.token?.firebase?.sign_in_provider !== "anonymous") {
    throw new HttpsError("unauthenticated", "Open Passbook again, then pick your name.");
  }
  const code = core.cleanText(req.data?.code, 10).toUpperCase();
  const kidId = String(req.data?.kidId || "");
  const pin = core.checkPin(req.data?.pin);

  const codeSnap = await db.doc(`codes/${code}`).get();
  if (!codeSnap.exists) throw new HttpsError("not-found", "That family code doesn't match.");
  const fid = codeSnap.data().familyId;
  const kSnap = await kidRef(fid, kidId).get();
  if (!kSnap.exists || kSnap.data().archived) throw new HttpsError("not-found", "Kid not found.");

  // Run the check in a transaction so the attempt counter is accurate, then throw outside it
  // (throwing inside would roll back the failed-attempt write).
  const result = await db.runTransaction(async (t) => {
    const sRef = secretRef(fid, kidId);
    const s = (await t.get(sRef)).data();
    const now = Date.now();
    if (!s) return { ok: false, reason: "missing" };
    if (s.lockedUntil > now) return { ok: false, reason: "locked", until: s.lockedUntil };
    if (verifyPin(pin, s.pinHash)) {
      t.update(sRef, { failedAttempts: 0, lockedUntil: 0 });
      return { ok: true };
    }
    const attempts = (s.failedAttempts || 0) + 1;
    const locked = attempts >= MAX_PIN_ATTEMPTS;
    t.update(sRef, { failedAttempts: locked ? 0 : attempts, lockedUntil: locked ? now + LOCKOUT_MS : 0 });
    return { ok: false, reason: locked ? "locked" : "wrong", left: MAX_PIN_ATTEMPTS - attempts };
  });

  if (!result.ok) {
    if (result.reason === "locked") {
      throw new HttpsError("resource-exhausted", "Too many wrong PINs. Try again in 15 minutes or ask a parent.");
    }
    if (result.reason === "wrong") {
      throw new HttpsError("permission-denied", `Wrong PIN. ${result.left} tries left.`);
    }
    throw new HttpsError("failed-precondition", "No PIN set. Ask a parent to reset it.");
  }

  await getAuth().setCustomUserClaims(caller.uid, { role: "kid", familyId: fid, kidId });
  return { ok: true };
});

// ---------- kid actions ----------

exports.createRequest = callable(async (req) => {
  const { familyId, kidId } = requireKid(req);
  const d = req.data || {};

  const kSnap = await kidRef(familyId, kidId).get();
  if (!kSnap.exists) throw new HttpsError("not-found", "Kid not found.");

  // A chore request takes its amount and name from the parent's chore list, so kids just tap.
  let kind, amountCents, memo, choreId = null;
  if (d.choreId) {
    const fam = (await db.doc(`families/${familyId}`).get()).data();
    const chore = (fam?.chores || []).find((c) => c.id === d.choreId);
    if (!chore) throw new HttpsError("not-found", "That chore isn't on the list anymore.");
    kind = "deposit";
    amountCents = chore.amountCents;
    memo = `Chore: ${chore.name}`;
    choreId = chore.id;
  } else {
    if (!["deposit", "withdrawal"].includes(d.kind)) throw "Choose add or spend.";
    kind = d.kind;
    amountCents = core.checkCents(d.amountCents);
    memo = core.cleanText(d.memo, 80);
    if (!memo) throw "Say what it's for.";
  }

  const requests = db.collection(`families/${familyId}/requests`);
  const pending = await requests.where("kidId", "==", kidId).where("status", "==", "pending").count().get();
  if (pending.data().count >= MAX_PENDING_REQUESTS) {
    throw new HttpsError("resource-exhausted", "You have a lot of requests waiting. Ask a parent to check them.");
  }

  await requests.add({
    kidId,
    kidName: kSnap.data().name,
    kind,
    amountCents,
    memo,
    choreId,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/** Kids set their own goal; parents can set any kid's goal by passing kidId. */
exports.setGoal = callable(async (req) => {
  const t = req.auth?.token;
  let fid;
  let kidId;
  if (t?.role === "parent") {
    fid = requireParent(req);
    kidId = String(req.data?.kidId || "");
  } else {
    ({ familyId: fid, kidId } = requireKid(req));
  }
  const ref = kidRef(fid, kidId);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "Kid not found.");

  if (req.data?.clear) {
    await ref.update({ goal: null });
    return { ok: true };
  }
  const name = core.cleanText(req.data?.name, 40);
  if (!name) throw "Name your goal.";
  const amountCents = core.checkCents(req.data?.amountCents);
  await ref.update({ goal: { name, amountCents } });
  return { ok: true };
});

/** Kids decorate their own page; parents can decorate any kid's by passing kidId. */
exports.setLook = callable(async (req) => {
  const t = req.auth?.token;
  let fid;
  let kidId;
  if (t?.role === "parent") {
    fid = requireParent(req);
    kidId = String(req.data?.kidId || "");
  } else {
    ({ familyId: fid, kidId } = requireKid(req));
  }
  const ref = kidRef(fid, kidId);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "Kid not found.");
  const look = core.checkLook(req.data?.look);
  await ref.update({ look });
  return { ok: true, look };
});

// ---------- scheduled payouts ----------

/** Pays any interest and allowance due today for one family. Safe to run repeatedly. */
async function processFamily(famDoc, parts) {
  const f = famDoc.data();
  if (!f) return 0;
  const interestKey = core.interestPeriodKey(f.interestPeriod, parts);
  const kids = await famDoc.ref.collection("kids").where("archived", "==", false).get();
  let payouts = 0;

  for (const kidDoc of kids.docs) {
    // Cheap pre-check so the hourly job doesn't open a transaction for kids with nothing due.
    const k0 = kidDoc.data();
    const interestDue = interestKey && f.interestRatePct > 0 && k0.lastInterestKey !== interestKey;
    if (!interestDue && !core.isAllowanceDue(k0, parts)) continue;
    await db.runTransaction(async (t) => {
      const snap = await t.get(kidDoc.ref);
      const kid = snap.data();
      let balance = kid.balanceCents;
      const update = {};
      const entries = [];

      if (interestKey && f.interestRatePct > 0 && kid.lastInterestKey !== interestKey) {
        update.lastInterestKey = interestKey;
        const amount = core.computeInterest(balance, f.interestRatePct, f.interestCapCents);
        if (amount > 0) {
          balance += amount;
          entries.push({ type: "interest", amountCents: amount, balanceAfterCents: balance, memo: `${f.interestRatePct}% ${f.interestPeriod} interest` });
        }
      }

      if (core.isAllowanceDue(kid, parts)) {
        update.lastAllowanceDate = parts.ymd;
        balance += kid.allowanceCents;
        entries.push({ type: "allowance", amountCents: kid.allowanceCents, balanceAfterCents: balance, memo: "Weekly allowance" });
      }

      if (!Object.keys(update).length) return;
      update.balanceCents = balance;
      t.update(kidDoc.ref, update);
      for (const e of entries) {
        t.set(kidDoc.ref.collection("transactions").doc(), { ...e, by: "system", createdAt: FieldValue.serverTimestamp() });
      }
      payouts += entries.length;
    });
  }
  return payouts;
}

/**
 * Runs every hour. Each family is paid on the first run at or after 6 AM in its own time zone;
 * the per-kid stamps make every later run that day a no-op.
 */
exports.dailyPayouts = onSchedule({ schedule: "5 * * * *", timeZone: "UTC" }, async () => {
  const now = new Date();
  const families = await db.collection("families").get();
  let total = 0;
  for (const fam of families.docs) {
    const parts = core.localDateParts(now, familyTz(fam.data()));
    if (parts.hour < PAYOUT_HOUR) continue;
    try {
      total += await processFamily(fam, parts);
    } catch (err) {
      console.error(`payouts failed for family ${fam.id}`, err); // don't let one family block the rest
    }
  }
  console.log(`dailyPayouts ${now.toISOString()}: ${total} entries across ${families.size} families`);
});

/** Parent-triggered run of today's payouts for their family (idempotent; ignores the 6 AM hour). */
exports.runPayoutsNow = callable(async (req) => {
  const fid = requireParent(req);
  const famDoc = await db.doc(`families/${fid}`).get();
  const parts = core.localDateParts(nowFor(req), familyTz(famDoc.data()));
  const payouts = await processFamily(famDoc, parts);
  return { payouts, date: parts.ymd };
});

// ---------- notifications (webhook to Zapier, Make, IFTTT, ...) ----------

/** POSTs a flat JSON payload. Never throws; returns true on a 2xx. */
async function sendWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (err) {
    console.warn("webhook failed", err.message);
    return false;
  }
}

const dollars = (cents) => (cents / 100).toFixed(2);

async function notify(fid, build) {
  const url = (await privateRef(fid).get()).data()?.webhookUrl;
  if (!url) return;
  const fam = (await db.doc(`families/${fid}`).get()).data();
  if (!fam) return;
  await sendWebhook(url, { family: fam.name, at: new Date().toISOString(), ...(await build(fam)) });
}

const TYPE_WORDS = { deposit: "added", withdrawal: "took out", allowance: "allowance", interest: "interest" };

exports.notifyOnRequest = onDocumentCreated("families/{fid}/requests/{reqId}", async (event) => {
  const r = event.data?.data();
  if (!r) return;
  await notify(event.params.fid, async () => {
    const kid = (await kidRef(event.params.fid, r.kidId).get()).data();
    const verb = r.kind === "deposit" ? "add" : "spend";
    return {
      event: "request.created",
      saver: r.kidName,
      summary: `${r.kidName} wants to ${verb} $${dollars(r.amountCents)}: ${r.memo}. Open Passbook to approve.`,
      kind: r.kind,
      amount: dollars(r.amountCents),
      amountCents: r.amountCents,
      balance: dollars(kid?.balanceCents || 0),
      balanceCents: kid?.balanceCents || 0,
      memo: r.memo,
      requestId: event.params.reqId,
    };
  });
});

exports.notifyOnEntry = onDocumentCreated("families/{fid}/kids/{kidId}/transactions/{txId}", async (event) => {
  const tx = event.data?.data();
  if (!tx) return;
  await notify(event.params.fid, async () => {
    const kid = (await kidRef(event.params.fid, event.params.kidId).get()).data();
    const name = kid?.name || "A saver";
    const sign = tx.amountCents < 0 ? "-" : "+";
    return {
      event: "entry.posted",
      saver: name,
      summary: `${name}: ${sign}$${dollars(Math.abs(tx.amountCents))} ${TYPE_WORDS[tx.type] || tx.type}${tx.memo ? ` (${tx.memo})` : ""}. Balance $${dollars(tx.balanceAfterCents)}.`,
      kind: tx.type,
      amount: dollars(Math.abs(tx.amountCents)),
      amountCents: tx.amountCents,
      balance: dollars(tx.balanceAfterCents),
      balanceCents: tx.balanceAfterCents,
      memo: tx.memo || "",
      by: tx.by,
    };
  });
});
