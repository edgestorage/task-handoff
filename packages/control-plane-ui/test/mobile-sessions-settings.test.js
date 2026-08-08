import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("settings exposes account-scoped mobile sessions and authoritative revocation", () => {
  const modal = read("src/apps/control-plane/settings/SettingsModal.vue");
  const section = read("src/apps/control-plane/settings/MobileSessionsSettingsSection.vue");
  const queries = read("src/api/queries.ts");

  assert.match(modal, /id: "mobile-sessions"/);
  assert.match(modal, /<MobileSessionsSettingsSection v-else-if="settingsSection === 'mobile-sessions'"/);
  assert.match(section, /useAuthSessionQuery\(\)/);
  assert.match(section, /useMobileSessionsQuery\(canLoadSessions\)/);
  assert.match(section, /<Dialog :open="Boolean\(pendingSession\)"/);
  assert.match(section, /await revokeMobileSession\(session\.id\)/);
  assert.match(section, /await sessions\.refetch\(\)/);
  assert.match(queries, /sharedControlPlaneClient\.auth\.mobileSessions\(signal\)/);
  assert.match(queries, /sharedControlPlaneClient\.auth\.revokeMobileSession\(sessionId\)/);
});
