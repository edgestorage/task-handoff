const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("every current TTY client restores authoritative snapshots before live output", () => {
  const clients = [
    "packages/control-plane-ui/src/apps/control-plane/useTerminalPreview.ts",
    "packages/control-plane-ui/src/apps/control-plane/app-access/AppAccessView.vue",
    "packages/control-plane-ui/src/apps/control-plane/board/useBoardTerminalPreviews.ts",
    "packages/controlled-instance-ui/src/features/apps/TerminalSession.vue",
  ];

  for (const client of clients) {
    const source = read(client);
    assert.match(source, /message\.type === "snapshot"/);
    assert.match(source, /terminal\??\.reset\(\)/);
    assert.match(source, /pendingEscape/);
    assert.match(source, /message\.type === "output"/);
    assert.ok(source.indexOf('message.type === "snapshot"') < source.indexOf('message.type === "output"'));
  }
});

test("mobile direct and relay TTY transports preserve snapshots", () => {
  const direct = read("apps/mobile/src/control-plane/direct-transport.ts");
  const relay = read("apps/mobile/src/control-plane/relay-transport.ts");
  const screen = read("apps/mobile/app/app-sessions/[instanceId]/[sessionId].tsx");
  const relayBridge = read("packages/control-plane/src/control-plane/http/server.ts");

  assert.match(direct, /type: z\.literal\('snapshot'\)/);
  assert.match(direct, /handlers\.onSnapshot\(message\.data, message\.pendingEscape\)/);
  assert.match(relayBridge, /type: "tty-snapshot", data: value\.data, pendingEscape: value\.pendingEscape/);
  assert.match(relay, /value\.type === 'tty-snapshot'/);
  assert.match(screen, /onSnapshot:[\s\S]*writeText\(`\\x1bc\$\{data\}\$\{pendingEscape\}`\)/);
});
