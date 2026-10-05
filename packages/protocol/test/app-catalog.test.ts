import assert from "node:assert/strict";
import test from "node:test";
import {
  AppCatalogItemSchema,
  CustomAppCatalogSchema,
  CustomAppCatalogUpdateInputSchema,
  projectInstanceAppCatalog,
} from "../src/app-catalog.ts";

test("the public catalog projection hides launch details and drops newer instance fields", () => {
  const projected = projectInstanceAppCatalog([
    {
      id: "codex",
      name: "Codex",
      kind: "tty",
      description: "OpenAI Codex CLI",
      command: "codex",
      args: ["-c", "check_for_update_on_startup=false"],
      env: { OPENAI_API_KEY: "secret" },
      futureField: { hint: "ignore me" },
    },
  ]);
  assert.deepEqual(projected, { items: [{ id: "codex", name: "Codex", kind: "tty", description: "OpenAI Codex CLI" }] });
  assert.equal("command" in projected.items[0], false);
  assert.equal("env" in projected.items[0], false);
});

test("custom catalog items reject shell metacharacters and unknown fields", () => {
  assert.throws(() => AppCatalogItemSchema.parse({ id: "evil", name: "Evil", kind: "tty", command: "bash -c whoami" }));
  assert.throws(() => AppCatalogItemSchema.parse({ id: "evil", name: "Evil", kind: "tty", command: "codex; rm -rf /" }));
  assert.throws(() => AppCatalogItemSchema.parse({ id: "evil", name: "Evil", kind: "tty", command: "codex", surprise: true }));
  const parsed = AppCatalogItemSchema.parse({
    id: "notepad",
    name: "Notepad",
    kind: "gui",
    command: "notepad",
    env: { DISPLAY_WIDTH: "1280" },
    display: { width: 1280, height: 800, depth: 24 },
  });
  assert.equal(parsed.command, "notepad");
});

test("custom catalog update inputs stay strictly items-only", () => {
  const input = CustomAppCatalogUpdateInputSchema.parse({ items: [{ id: "calc", name: "Calculator", kind: "gui", command: "calc" }] });
  assert.equal(input.items.length, 1);
  assert.throws(() => CustomAppCatalogUpdateInputSchema.parse({ items: [], path: "/tmp/custom.json" }));
  assert.throws(() => CustomAppCatalogUpdateInputSchema.parse({}));
});

test("custom catalog schema versions are strict on the wire model", () => {
  assert.equal(CustomAppCatalogSchema.parse({ schemaVersion: 1, items: [] }).schemaVersion, 1);
  assert.throws(() => CustomAppCatalogSchema.parse({ schemaVersion: 2, items: [] }));
});
