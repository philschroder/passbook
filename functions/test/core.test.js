"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core");

test("localDateParts respects time zone", () => {
  // 2026-11-08 03:00 UTC is still Nov 7 (Saturday) in New York
  const p = core.localDateParts(new Date("2026-11-08T03:00:00Z"), "America/New_York");
  assert.deepEqual(p, { ymd: "2026-11-07", ym: "2026-11", day: 7, weekday: 6 });
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
