import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithCustomToken } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, collection, query, where } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import assert from "node:assert/strict";
import http from "node:http";

// A local stand-in for a Zapier catch hook: records every POST the functions send.
const hookEvents = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => { hookEvents.push(JSON.parse(body)); res.end("ok"); });
});
await new Promise((r) => hook.listen(0, "127.0.0.1", r));
const hookUrl = `http://127.0.0.1:${hook.address().port}/hooks/catch/test`;
const waitFor = async (pred, label, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const hit = hookEvents.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 200)); }
  assert.fail(`timed out waiting for webhook: ${label}`);
};

// Payout math depends on the date, so pin "today" to a Sunday morning in New York.
const SUNDAY = "2026-11-08T12:00:00Z";

const cfg = { apiKey: "demo", projectId: "demo-passbook", authDomain: "demo-passbook.firebaseapp.com" };
function client(name) {
  const app = initializeApp(cfg, name);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, "127.0.0.1", 8080);
  const fns = getFunctions(app, "us-central1"); connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  const call = async (n, d) => (await httpsCallable(fns, n)(d)).data;
  return { auth, db, call };
}
const denied = async (p, label) => { try { await p; assert.fail(`${label} should be denied`); } catch (e) { assert.match(String(e.code || e.message), /permission|denied/i, label); } };
const rejects = async (p, re, label) => { try { await p; assert.fail(`${label} should fail`); } catch (e) { assert.match(e.message, re, label); console.log(`  ok: ${label} -> "${e.message}"`); } };

const P = client("parent");
const cred = await createUserWithEmailAndPassword(P.auth, `p${Date.now()}@test.dev`, "secret123");
const { familyId, code } = await P.call("createFamily", { name: "Test Family", timeZone: "America/New_York" });
const claims = (await cred.user.getIdTokenResult(true)).claims;
assert.equal(claims.role, "parent"); assert.equal(claims.familyId, familyId);
console.log("family", familyId, "code", code);

const { kidId: ava } = await P.call("addKid", { name: "Ava", pin: "1234", allowanceCents: 500, allowanceDay: 0 });
const { kidId: ben } = await P.call("addKid", { name: "Ben", pin: "9999", allowanceCents: 300, allowanceDay: 3 });
await P.call("updateSettings", { interestRatePct: 10, interestPeriod: "weekly", interestCapCents: 0 });
await rejects(P.call("updateSettings", { timeZone: "Mars/Olympus" }), /time zone/, "bad time zone rejected");
await rejects(P.call("updateSettings", { webhookUrl: "ftp://x" }), /https/, "bad webhook rejected");
await P.call("postEntry", { kidId: ava, kind: "deposit", amountCents: 2000, memo: "Birthday" });
await rejects(P.call("postEntry", { kidId: ava, kind: "withdrawal", amountCents: 10000 }), /enough/, "overdraw blocked");
await rejects(P.call("addKid", { name: "Cy", pin: "12" }), /PIN/, "bad PIN rejected");

const r1 = await P.call("runPayoutsNow", { asOf: SUNDAY });
const r2 = await P.call("runPayoutsNow", { asOf: SUNDAY });
console.log("payouts run1", r1, "run2", r2);
assert.equal(r2.payouts, 0, "second run pays nothing");
let a = (await getDoc(doc(P.db, `families/${familyId}/kids/${ava}`))).data();
console.log("Ava balance after payouts:", a.balanceCents);
assert.equal(a.balanceCents, 2000 + 200 + 500, "interest on 20.00 then allowance"); // Sunday in NY
const monday = await P.call("runPayoutsNow", { asOf: "2026-11-09T12:00:00Z" });
assert.equal(monday.payouts, 0, "nothing due on a Monday");
let b = (await getDoc(doc(P.db, `families/${familyId}/kids/${ben}`))).data();
assert.equal(b.balanceCents, 0, "Ben's allowance is Wednesdays");
const wed = await P.call("runPayoutsNow", { asOf: "2026-11-11T12:00:00Z" });
assert.equal(wed.payouts, 1);
b = (await getDoc(doc(P.db, `families/${familyId}/kids/${ben}`))).data();
assert.equal(b.balanceCents, 300, "Ben paid on Wednesday");
console.log("  ok: payouts follow the family's calendar");

// Give to several at once, all-or-nothing
await P.call("postEntry", { kidIds: [ava, ben], kind: "deposit", amountCents: 1000, memo: "Holiday gift" });
await rejects(P.call("postEntry", { kidIds: [ava, ben], kind: "withdrawal", amountCents: 2000 }), /Ben doesn't have enough/, "multi-kid overdraw blocked");
a = (await getDoc(doc(P.db, `families/${familyId}/kids/${ava}`))).data();
b = (await getDoc(doc(P.db, `families/${familyId}/kids/${ben}`))).data();
assert.equal(a.balanceCents, 3700); assert.equal(b.balanceCents, 1300);
console.log("  ok: give-to-several is all-or-nothing");

// Chores + webhook
await P.call("updateSettings", { chores: [{ name: "Feed the dog", amountCents: 150 }, { name: "Dishes", amountCents: 200 }], webhookUrl: hookUrl });
const fam = (await getDoc(doc(P.db, `families/${familyId}`))).data();
assert.equal(fam.chores.length, 2);
assert.equal(fam.timeZone, "America/New_York");
assert.equal((await getDoc(doc(P.db, `families/${familyId}/private/settings`))).data().webhookUrl, hookUrl);
await P.call("testWebhook", {});
await waitFor((e) => e.event === "test", "test event");
console.log("  ok: chores saved, webhook test delivered");

// Kid login
const K = client("kid");
const list = await K.call("listKidsForCode", { code });
assert.deepEqual(list.kids.map(k => k.name).sort(), ["Ava", "Ben"]);
await rejects(K.call("kidLogin", { code, kidId: ava, pin: "0000" }), /Wrong PIN. 4 tries left/, "wrong PIN counted");
const { token } = await K.call("kidLogin", { code, kidId: ava, pin: "1234" });
await signInWithCustomToken(K.auth, token);
const kc = (await K.auth.currentUser.getIdTokenResult()).claims;
assert.equal(kc.role, "kid"); assert.equal(kc.kidId, ava);

// Rules
assert.equal((await getDoc(doc(K.db, `families/${familyId}/kids/${ava}`))).data().name, "Ava");
assert.ok((await getDocs(collection(K.db, `families/${familyId}/kids/${ava}/transactions`))).size >= 3);
await denied(getDoc(doc(K.db, `families/${familyId}/kids/${ben}`)), "kid reading sibling");
await denied(getDoc(doc(K.db, `families/${familyId}/kidSecrets/${ava}`)), "kid reading PIN hash");
await denied(getDoc(doc(P.db, `families/${familyId}/kidSecrets/${ava}`)), "parent reading PIN hash");
await denied(getDoc(doc(K.db, `families/${familyId}/private/settings`)), "kid reading webhook");
await denied(setDoc(doc(K.db, `families/${familyId}/kids/${ava}`), { balanceCents: 999999 }, { merge: true }), "kid writing balance");
await denied(setDoc(doc(P.db, `families/${familyId}/kids/${ava}`), { balanceCents: 999999 }, { merge: true }), "parent writing balance directly");
console.log("  ok: rules deny sibling, secrets, and direct writes");

// Requests
await K.call("createRequest", { kind: "withdrawal", amountCents: 300, memo: "Comic book" });
await rejects(K.call("postEntry", { kidId: ava, kind: "deposit", amountCents: 100 }), /parent/i, "kid can't post entries");
const kidReqs = await getDocs(query(collection(K.db, `families/${familyId}/requests`), where("kidId", "==", ava), where("status", "==", "pending")));
assert.equal(kidReqs.size, 1);
const pReqs = await getDocs(query(collection(P.db, `families/${familyId}/requests`), where("status", "==", "pending")));
await P.call("resolveRequest", { requestId: pReqs.docs[0].id, approve: true });
await rejects(P.call("resolveRequest", { requestId: pReqs.docs[0].id, approve: true }), /already/, "double approve blocked");
a = (await getDoc(doc(K.db, `families/${familyId}/kids/${ava}`))).data();
assert.equal(a.balanceCents, 3400);

// Kid taps a chore: amount and memo come from the parent's list, not the kid
const choreId = fam.chores.find((c) => c.name === "Dishes").id;
await K.call("createRequest", { choreId, amountCents: 999999 });
await rejects(K.call("createRequest", { choreId: "nope" }), /isn't on the list/, "unknown chore rejected");
const choreReq = (await getDocs(query(collection(P.db, `families/${familyId}/requests`), where("status", "==", "pending")))).docs[0];
assert.equal(choreReq.data().amountCents, 200);
assert.equal(choreReq.data().memo, "Chore: Dishes");
const reqHook = await waitFor((e) => e.event === "request.created" && e.memo === "Chore: Dishes", "chore request");
assert.equal(reqHook.saver, "Ava"); assert.equal(reqHook.amount, "2.00");
await P.call("resolveRequest", { requestId: choreReq.id, approve: true });
a = (await getDoc(doc(K.db, `families/${familyId}/kids/${ava}`))).data();
assert.equal(a.balanceCents, 3600);
const entryHook = await waitFor((e) => e.event === "entry.posted" && e.memo === "Chore: Dishes", "chore entry");
assert.equal(entryHook.balance, "36.00");
console.log("  ok: chore request priced server-side, webhooks for request and entry");
await K.call("setGoal", { name: "Bike", amountCents: 12000 });
a = (await getDoc(doc(K.db, `families/${familyId}/kids/${ava}`))).data();
assert.deepEqual(a.goal, { name: "Bike", amountCents: 12000 });
console.log("Final Ava:", a.balanceCents, a.goal);
console.log("ALL E2E CHECKS PASSED");
hook.close();
process.exit(0);
