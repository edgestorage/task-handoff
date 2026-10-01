import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("cli authorization route reuses the login gate and keeps the authorization path", () => {
  const app = read("src/App.vue");
  const view = read("src/apps/control-plane/cli-authorize/CliAuthorizeView.vue");

  assert.match(app, /const isCliAuthorizeRoute = computed\(\(\) => window\.location\.pathname === "\/cli\/authorize"\)/);
  assert.match(app, /<AuthGate v-else-if="isCliAuthorizeRoute">\s*<CliAuthorizeView \/>\s*<\/AuthGate>/);
  assert.match(view, /useCliAuthorizationRequestQuery\(requestId\)/);
  assert.match(view, /useCliAuthorizationRequestByUserCodeQuery\(userCode\)/);
  assert.match(view, /params\.get\("user_code"\)/);
  assert.match(view, /await approveCliAuthorization\(request\.value\.requestId\)/);
  assert.match(view, /window\.location\.replace\(result\.redirectUri\)/);
  assert.match(view, /await denyCliAuthorization\(request\.value\.requestId\)/);
  assert.doesNotMatch(view, /type="password"|v-model="password"/);
});

test("cli authorization copy exists in both locales", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const copy = read(`src/i18n/locales/${locale}/cliAuthorize.ts`);
    for (const key of ["kicker", "title", "description", "client", "platform", "requestedAt", "expiresAt", "approve", "deny", "approvedBrowser", "approvedDevice", "deniedTitle", "manualTitle", "userCodePlaceholder"]) {
      assert.match(copy, new RegExp(`\\b${key}:`), `${locale} is missing cliAuthorize.${key}`);
    }
    for (const platform of ["darwin", "linux", "win32"]) {
      assert.match(copy, new RegExp(`\\b${platform}:`), `${locale} is missing cliAuthorize.platforms.${platform}`);
    }
    assert.match(read(`src/i18n/locales/${locale}/index.ts`), /cliAuthorize/);
  }
});

test("cli authorization endpoints flow through the shared control plane client", () => {
  const queries = read("src/api/queries.ts");
  const keys = read("src/api/queryKeys.ts");

  assert.match(queries, /sharedControlPlaneClient\.auth\.cliAuthorizationRequest\(/);
  assert.match(queries, /sharedControlPlaneClient\.auth\.cliAuthorizationRequestByUserCode\(/);
  assert.match(queries, /sharedControlPlaneClient\.auth\.approveCliAuthorization\(requestId\)/);
  assert.match(queries, /sharedControlPlaneClient\.auth\.denyCliAuthorization\(requestId\)/);
  assert.match(queries, /sharedControlPlaneClient\.auth\.cliSessions\(signal\)/);
  assert.match(queries, /sharedControlPlaneClient\.auth\.revokeCliSession\(sessionId\)/);
  assert.match(keys, /cliSessions/);
});
