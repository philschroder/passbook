// Kid page looks. Ids must match functions/lib/core.js (a unit test checks).
// Each theme pairs an accent with a text color that has at least 4.5:1 contrast on it,
// so buttons and the top bar stay readable whatever a kid picks.

export const THEMES = [
  { id: "forest", label: "Forest", accent: "#1F6B4A", on: "#FFFFFF" },
  { id: "ocean", label: "Ocean", accent: "#1D5FB8", on: "#FFFFFF" },
  { id: "grape", label: "Grape", accent: "#6D3FB0", on: "#FFFFFF" },
  { id: "bubblegum", label: "Bubblegum", accent: "#F48FB1", on: "#3A0A1E" },
  { id: "sunshine", label: "Sunshine", accent: "#FFD23F", on: "#3A2A00" },
  { id: "sunset", label: "Sunset", accent: "#C2410C", on: "#FFFFFF" },
  { id: "cherry", label: "Cherry", accent: "#C81E3A", on: "#FFFFFF" },
  { id: "mint", label: "Mint", accent: "#5EEAD4", on: "#053B35" },
  { id: "galaxy", label: "Galaxy", accent: "#2B2D6E", on: "#FFFFFF" },
  { id: "rainbow", label: "Rainbow", accent: "#7A3FBF", on: "#FFFFFF" },
];

export const PATTERNS = [
  { id: "plain", label: "Plain" },
  { id: "dots", label: "Dots" },
  { id: "stripes", label: "Stripes" },
  { id: "checks", label: "Checks" },
  { id: "confetti", label: "Confetti" },
  { id: "waves", label: "Waves" },
];

export const AVATARS = [
  "🦊", "🐼", "🐯", "🦁", "🐸", "🐵", "🐶", "🐱", "🐰", "🐨", "🐧", "🦄",
  "🐲", "🦖", "🐙", "🦋", "🐝", "🐢", "🦉", "🐬", "🚀", "⚽", "🎨", "🌟",
];

export const STICKERS = [
  "⭐", "🌈", "🚀", "🦄", "🍕", "🍦", "🎮", "⚽", "🏀", "🎨", "🎸", "🎧",
  "📚", "🌻", "🌸", "🍀", "🌙", "🔥", "💎", "🎉", "🎁", "🐾", "🐳", "🦕",
  "🍩", "🧁", "🍓", "🍉", "🏆", "👑", "💖", "🌊", "⛄", "🎈", "🛹", "🚲",
  "🤖", "👾", "🦖", "🐱",
];

export const MAX_STICKERS = 8;

export const DEFAULT_LOOK = { theme: "forest", pattern: "dots", avatar: "🌟", stickers: ["⭐", "🚀"] };

export const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

/** A saved look, filled in with defaults for anything missing. */
export function lookFor(kid) {
  const l = kid?.look || {};
  return {
    theme: THEMES.some((t) => t.id === l.theme) ? l.theme : DEFAULT_LOOK.theme,
    pattern: PATTERNS.some((p) => p.id === l.pattern) ? l.pattern : DEFAULT_LOOK.pattern,
    avatar: AVATARS.includes(l.avatar) ? l.avatar : DEFAULT_LOOK.avatar,
    stickers: Array.isArray(l.stickers) ? l.stickers.filter((s) => STICKERS.includes(s)).slice(0, MAX_STICKERS) : DEFAULT_LOOK.stickers,
  };
}
