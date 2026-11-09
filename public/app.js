import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithCustomToken, signOut, sendPasswordResetEmail, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, collection, query, where, orderBy, limit, onSnapshot, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  getFunctions, httpsCallable, connectFunctionsEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js";
import { firebaseConfig, functionsRegion } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, functionsRegion || "us-central1");

if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
}

const $app = document.getElementById("app");
const $header = document.getElementById("header-actions");
const $sheet = document.getElementById("sheet");
const $toast = document.getElementById("toast");

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CODE_KEY = "passbook.familyCode";

// ---------- small helpers ----------

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (cents) => usd.format((cents || 0) / 100);
const centsToInput = (cents) => ((cents || 0) / 100).toFixed(2);

/** "$5.25", "5", "1,200.5" -> cents. Returns NaN for anything else. */
function parseDollars(str) {
  const s = String(str ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

async function call(name, data) {
  try {
    return (await httpsCallable(fns, name)(data)).data;
  } catch (err) {
    throw new Error(err?.message?.replace(/^.*?:\s*/, "") || "Something went wrong.");
  }
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove("show"), 2600);
}

function storageGet(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } }
function storageSet(key, val) { try { localStorage.setItem(key, val); } catch { /* private mode */ } }

const fmtDate = (ts) => (ts?.toDate ? ts.toDate().toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "now");

// Live listeners for the current screen; cleared on every route change.
let unsubs = [];
const clearSubs = () => { unsubs.forEach((u) => u()); unsubs = []; };

// ---------- dialog ----------

let sheetCleanup = null;

/**
 * Opens the shared modal. If onSubmit is given, body is wrapped in a form; onSubmit
 * receives FormData and may throw an Error whose message is shown inline.
 */
function openSheet({ title, body, submitLabel, onSubmit, wide = false, onOpen }) {
  // If a sheet is already open (e.g. goal from passbook), tear down its listeners and reuse the dialog.
  if (typeof sheetCleanup === "function") sheetCleanup();
  sheetCleanup = null;
  $sheet.classList.toggle("wide", wide);
  const head = `<div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>
    <button type="button" class="btn-quiet" data-close>Close</button></div>`;
  $sheet.innerHTML = onSubmit
    ? `${head}<form novalidate>${body}<p class="form-error" id="sheet-error"></p>
        <div class="sheet-actions"><button type="submit">${esc(submitLabel || "Save")}</button></div></form>`
    : `${head}${body}`;

  $sheet.querySelector("[data-close]").addEventListener("click", () => $sheet.close());
  const form = $sheet.querySelector("form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const errEl = form.querySelector("#sheet-error");
      errEl.textContent = "";
      btn.disabled = true;
      try {
        const msg = await onSubmit(new FormData(form), form);
        $sheet.close();
        if (msg) toast(msg);
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }
  if (!$sheet.open) $sheet.showModal();
  $sheet.querySelector("[autofocus]")?.focus();
  sheetCleanup = onOpen?.($sheet) || null;
}

$sheet.addEventListener("close", () => {
  if (typeof sheetCleanup === "function") sheetCleanup();
  sheetCleanup = null;
  $sheet.returnValue = "";
});

// ---------- shared rendering ----------

function ledgerHtml(txs) {
  if (!txs.length) return `<div class="ledger-wrap"><p class="empty">No entries yet. The first deposit shows up here.</p></div>`;
  const stampFor = { allowance: "ALLOW", interest: "INT" };
  const rows = txs.map((t) => {
    const inflow = t.amountCents >= 0;
    const stamp = stampFor[t.type] ? `<span class="stamp">${stampFor[t.type]}</span>` : "";
    return `<tr>
      <td>${esc(fmtDate(t.createdAt))}</td>
      <td class="memo">${esc(t.memo || t.type)}${stamp}</td>
      <td class="num ${inflow ? "in" : "out"}">${inflow ? "+" : "−"}${money(Math.abs(t.amountCents))}</td>
      <td class="num">${money(t.balanceAfterCents)}</td>
    </tr>`;
  }).join("");
  return `<div class="ledger-wrap"><table class="ledger">
    <thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col" class="num">In / out</th><th scope="col" class="num">Balance</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function goalHtml(kid) {
  if (!kid.goal) return "";
  const pct = Math.min(100, Math.round((kid.balanceCents / kid.goal.amountCents) * 100));
  return `<div class="goal">
    <div>Saving for <strong>${esc(kid.goal.name)}</strong>: ${money(kid.balanceCents)} of ${money(kid.goal.amountCents)}</div>
    <div class="goal-bar" role="progressbar" aria-label="Goal progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
  </div>`;
}

const allowanceText = (k) => (k.allowanceCents > 0 ? `${money(k.allowanceCents)} every ${DAYS[k.allowanceDay]}` : "No weekly allowance");

function interestText(f) {
  if (!f || !(f.interestRatePct > 0)) return "";
  const per = f.interestPeriod === "weekly" ? "each Sunday" : "on the 1st of each month";
  const cap = f.interestCapCents > 0 ? ` on up to ${money(f.interestCapCents)}` : "";
  return `${f.interestRatePct}% interest ${per}${cap}`;
}

function signOutButton() {
  $header.innerHTML = `<button type="button" class="btn-quiet" id="sign-out">Sign out</button>`;
  document.getElementById("sign-out").addEventListener("click", () => signOut(auth));
}

// ---------- routing ----------

onAuthStateChanged(auth, (user) => route(user));

async function route(user, forceRefresh = false) {
  clearSubs();
  if ($sheet.open) $sheet.close();
  $header.innerHTML = "";
  if (!user) return showLanding();
  const { claims } = await user.getIdTokenResult(forceRefresh);
  if (claims.role === "kid") return showKid(claims.familyId, claims.kidId);
  if (claims.role === "parent") return showParent(claims.familyId);
  return showCreateFamily(user);
}

// ---------- landing ----------

function showLanding() {
  const savedCode = storageGet(CODE_KEY);
  $app.innerHTML = `
    <h1>Save it. Watch it grow.</h1>
    <p class="muted">A family savings book. Parents hold the money; everyone sees the balance.</p>
    <div class="landing">
      <section class="panel" aria-labelledby="kid-title">
        <h2 id="kid-title">Kids</h2>
        <form id="code-form">
          <label>Family code
            <input name="code" value="${esc(savedCode)}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="8" required>
          </label>
          <button type="submit">Find my name</button>
        </form>
        <div id="kid-step"></div>
      </section>
      <section class="panel" aria-labelledby="parent-title">
        <h2 id="parent-title">Parents</h2>
        <form id="parent-form">
          <label>Email<input name="email" type="email" autocomplete="username" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
          <p class="form-error" id="parent-error"></p>
          <div class="btn-row">
            <button type="submit" name="mode" value="signin">Sign in</button>
            <button type="submit" name="mode" value="signup" class="btn-quiet">Create account</button>
          </div>
          <p style="margin-top:0.75rem"><button type="button" class="link" id="forgot">Forgot password</button></p>
        </form>
      </section>
    </div>`;

  // Parent sign in / sign up
  const pForm = document.getElementById("parent-form");
  const pErr = document.getElementById("parent-error");
  pForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = e.submitter?.value || "signin";
    const fd = new FormData(pForm);
    pErr.textContent = "";
    pForm.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const email = String(fd.get("email")).trim();
      const pw = String(fd.get("password"));
      if (mode === "signup") {
        pForm.password.setAttribute("autocomplete", "new-password");
        await createUserWithEmailAndPassword(auth, email, pw);
      } else {
        await signInWithEmailAndPassword(auth, email, pw);
      }
    } catch (err) {
      pErr.textContent = friendlyAuthError(err);
      pForm.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  });
  document.getElementById("forgot").addEventListener("click", async () => {
    const email = String(new FormData(pForm).get("email")).trim();
    if (!email) { pErr.textContent = "Enter your email first."; return; }
    try { await sendPasswordResetEmail(auth, email); toast("Password reset email sent"); }
    catch (err) { pErr.textContent = friendlyAuthError(err); }
  });

  // Kid: code -> pick name -> PIN
  const cForm = document.getElementById("code-form");
  const step = document.getElementById("kid-step");
  cForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = String(new FormData(cForm).get("code")).trim().toUpperCase();
    step.innerHTML = `<p class="muted">Looking…</p>`;
    try {
      const { kids } = await call("listKidsForCode", { code });
      storageSet(CODE_KEY, code);
      if (!kids.length) { step.innerHTML = `<p class="form-error">No savers in this family yet. Ask a parent to add you.</p>`; return; }
      showPinStep(step, code, kids);
    } catch (err) {
      step.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  });
  if (savedCode) cForm.requestSubmit();
}

function showPinStep(step, code, kids) {
  step.innerHTML = `
    <p>Who's saving?</p>
    <div class="kid-picks">${kids.map((k) => `<button type="button" class="btn-quiet" data-kid="${esc(k.kidId)}" aria-pressed="false">${esc(k.name)}</button>`).join("")}</div>
    <form id="pin-form" hidden>
      <label>Your PIN<input name="pin" class="pin-input" type="password" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" autocomplete="off" required></label>
      <p class="form-error" id="pin-error"></p>
      <button type="submit">Open my passbook</button>
    </form>`;
  let kidId = null;
  const pinForm = step.querySelector("#pin-form");
  step.querySelectorAll("[data-kid]").forEach((b) => b.addEventListener("click", () => {
    kidId = b.dataset.kid;
    step.querySelectorAll("[data-kid]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    pinForm.hidden = false;
    pinForm.pin.focus();
  }));
  pinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = step.querySelector("#pin-error");
    const btn = pinForm.querySelector("button");
    err.textContent = "";
    btn.disabled = true;
    try {
      const { token } = await call("kidLogin", { code, kidId, pin: String(new FormData(pinForm).get("pin")) });
      await signInWithCustomToken(auth, token);
    } catch (ex) {
      err.textContent = ex.message;
      pinForm.pin.value = "";
      btn.disabled = false;
    }
  });
}

function friendlyAuthError(err) {
  const map = {
    "auth/invalid-credential": "Email or password is wrong.",
    "auth/wrong-password": "Email or password is wrong.",
    "auth/user-not-found": "No account with that email. Choose Create account.",
    "auth/email-already-in-use": "That email already has an account. Choose Sign in.",
    "auth/weak-password": "Use at least 6 characters for the password.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  };
  return map[err?.code] || err?.message || "Sign-in failed.";
}

// ---------- parent: first run ----------

function showCreateFamily(user) {
  signOutButton();
  $app.innerHTML = `
    <h1>Set up your family</h1>
    <p class="muted">You'll get a family code. Kids use it with their own PIN to sign in.</p>
    <form id="family-form" class="panel">
      <label>Family name<input name="name" placeholder="The Garcias" maxlength="40" required></label>
      <p class="form-error" id="family-error"></p>
      <button type="submit">Create family</button>
    </form>`;
  const form = document.getElementById("family-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      await call("createFamily", { name: String(new FormData(form).get("name")) });
      await route(user, true); // refresh token to pick up the new parent claim
    } catch (err) {
      document.getElementById("family-error").textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------- parent dashboard ----------

function showParent(familyId) {
  signOutButton();
  const state = { family: null, kids: [], requests: [] };
  const famRef = doc(db, "families", familyId);

  unsubs.push(onSnapshot(famRef, (s) => { state.family = s.data(); render(); }));
  unsubs.push(onSnapshot(collection(famRef, "kids"), (s) => {
    state.kids = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
    render();
  }));
  unsubs.push(onSnapshot(query(collection(famRef, "requests"), where("status", "==", "pending")), (s) => {
    state.requests = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    render();
  }));

  function render() {
    const f = state.family;
    if (!f) return;
    const active = state.kids.filter((k) => !k.archived);
    const archived = state.kids.filter((k) => k.archived);

    const requests = state.requests.length ? `
      <section aria-labelledby="req-title">
        <h2 id="req-title">Waiting for you (${state.requests.length})</h2>
        <ul class="requests">${state.requests.map((r) => `
          <li>
            <div><strong>${esc(r.kidName)}</strong> wants to ${r.kind === "deposit" ? "add" : "spend"}
              <strong>${money(r.amountCents)}</strong><br><span class="muted">${esc(r.memo)}</span></div>
            <div class="btn-row">
              <button type="button" data-action="approve" data-id="${esc(r.id)}">Approve</button>
              <button type="button" class="btn-quiet" data-action="deny" data-id="${esc(r.id)}">Deny</button>
            </div>
          </li>`).join("")}</ul>
      </section>` : "";

    const accounts = active.map((k) => `
      <article class="account">
        <div class="account-head">
          <h3>${esc(k.name)}</h3>
          <span class="account-balance">${money(k.balanceCents)}</span>
        </div>
        <p class="account-meta">${esc(allowanceText(k))}</p>
        ${goalHtml(k)}
        <div class="btn-row">
          <button type="button" data-action="deposit" data-kid="${esc(k.id)}">Add money</button>
          <button type="button" class="btn-quiet" data-action="withdrawal" data-kid="${esc(k.id)}">Take out</button>
          <button type="button" class="btn-quiet" data-action="history" data-kid="${esc(k.id)}">Passbook</button>
          <button type="button" class="btn-quiet" data-action="edit" data-kid="${esc(k.id)}">Edit</button>
        </div>
      </article>`).join("");

    $app.innerHTML = `
      <section>
        <h1>${esc(f.name)}</h1>
        <p>Family code <span class="family-code">${esc(f.code)}</span></p>
        <p class="muted">${esc(interestText(f) || "No interest set.")}</p>
        <div class="btn-row">
          <button type="button" class="btn-gold" data-action="add-kid">Add a saver</button>
          <button type="button" class="btn-quiet" data-action="settings">Interest &amp; settings</button>
        </div>
      </section>
      ${requests}
      <section aria-labelledby="acct-title">
        <h2 id="acct-title">Savers</h2>
        ${active.length ? `<div class="accounts">${accounts}</div>` : `<p class="muted">Add your first saver to open their passbook.</p>`}
        ${archived.length ? `<p class="muted" style="margin-top:1rem">Archived: ${archived.map((k) => `<button type="button" class="link" data-action="edit" data-kid="${esc(k.id)}">${esc(k.name)}</button>`).join(", ")}</p>` : ""}
      </section>`;
  }

  const kidById = (id) => state.kids.find((k) => k.id === id);

  const onClick = async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, kid: kidId, id } = btn.dataset;
    const kid = kidId ? kidById(kidId) : null;

    if (action === "approve" || action === "deny") {
      btn.disabled = true;
      try {
        await call("resolveRequest", { requestId: id, approve: action === "approve" });
        toast(action === "approve" ? "Approved" : "Denied");
      } catch (err) { toast(err.message); btn.disabled = false; }
      return;
    }
    if (action === "add-kid") return kidSheet(null);
    if (action === "edit") return kidSheet(kid);
    if (action === "settings") return settingsSheet(state.family);
    if (action === "deposit" || action === "withdrawal") return moneySheet(kid, action);
    if (action === "history") return historySheet(familyId, kid);
  };
  $app.addEventListener("click", onClick);
  unsubs.push(() => $app.removeEventListener("click", onClick));
}

function dayOptions(selected) {
  return DAYS.map((d, i) => `<option value="${i}" ${i === selected ? "selected" : ""}>${d}</option>`).join("");
}

function kidSheet(kid) {
  const isNew = !kid;
  openSheet({
    title: isNew ? "Add a saver" : `Edit ${kid.name}`,
    submitLabel: isNew ? "Add saver" : "Save changes",
    body: `
      <label>Name<input name="name" value="${esc(kid?.name)}" maxlength="30" required autofocus></label>
      <label>${isNew ? "PIN" : "New PIN"}<span class="hint">${isNew ? "4 to 6 digits they'll use to sign in" : "Leave blank to keep the current PIN"}</span>
        <input name="pin" class="pin-input" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" ${isNew ? "required" : ""}></label>
      <label>Weekly allowance<span class="hint">0 for none</span>
        <input name="allowance" inputmode="decimal" value="${centsToInput(kid?.allowanceCents)}"></label>
      <label>Paid every<select name="day">${dayOptions(kid?.allowanceDay ?? 0)}</select></label>
      ${isNew ? "" : `<label class="check"><input type="checkbox" name="archived" ${kid.archived ? "checked" : ""}> Archive (hide and stop allowance)</label>`}`,
    async onSubmit(fd) {
      const allowanceCents = parseDollars(fd.get("allowance") || "0");
      if (Number.isNaN(allowanceCents)) throw new Error("Enter the allowance like 5 or 5.50.");
      const data = {
        name: String(fd.get("name")),
        allowanceCents,
        allowanceDay: Number(fd.get("day")),
      };
      const pin = String(fd.get("pin") || "");
      if (pin) data.pin = pin;
      if (isNew) {
        await call("addKid", data);
        return `${data.name} added`;
      }
      await call("updateKid", { ...data, kidId: kid.id, archived: fd.get("archived") === "on" });
      return "Saved";
    },
  });
}

function moneySheet(kid, kind) {
  const deposit = kind === "deposit";
  openSheet({
    title: deposit ? `Add money for ${kid.name}` : `Take out for ${kid.name}`,
    submitLabel: deposit ? "Add money" : "Take out",
    body: `
      <p class="muted">Balance: ${money(kid.balanceCents)}</p>
      <label>Amount<input name="amount" inputmode="decimal" placeholder="0.00" required autofocus></label>
      <label>What for<input name="memo" maxlength="80" placeholder="${deposit ? "Birthday from Grandma" : "Lego set"}"></label>`,
    async onSubmit(fd) {
      const amountCents = parseDollars(fd.get("amount"));
      if (!(amountCents > 0)) throw new Error("Enter an amount like 10 or 10.50.");
      await call("postEntry", { kidId: kid.id, kind, amountCents, memo: String(fd.get("memo") || "") });
      return deposit ? `Added ${money(amountCents)}` : `Took out ${money(amountCents)}`;
    },
  });
}

function settingsSheet(f) {
  openSheet({
    title: "Interest & settings",
    submitLabel: "Save settings",
    body: `
      <label>Family name<input name="name" value="${esc(f.name)}" maxlength="40" required></label>
      <label>Interest rate (%)<span class="hint">Paid by you, per period. 0 turns interest off.</span>
        <input name="rate" inputmode="decimal" value="${esc(f.interestRatePct)}"></label>
      <label>Paid<select name="period">
        <option value="monthly" ${f.interestPeriod !== "weekly" ? "selected" : ""}>Monthly, on the 1st</option>
        <option value="weekly" ${f.interestPeriod === "weekly" ? "selected" : ""}>Weekly, on Sunday</option>
      </select></label>
      <label>Only pay interest on the first<span class="hint">Caps how much of each balance earns interest. 0 for no cap.</span>
        <input name="cap" inputmode="decimal" value="${centsToInput(f.interestCapCents)}"></label>
      <p class="muted">Allowance and interest pay out automatically each morning. To pay out today's now, use the button below. It never pays twice.</p>
      <p><button type="button" class="btn-quiet" id="run-now">Pay today's allowance &amp; interest now</button></p>`,
    onOpen(sheet) {
      sheet.querySelector("#run-now").addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          const r = await call("runPayoutsNow", {});
          toast(r.payouts ? `${r.payouts} payout${r.payouts > 1 ? "s" : ""} made` : "Nothing due today");
        } catch (err) { toast(err.message); }
        e.target.disabled = false;
      });
    },
    async onSubmit(fd) {
      const rate = Number(String(fd.get("rate")).replace("%", "").trim() || 0);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error("Enter a rate between 0 and 100.");
      const cap = parseDollars(fd.get("cap") || "0");
      if (Number.isNaN(cap)) throw new Error("Enter the cap like 100 or 100.00.");
      await call("updateSettings", {
        name: String(fd.get("name")),
        interestRatePct: rate,
        interestPeriod: String(fd.get("period")),
        interestCapCents: cap,
      });
      return "Settings saved";
    },
  });
}

function historySheet(familyId, kid) {
  openSheet({
    title: `${kid.name}'s passbook`,
    wide: true,
    body: `<p class="muted">Balance ${money(kid.balanceCents)}</p><div id="history-body"><p class="muted">Loading…</p></div>
      <div class="sheet-actions" style="margin-top:1rem"><button type="button" class="btn-quiet" id="goal-btn">${kid.goal ? "Change goal" : "Set a goal"}</button></div>`,
    onOpen(sheet) {
      sheet.querySelector("#goal-btn").addEventListener("click", () => goalSheet(kid, true));
      const q = query(collection(db, "families", familyId, "kids", kid.id, "transactions"), orderBy("createdAt", "desc"), limit(100));
      return onSnapshot(q, (s) => {
        const el = sheet.querySelector("#history-body");
        if (el) el.innerHTML = ledgerHtml(s.docs.map((d) => d.data()));
      });
    },
  });
}

function goalSheet(kid, asParent) {
  openSheet({
    title: kid.goal ? "Change goal" : "Set a goal",
    submitLabel: "Save goal",
    body: `
      <label>Saving for<input name="name" value="${esc(kid.goal?.name)}" maxlength="40" placeholder="A new bike" required autofocus></label>
      <label>Goal amount<input name="amount" inputmode="decimal" value="${kid.goal ? centsToInput(kid.goal.amountCents) : ""}" placeholder="120.00" required></label>
      ${kid.goal ? `<label class="check"><input type="checkbox" name="clear"> Remove this goal</label>` : ""}`,
    async onSubmit(fd) {
      const base = asParent ? { kidId: kid.id } : {};
      if (fd.get("clear") === "on") { await call("setGoal", { ...base, clear: true }); return "Goal removed"; }
      const amountCents = parseDollars(fd.get("amount"));
      if (!(amountCents > 0)) throw new Error("Enter a goal amount like 120.");
      await call("setGoal", { ...base, name: String(fd.get("name")), amountCents });
      return "Goal saved";
    },
  });
}

// ---------- kid view ----------

function showKid(familyId, kidId) {
  signOutButton();
  const state = { kid: null, family: null, requests: [], txs: [] };
  const famRef = doc(db, "families", familyId);
  const kidRef = doc(famRef, "kids", kidId);

  unsubs.push(onSnapshot(famRef, (s) => { state.family = s.data(); render(); }));
  unsubs.push(onSnapshot(kidRef, (s) => { state.kid = s.exists() ? { id: s.id, ...s.data() } : null; render(); }));
  unsubs.push(onSnapshot(
    query(collection(famRef, "requests"), where("kidId", "==", kidId), where("status", "==", "pending")),
    (s) => { state.requests = s.docs.map((d) => d.data()); render(); },
  ));
  unsubs.push(onSnapshot(
    query(collection(kidRef, "transactions"), orderBy("createdAt", "desc"), limit(50)),
    (s) => { state.txs = s.docs.map((d) => d.data()); render(); },
  ));

  function render() {
    const k = state.kid;
    if (!k) return;
    const interest = interestText(state.family);
    $app.innerHTML = `
      <section class="kid-hero">
        <h1>Hi, ${esc(k.name)}</h1>
        <p class="muted">You have saved</p>
        <p class="balance-big">${money(k.balanceCents)}</p>
        <p class="muted">${esc(allowanceText(k))}${interest ? `. You earn ${esc(interest)}.` : "."}</p>
        ${goalHtml(k)}
        <div class="btn-row">
          <button type="button" data-action="ask-deposit">Ask to add money</button>
          <button type="button" class="btn-quiet" data-action="ask-withdrawal">Ask to spend</button>
          <button type="button" class="btn-quiet" data-action="goal">${k.goal ? "Change goal" : "Set a goal"}</button>
        </div>
      </section>
      ${state.requests.length ? `
        <section aria-labelledby="pending-title">
          <h2 id="pending-title">Waiting for a parent</h2>
          <ul class="requests">${state.requests.map((r) => `
            <li><span>${r.kind === "deposit" ? "Add" : "Spend"} ${money(r.amountCents)}: ${esc(r.memo)}</span></li>`).join("")}</ul>
        </section>` : ""}
      <section aria-labelledby="book-title">
        <h2 id="book-title">My passbook</h2>
        ${ledgerHtml(state.txs)}
      </section>`;
  }

  const onClick = (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !state.kid) return;
    const a = btn.dataset.action;
    if (a === "goal") return goalSheet(state.kid, false);
    if (a === "ask-deposit" || a === "ask-withdrawal") {
      const kind = a === "ask-deposit" ? "deposit" : "withdrawal";
      openSheet({
        title: kind === "deposit" ? "Ask to add money" : "Ask to spend",
        submitLabel: "Send to parent",
        body: `
          <label>Amount<input name="amount" inputmode="decimal" placeholder="0.00" required autofocus></label>
          <label>What for<input name="memo" maxlength="80" placeholder="${kind === "deposit" ? "Mowed the lawn" : "New book"}" required></label>`,
        async onSubmit(fd) {
          const amountCents = parseDollars(fd.get("amount"));
          if (!(amountCents > 0)) throw new Error("Enter an amount like 5 or 5.50.");
          if (kind === "withdrawal" && amountCents > state.kid.balanceCents) throw new Error(`You have ${money(state.kid.balanceCents)} saved.`);
          await call("createRequest", { kind, amountCents, memo: String(fd.get("memo") || "") });
          return "Sent to a parent";
        },
      });
    }
  };
  $app.addEventListener("click", onClick);
  unsubs.push(() => $app.removeEventListener("click", onClick));
}
