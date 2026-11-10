import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { THEMES, PATTERNS, AVATARS, STICKERS, MAX_STICKERS, lookFor, DEFAULT_LOOK } from "../public/looks.js";

const core = createRequire(import.meta.url)("../functions/lib/core.js");

test("client and server look lists match", () => {
  assert.deepEqual(THEMES.map((t) => t.id), core.LOOK_THEMES);
  assert.deepEqual(PATTERNS.map((p) => p.id), core.LOOK_PATTERNS);
  assert.deepEqual(AVATARS, core.LOOK_AVATARS);
  assert.deepEqual(STICKERS, core.LOOK_STICKERS);
  assert.equal(MAX_STICKERS, core.MAX_STICKERS);
});

test("every theme has CSS and readable button text", () => {
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  for (const t of THEMES) {
    assert.ok(css.includes(`[data-kid-theme="${t.id}"]`), `${t.id} has CSS`);
    assert.ok(css.includes(`--cover: ${t.accent}; --cover-ink: ${t.on};`), `${t.id} CSS matches looks.js`);
    const [a, b] = [lum(t.accent), lum(t.on)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(ratio >= 4.5, `${t.id} contrast ${ratio.toFixed(2)}`);
  }
  for (const p of PATTERNS.filter((p) => p.id !== "plain")) {
    assert.ok(css.includes(`[data-pattern-face="${p.id}"]`), `${p.id} pattern has CSS`);
  }
});

test("lookFor fills defaults and drops unknown values", () => {
  assert.deepEqual(lookFor({}), DEFAULT_LOOK);
  assert.deepEqual(lookFor({ look: { theme: "neon", pattern: "dots", avatar: "🦊", stickers: ["⭐", "nope"] } }),
    { theme: "forest", pattern: "dots", avatar: "🦊", stickers: ["⭐"] });
});
