import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appStyles = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const mobileTheme = fs.readFileSync(new URL("../../../apps/mobile/src/components/theme.ts", import.meta.url), "utf8");
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
const mobileDark = objectEntries(
  mobileTheme,
  /export const mobileDarkColors = \{(?<body>[\s\S]*?)\} as const;/,
  /(\w+):\s*'(#[0-9a-f]{6})'/gi,
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

function assertMobileColor(token, mobileToken) {
  const actual = darkRules.get(token);
  const expected = mobileDark.get(mobileToken);
  assert.ok(actual, `dark theme must declare --${token}`);
  assert.ok(expected, `mobile dark theme must declare ${mobileToken}`);
  const actualRgb = toRgb(actual, `--${token}`);
  const expectedRgb = toRgb(expected, mobileToken);
  const maxDelta = Math.max(...actualRgb.map((channel, index) => Math.abs(channel - expectedRgb[index])));
  assert.ok(maxDelta < 1 / 255, `--${token} (${actual}) must match mobileDarkColors.${mobileToken} (${expected})`);
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

test("control plane dark surfaces, text, and status colors follow the mobile dark palette", () => {
  const mappings = {
    background: "background",
    foreground: "text",
    card: "surface",
    primary: "primary",
    border: "border",
    "muted-foreground": "textMuted",
    destructive: "destructiveButton",
    ring: "primary",
    "workspace-bg": "background",
    surface: "surface",
    "surface-raised": "surfaceRaised",
    "surface-inset": "surfaceInset",
    "surface-hover": "surfaceHover",
    text: "text",
    "text-muted": "textMuted",
    line: "border",
    "line-strong": "workbenchCardBorder",
    "brand-accent": "primary",
    "brand-accent-soft": "primarySoft",
    "terminal-bg": "code",
    "terminal-text": "codeText",
    "status-success": "sessionActive",
    "status-success-bg": "sessionActiveSoft",
    "status-warning": "sessionWaiting",
    "status-warning-bg": "sessionWaitingSoft",
    "status-danger": "error",
    "status-danger-bg": "errorSoft",
  };

  for (const [token, mobileToken] of Object.entries(mappings)) {
    assertMobileColor(token, mobileToken);
  }
  assert.equal(darkRules.get("text-strong"), "var(--text)");
});

test("control plane dark theme no longer carries the legacy teal surface palette", () => {
  assert.doesNotMatch(
    [...darkRules].map(([token, value]) => `--${token}: ${value};`).join("\n"),
    /#31c6b6|#071013|#0b1519|#122127|#173038|#203942|#23434b|#24363d|#2b424a|rgb\(49 198 182/i,
  );
});

test("control plane dark text and status colors stay readable on every mobile surface", () => {
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
