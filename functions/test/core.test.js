"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core");

test("localDateParts respects time zone", () => {
  // 2026-11-08 03:00 UTC is still Nov 7 (Saturday) in New York
  const p = core.localDateParts(new Date("2026-11-08T03:00:00Z"), "America/New_York");
  assert.deepEqual(p, { ymd: "2026-11-07", ym: "2026-11", day: 7, weekday: 6, hour: 22 });
  const q = core.localDateParts(new Date("2026-11-08T12:00:00Z"), "America/New_York");
  assert.equal(q.weekday, 0);
});

test("interestPeriodKey", () => {
  assert.equal(core.interestPeriodKey("monthly", { day: 1, ym: "2026-12", weekday: 2, ymd: "2026-12-01" }), "M:2026-12");
  assert.equal(core.interestPeriodKey("monthly", { day: 2, ym: "2026-12", weekday: 3, ymd: "2026-12-02" }), null);
  assert.equal(core.interestPeriodKey("weekly", { day: 8, ym: "2026-11", weekday: 0, ymd: "2026-11-08" }), "W:2026-11-08");
  assert.equal(core.interestPeriodKey("weekly", { day: 9, ym: "2026-11", weekday: 1, ymd: "2026-11-09" }), null);
});

test("computeInterest floors and caps", () => {
  assert.equal(core.computeInterest(1000, 5), 50);
  assert.equal(core.computeInterest(333, 5), 16);
  assert.equal(core.computeInterest(100000, 5, 20000), 1000);
  assert.equal(core.computeInterest(0, 5), 0);
  assert.equal(core.computeInterest(-500, 5), 0);
  assert.equal(core.computeInterest(1000, 0), 0);
});

test("isAllowanceDue is idempotent per day", () => {
  const parts = { ymd: "2026-11-08", weekday: 0 };
  const kid = { allowanceCents: 500, allowanceDay: 0, lastAllowanceDate: null, archived: false };
  assert.equal(core.isAllowanceDue(kid, parts), true);
  assert.equal(core.isAllowanceDue({ ...kid, lastAllowanceDate: "2026-11-08" }, parts), false);
  assert.equal(core.isAllowanceDue({ ...kid, allowanceDay: 1 }, parts), false);
  assert.equal(core.isAllowanceDue({ ...kid, allowanceCents: 0 }, parts), false);
  assert.equal(core.isAllowanceDue({ ...kid, archived: true }, parts), false);
});

test("validators", () => {
  assert.equal(core.checkCents(525), 525);
  assert.throws(() => core.checkCents(5.25));
  assert.throws(() => core.checkCents(0));
  assert.equal(core.checkCents(0, { allowZero: true }), 0);
  assert.equal(core.checkPin("0420"), "0420");
  assert.throws(() => core.checkPin("12"));
  assert.throws(() => core.checkPin(1234));
  assert.equal(core.checkRate(2.555), 2.56);
  assert.throws(() => core.checkRate(101));
  assert.throws(() => core.checkWeekday(7));
});

test("localDateParts includes the local hour", () => {
  assert.equal(core.localDateParts(new Date("2026-11-09T11:30:00Z"), "America/New_York").hour, 6);
  assert.equal(core.localDateParts(new Date("2026-11-09T04:59:00Z"), "America/New_York").hour, 23);
  assert.equal(core.localDateParts(new Date("2026-11-09T05:00:00Z"), "America/New_York").hour, 0);
});

test("isValidTimeZone", () => {
  assert.equal(core.isValidTimeZone("America/Chicago"), true);
  assert.equal(core.isValidTimeZone("Asia/Kolkata"), true);
  assert.equal(core.isValidTimeZone("Mars/Olympus"), false);
  assert.equal(core.isValidTimeZone(""), false);
  assert.equal(core.isValidTimeZone(42), false);
});

test("checkChores cleans, keeps ids, and validates", () => {
  const out = core.checkChores([
    { id: "abc123", name: "  Feed   the dog ", amountCents: 100 },
    { name: "Dishes", amountCents: 250 },
  ]);
  assert.equal(out[0].id, "abc123");
  assert.equal(out[0].name, "Feed the dog");
  assert.match(out[1].id, /^[a-z0-9]{1,12}$/);
  assert.notEqual(out[1].id, out[0].id);
  const dup = core.checkChores([{ id: "x", name: "A", amountCents: 1 }, { id: "x", name: "B", amountCents: 1 }]);
  assert.notEqual(dup[0].id, dup[1].id);
  assert.deepEqual(core.checkChores([]), []);
  assert.throws(() => core.checkChores([{ name: "", amountCents: 100 }]), /name/);
  assert.throws(() => core.checkChores([{ name: "Dishes", amountCents: 0 }]));
  assert.throws(() => core.checkChores("nope"));
  assert.throws(() => core.checkChores(Array.from({ length: 21 }, () => ({ name: "x", amountCents: 1 }))), /20/);
});

test("checkWebhookUrl", () => {
  assert.equal(core.checkWebhookUrl(""), "");
  assert.equal(core.checkWebhookUrl(undefined), "");
  assert.equal(core.checkWebhookUrl(" https://hooks.zapier.com/hooks/catch/1/abc/ "), "https://hooks.zapier.com/hooks/catch/1/abc/");
  assert.throws(() => core.checkWebhookUrl("http://hooks.zapier.com/x"), /https/);
  assert.throws(() => core.checkWebhookUrl("not a url"), /web address/);
  assert.throws(() => core.checkWebhookUrl("https://u:p@example.com/"), /password/);
  assert.throws(() => core.checkWebhookUrl("http://127.0.0.1:9/x"), /https/);
  assert.equal(core.checkWebhookUrl("http://127.0.0.1:9/x", { allowLocalHttp: true }), "http://127.0.0.1:9/x");
  assert.throws(() => core.checkWebhookUrl("http://10.0.0.1/x", { allowLocalHttp: true }), /https/);
});
