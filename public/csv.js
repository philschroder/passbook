// Tiny CSV helpers for "Download as spreadsheet". No dependencies; opens in Excel, Numbers, Google Sheets.

/** Quotes a cell when needed and neutralizes spreadsheet formulas (=, +, -, @ at the start). */
export function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: array of arrays (first row = headers). Returns CSV text with CRLF line endings. */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Triggers a download of `text` as `filename` (with a BOM so Excel reads UTF-8 names correctly). */
export function downloadCsv(filename, text) {
  const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
