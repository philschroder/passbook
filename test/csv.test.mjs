import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, toCsv } from "../public/csv.js";

test("csvCell quotes and escapes", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(5), "5");
});

test("csvCell neutralizes spreadsheet formulas but keeps negative numbers", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("-5.00"), "-5.00");
  assert.equal(csvCell("-cmd"), "'-cmd");
});

test("toCsv joins rows with CRLF", () => {
  assert.equal(toCsv([["Date", "Amount"], ["2026-11-09", "5.00"]]), "Date,Amount\r\n2026-11-09,5.00\r\n");
});
