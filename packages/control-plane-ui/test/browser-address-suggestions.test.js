import assert from "node:assert/strict";
import test from "node:test";
import {
  browserAddressSuggestions,
  normalizeDesktopBrowserUrl,
  sanitizeBrowserStartPageData,
} from "../src/apps/control-plane/instance-detail/browserAddressSuggestions.ts";

const pinned = [
  { id: "docs", name: "Project docs", url: "https://docs.example.com/" },
  { id: "status", name: "Status", url: "https://status.example.com/" },
];

const recent = [
  { title: "Documentation", url: "https://docs.example.com/", visitedAt: 30 },
  { title: "Example home", url: "https://example.com/", visitedAt: 20 },
  { title: "Older status", url: "https://status.example.com/history", visitedAt: 10 },
];

test("address suggestions prefer pinned prefix matches and deduplicate URLs", () => {
  const matches = browserAddressSuggestions(pinned, recent, "doc");
  assert.deepEqual(matches.map(({ kind, url }) => ({ kind, url })), [
    { kind: "pinned", url: "https://docs.example.com/" },
  ]);
});

test("address suggestions match titles, hosts, and scheme-free URLs", () => {
  assert.equal(browserAddressSuggestions(pinned, recent, "example home")[0]?.url, "https://example.com/");
  assert.equal(browserAddressSuggestions(pinned, recent, "status.example")[0]?.kind, "pinned");
  assert.equal(browserAddressSuggestions(pinned, recent, "HTTPS://DOCS.EXAMPLE.COM")[0]?.url, "https://docs.example.com/");
});

test("empty address suggestions list pinned sites before recent visits and respect the limit", () => {
  const matches = browserAddressSuggestions(pinned, recent, "", 3);
  assert.deepEqual(matches.map((item) => item.url), [
    "https://docs.example.com/",
    "https://status.example.com/",
    "https://example.com/",
  ]);
});

test("browser start page storage is sanitized before use", () => {
  const data = sanitizeBrowserStartPageData({
    pinned: [
      { id: "valid", name: " Valid ", url: "example.com", ignored: true },
      { id: "invalid", name: "Invalid", url: "file:///tmp/private" },
      null,
    ],
    recent: [
      { title: " Recent ", url: "https://recent.example/path", visitedAt: 42, ignored: true },
      { title: 12, url: "https://fallback.example" },
      { title: "Invalid", url: "not a url with spaces" },
    ],
    unknown: true,
  });
  assert.deepEqual(data.pinned, [{ id: "valid", name: "Valid", url: "http://example.com/" }]);
  assert.deepEqual(data.recent, [
    { title: "Recent", url: "https://recent.example/path", visitedAt: 42 },
    { title: "https://fallback.example/", url: "https://fallback.example/", visitedAt: 0 },
  ]);
});

test("desktop browser URL normalization preserves the established HTTP default", () => {
  assert.equal(normalizeDesktopBrowserUrl("example.com"), "http://example.com/");
  assert.throws(() => normalizeDesktopBrowserUrl("file:///tmp/private"));
});
