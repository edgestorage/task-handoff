import assert from "node:assert/strict";
import test from "node:test";
import { auditSource } from "../scripts/i18n-audit.mjs";

test("i18n audit reports user-visible Vue template text and attributes", () => {
  const findings = auditSource(
    `<template>\n  <button aria-label="Open panel">Create instance</button>\n</template>`,
    "Fixture.vue",
  );
  assert.deepEqual(
    findings.map(({ line, kind, text }) => ({ line, kind, text })),
    [
      { line: 2, kind: "visible-attribute", text: "Open panel" },
      { line: 2, kind: "template-text", text: "Create instance" },
    ],
  );
});

test("i18n audit reports literals in Vue interpolation expressions", () => {
  const findings = auditSource(
    `<template>\n  <span>{{ ready ? "Ready now" : "Still waiting" }}</span>\n</template>`,
    "Fixture.vue",
  );
  assert.deepEqual(
    findings.map(({ line, kind, text }) => ({ line, kind, text })),
    [
      { line: 2, kind: "template-interpolation", text: "Ready now" },
      { line: 2, kind: "template-interpolation", text: "Still waiting" },
    ],
  );
});

test("i18n audit reports literal display fields, display calls, and TSX content", () => {
  const findings = auditSource(
    `const item = { label: "New session", value: "new-session" };\n` +
      `toast.error("Save failed");\n` +
      `const view = <button title="Close panel">Open</button>;`,
    "Fixture.tsx",
  );
  assert.deepEqual(
    findings.map(({ line, kind, text }) => ({ line, kind, text })),
    [
      { line: 1, kind: "display-field", text: "New session" },
      { line: 2, kind: "display-call", text: "Save failed" },
      { line: 3, kind: "visible-attribute", text: "Close panel" },
      { line: 3, kind: "jsx-text", text: "Open" },
    ],
  );
});

test("i18n audit ignores translated expressions and non-visible technical values", () => {
  const findings = auditSource(
    `<template>\n  <button :aria-label="t('common.actions.open')">{{ t("common.actions.create") }}</button>\n</template>\n<script setup lang="ts">\nconst item = { label: t("sessions.title"), value: "new-session" };\n</script>`,
    "Fixture.vue",
  );
  assert.deepEqual(findings, []);
});

test("i18n audit does not treat raw state message fields as presentation copy", () => {
  const findings = auditSource(
    `const event = { message: "connecting", status: "running" };\n` +
      `const tab = { label: appId, page: page === "changes-review" ? "changes-review" : "workspace" };`,
    "state.ts",
  );
  assert.deepEqual(findings, []);
});

test("i18n audit accepts one adjacent, categorized exception with a reason", () => {
  const findings = auditSource(
    `<template>\n  <!-- i18n-audit-allow-next-line product-name: official product spelling -->\n  <span>TaskHandoff</span>\n</template>`,
    "Fixture.vue",
  );
  assert.deepEqual(findings, []);
});

test("i18n audit rejects malformed, stale, and overly broad exceptions", () => {
  const malformed = auditSource(
    `// i18n-audit-allow-next-line anything: too broad\nconst item = { label: "TaskHandoff" };`,
    "malformed.ts",
  );
  assert.equal(malformed.some(({ kind }) => kind === "invalid-allow"), true);
  assert.equal(malformed.some(({ kind }) => kind === "display-field"), true);

  const stale = auditSource(
    `// i18n-audit-allow-next-line code-token: displayed CLI token\nconst value = "--help";`,
    "stale.ts",
  );
  assert.deepEqual(stale.map(({ kind }) => kind), ["stale-allow"]);

  const broad = auditSource(
    `<template>\n  <!-- i18n-audit-allow-next-line product-name: names -->\n  <span title="Codex">TaskHandoff</span>\n</template>`,
    "broad.vue",
  );
  assert.equal(broad.some(({ kind }) => kind === "broad-allow"), true);
  assert.equal(broad.filter(({ kind }) => kind !== "broad-allow").length, 2);
});

test("i18n audit scans index HTML title text", () => {
  const findings = auditSource(
    `<!doctype html><html><head><title>Control Plane</title></head><body><div id="app"></div></body></html>`,
    "index.html",
  );
  assert.deepEqual(findings.map(({ kind, text }) => ({ kind, text })), [
    { kind: "template-text", text: "Control Plane" },
  ]);
});
