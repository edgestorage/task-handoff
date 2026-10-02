import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const theme = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function themeBlock(selector) {
  const start = theme.search(selector);
  assert.notEqual(start, -1, `missing theme block ${selector}`);
  const end = theme.indexOf("\n  }", start);
  assert.notEqual(end, -1, `unterminated theme block ${selector}`);
  const declarations = new Map();
  for (const match of theme.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

function toRgb(value, label) {
  const hsl = value.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (hsl) {
    const [hue, saturation, lightness] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const sector = (hue / 60) % 6;
    const second = chroma * (1 - Math.abs((sector % 2) - 1));
    const [r, g, b] = sector < 1 ? [chroma, second, 0]
      : sector < 2 ? [second, chroma, 0]
      : sector < 3 ? [0, chroma, second]
      : sector < 4 ? [0, second, chroma]
      : sector < 5 ? [second, 0, chroma]
      : [chroma, 0, second];
    const offset = lightness - chroma / 2;
    return [r, g, b].map((channel) => channel + offset);
  }
  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) return [0, 2, 4].map((index) => Number.parseInt(hex[1].slice(index, index + 2), 16) / 255);
  assert.fail(`unsupported color ${label}: ${value}`);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

// Accent-colored foregrounds (app icons, kickers, launch buttons, job lines) sit on these surfaces,
// so the token must stay readable instead of only matching the dark-theme tint.
const surfaceTokens = ["surface", "surface-raised", "surface-inset", "surface-overlay"];

const themeBlocks = [
  ["light", /:root,\s*\[data-theme="light"\]\s*\{/],
  ["dark", /\.dark,\s*\[data-theme="dark"\]\s*\{/],
];

for (const [themeName, selector] of themeBlocks) {
  test(`${themeName} theme keeps the muted brand accent readable on every surface`, () => {
    const declarations = themeBlock(selector);
    const accent = declarations.get("brand-accent-muted");
    assert.ok(accent, `${themeName} theme must declare --brand-accent-muted`);
    for (const token of surfaceTokens) {
      const surface = declarations.get(token);
      assert.ok(surface, `${themeName} theme must declare --${token}`);
      const ratio = contrast(toRgb(accent, "--brand-accent-muted"), toRgb(surface, `--${token}`));
      assert.ok(
        ratio >= 4.5,
        `${themeName} theme --brand-accent-muted (${accent}) on --${token} (${surface}) is ${ratio.toFixed(2)}:1, expected at least 4.5:1`,
      );
    }
  });
}
