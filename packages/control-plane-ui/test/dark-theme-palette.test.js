import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appStyles = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const imageArtwork = fs.readFileSync(
  new URL("../src/apps/control-plane/shared/ImageArtwork.vue", import.meta.url),
  "utf8",
);

function objectEntries(source, declaration, entryPattern) {
  const body = source.match(declaration)?.groups?.body;
  assert.ok(body, `missing ${declaration}`);
  return new Map([...body.matchAll(entryPattern)].map((match) => [match[1], match[2]]));
}

const darkRules = objectEntries(
  appStyles,
  /:root\.dark,\s*:root\[data-theme="dark"\]\s*\{(?<body>[\s\S]*?)\n\}/,
  /--([\w-]+):\s*([^;]+);/g,
);

function toRgb(value, label) {
  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) return [0, 2, 4].map((index) => Number.parseInt(hex[1].slice(index, index + 2), 16) / 255);
  const hsl = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  assert.ok(hsl, `unsupported color ${label}: ${value}`);
  const hue = Number(hsl[1]);
  const saturation = Number(hsl[2]) / 100;
  const lightness = Number(hsl[3]) / 100;
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

test("control plane dark surfaces, text, status colors, and primary use the expected palette", () => {
  assert.equal(darkRules.get("background"), "225 8.7% 9%");
  assert.equal(darkRules.get("foreground"), "240 14.3% 95.9%");
  assert.equal(darkRules.get("card"), "230 9.1% 12.9%");
  assert.equal(darkRules.get("border"), "225 7% 22.4%");
  assert.equal(darkRules.get("muted-foreground"), "232.5 5.5% 71.4%");
  assert.equal(darkRules.get("primary"), "218.2 6.2% 34.7%");
  assert.equal(darkRules.get("ring"), "218.2 6.2% 34.7%");
  assert.equal(darkRules.get("workspace-bg"), "#151619");
  assert.equal(darkRules.get("surface"), "#1e1f24");
  assert.equal(darkRules.get("surface-raised"), "#1d1f23");
  assert.equal(darkRules.get("surface-inset"), "#191a1e");
  assert.equal(darkRules.get("surface-hover"), "#282a30");
  assert.equal(darkRules.get("surface-active"), "#2e3036");
  assert.equal(darkRules.get("sidebar-row-selected-bg"), "var(--surface-active)");
  assert.equal(darkRules.get("text"), "#f3f3f6");
  assert.equal(darkRules.get("text-muted"), "#b2b3ba");
  assert.equal(darkRules.get("line"), "#35373d");
  assert.equal(darkRules.get("line-strong"), "#3f4249");
  assert.equal(darkRules.get("brand-accent"), "#53575e");
  assert.equal(darkRules.get("brand-accent-soft"), "#26292e");
  assert.equal(darkRules.get("brand-accent-muted"), "#9ca2a9");
  assert.equal(darkRules.get("terminal-bg"), "#151619");
  assert.equal(darkRules.get("terminal-text"), "#f3f3f6");
  assert.equal(darkRules.get("status-success"), "#2dd4bf");
  assert.equal(darkRules.get("status-success-bg"), "#123b38");
  assert.equal(darkRules.get("status-warning"), "#f59e0b");
  assert.equal(darkRules.get("status-warning-bg"), "#3b2f05");
  assert.equal(darkRules.get("status-danger"), "#ff6961");
  assert.equal(darkRules.get("status-danger-bg"), "#3f1715");
  assert.equal(darkRules.get("text-strong"), "var(--text)");
});

test("control plane dark theme no longer carries the legacy teal surface palette", () => {
  assert.doesNotMatch(
    [...darkRules].map(([token, value]) => `--${token}: ${value};`).join("\n"),
    /#31c6b6|#071013|#0b1519|#122127|#173038|#203942|#23434b|#24363d|#2b424a|rgb\(49 198 182/i,
  );
});

test("control plane dark text and status colors stay readable on every dark surface", () => {
  const surfaces = ["surface", "surface-raised", "surface-inset", "surface-hover"];
  const foregrounds = [
    "text",
    "text-muted",
    "text-subtle",
    "brand-accent-muted",
    "status-success",
    "status-warning",
    "status-danger",
  ];

  for (const foreground of foregrounds) {
    for (const surface of surfaces) {
      const ratio = contrast(
        toRgb(darkRules.get(foreground), `--${foreground}`),
        toRgb(darkRules.get(surface), `--${surface}`),
      );
      assert.ok(
        ratio >= 4.5,
        `--${foreground} on --${surface} is ${ratio.toFixed(2)}:1, expected at least 4.5:1`,
      );
    }
  }
});

test("fallback image artwork follows the active theme accent instead of a fixed teal", () => {
  assert.match(imageArtwork, /--artwork-accent: var\(--brand-accent\);/);
  assert.doesNotMatch(imageArtwork, /#55d7c8|#172a30|#0b1519|#071014/);
});
