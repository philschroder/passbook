import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithCustomToken } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, collection, query, where } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import assert from "node:assert/strict";

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
const { familyId, code } = await P.call("createFamily", { name: "Test Family" });
const claims = (await cred.user.getIdTokenResult(true)).claims;
assert.equal(claims.role, "parent"); assert.equal(claims.familyId, familyId);
console.log("family", familyId, "code", code);

const { kidId: ava } = await P.call("addKid", { name: "Ava", pin: "1234", allowanceCents: 500, allowanceDay: 0 });
const { kidId: ben } = await P.call("addKid", { name: "Ben", pin: "9999", allowanceCents: 300, allowanceDay: 3 });
await P.call("updateSettings", { interestRatePct: 10, interestPeriod: "weekly", interestCapCents: 0 });
await P.call("postEntry", { kidId: ava, kind: "deposit", amountCents: 2000, memo: "Birthday" });
await rejects(P.call("postEntry", { kidId: ava, kind: "withdrawal", amountCents: 10000 }), /enough/, "overdraw blocked");
await rejects(P.call("addKid", { name: "Cy", pin: "12" }), /PIN/, "bad PIN rejected");

const r1 = await P.call("runPayoutsNow", {});
const r2 = await P.call("runPayoutsNow", {});
console.log("payouts run1", r1, "run2", r2);
assert.equal(r2.payouts, 0, "second run pays nothing");
let a = (await getDoc(doc(P.db, `families/${familyId}/kids/${ava}`))).data();
console.log("Ava balance after payouts:", a.balanceCents);
assert.equal(a.balanceCents, 2000 + 200 + 500, "interest on 20.00 then allowance"); // Sunday in NY

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
assert.equal(a.balanceCents, 2400);
await K.call("setGoal", { name: "Bike", amountCents: 12000 });
a = (await getDoc(doc(K.db, `families/${familyId}/kids/${ava}`))).data();
assert.deepEqual(a.goal, { name: "Bike", amountCents: 12000 });
console.log("Final Ava:", a.balanceCents, a.goal);
console.log("ALL E2E CHECKS PASSED");
process.exit(0);
