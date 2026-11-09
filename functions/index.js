"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("node:crypto");
const core = require("./lib/core");

initializeApp();
const db = getFirestore();

// Set FAMILY_TIMEZONE in functions/.env (IANA name). Used for the daily job and weekday math.
const TZ = process.env.FAMILY_TIMEZONE || "America/New_York";
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
  if (!uid || provider === "custom") throw new HttpsError("unauthenticated", "Sign in as a parent first.");
  if (req.auth.token.familyId) throw new HttpsError("already-exists", "You already have a family.");

  const name = core.cleanText(req.data?.name, 40) || "Our family";
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
    timeZone: TZ,
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
  await db.doc(`families/${fid}`).update(update);
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

exports.postEntry = callable(async (req) => {
  const fid = requireParent(req);
  const d = req.data || {};
  if (!["deposit", "withdrawal"].includes(d.kind)) throw "Choose deposit or withdrawal.";
  const amount = core.checkCents(d.amountCents);
  const memo = core.cleanText(d.memo, 80);
  const ref = kidRef(fid, String(d.kidId || ""));

  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Kid not found.");
    writeEntry(t, ref, snap.data(), {
      type: d.kind,
      delta: d.kind === "deposit" ? amount : -amount,
      memo,
      by: "parent",
    });
  });
  return { ok: true };
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
  return { kids: kids.docs.map((k) => ({ kidId: k.id, name: k.data().name })) };
});

exports.kidLogin = callable(async (req) => {
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

  const token = await getAuth().createCustomToken(`kid_${fid}_${kidId}`, {
    role: "kid",
    familyId: fid,
    kidId,
  });
  return { token };
});

// ---------- kid actions ----------

exports.createRequest = callable(async (req) => {
  const { familyId, kidId } = requireKid(req);
  const d = req.data || {};
  if (!["deposit", "withdrawal"].includes(d.kind)) throw "Choose add or spend.";
  const amountCents = core.checkCents(d.amountCents);
  const memo = core.cleanText(d.memo, 80);
  if (!memo) throw "Say what it's for.";

  const kSnap = await kidRef(familyId, kidId).get();
  if (!kSnap.exists) throw new HttpsError("not-found", "Kid not found.");
  const requests = db.collection(`families/${familyId}/requests`);
  const pending = await requests.where("kidId", "==", kidId).where("status", "==", "pending").count().get();
  if (pending.data().count >= MAX_PENDING_REQUESTS) {
    throw new HttpsError("resource-exhausted", "You have a lot of requests waiting. Ask a parent to check them.");
  }

  await requests.add({
    kidId,
    kidName: kSnap.data().name,
    kind: d.kind,
    amountCents,
    memo,
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

// ---------- scheduled payouts ----------

/** Pays any interest and allowance due today for one family. Safe to run repeatedly. */
async function processFamily(famDoc, parts) {
  const f = famDoc.data();
  const interestKey = core.interestPeriodKey(f.interestPeriod, parts);
  const kids = await famDoc.ref.collection("kids").where("archived", "==", false).get();
  let payouts = 0;

  for (const kidDoc of kids.docs) {
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

exports.dailyPayouts = onSchedule({ schedule: "5 6 * * *", timeZone: TZ }, async () => {
  const parts = core.localDateParts(new Date(), TZ);
  const families = await db.collection("families").get();
  let total = 0;
  for (const fam of families.docs) total += await processFamily(fam, parts);
  console.log(`dailyPayouts ${parts.ymd}: ${total} entries across ${families.size} families`);
});

/** Parent-triggered run of today's payouts for their family (idempotent; handy for testing). */
exports.runPayoutsNow = callable(async (req) => {
  const fid = requireParent(req);
  const parts = core.localDateParts(new Date(), TZ);
  const payouts = await processFamily(await db.doc(`families/${fid}`).get(), parts);
  return { payouts, date: parts.ymd };
});
