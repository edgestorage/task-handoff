import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enUS } from "../src/i18n/locales/en-US/index.ts";
import { zhCN } from "../src/i18n/locales/zh-CN/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
const browserSection = read("src/apps/control-plane/instance-settings/BrowserProfilesSection.vue");
const profilesSource = read("src/apps/control-plane/useBrowserProfiles.ts");
const launchMenu = read("src/apps/control-plane/shared/AppLaunchMenuItems.vue");
const sessionPreview = read("src/apps/control-plane/instance-detail/SessionPreview.vue");
const boardView = read("src/apps/control-plane/board/InstanceBoardView.vue");
const storySidebar = read("src/apps/control-plane/story/StoryResourceSidebar.vue");
const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
const sessionHook = read("src/apps/control-plane/instance-detail/useActiveInstanceSessions.ts");
const instanceSessions = read("src/apps/control-plane/useInstanceSessions.ts");

function localeValue(tree, keyPath) {
  return keyPath.split(".").reduce((value, part) => value?.[part], tree);
}

const copyKeys = [
  "instances.settings.browser",
  "instances.settings.browserGoToApps",
  "instances.settings.browserNotInstalled",
  "instances.settings.browserNeedsAttention",
  "instances.settings.codexNotInstalled",
  "instances.settings.browserProfilesTitle",
  "instances.settings.browserProfilesDescription",
  "instances.settings.browserProfilesLoading",
  "instances.settings.browserProfilesUnsupported",
  "instances.settings.browserProfilesFailed",
  "instances.settings.refreshBrowserProfiles",
  "instances.settings.browserProfileCreate",
  "instances.settings.browserProfileNamePlaceholder",
  "instances.settings.browserProfileDefault",
  "instances.settings.browserProfileDefaultName",
  "instances.settings.browserProfileRunning",
  "instances.settings.browserProfileDiskUsage",
  "instances.settings.browserProfileDiskUnknown",
  "instances.settings.browserProfileOpenSession",
  "instances.settings.browserProfileSetDefault",
  "instances.settings.browserProfileRename",
  "instances.settings.browserProfileDelete",
  "instances.settings.browserProfileDeleteTitle",
  "instances.settings.browserProfileDeleteDescription",
  "instances.settings.browserProfileCreated",
  "instances.settings.browserProfileRenamed",
  "instances.settings.browserProfileDefaultSet",
  "instances.settings.browserProfileDeleted",
  "sessions.tabs.embeddedBrowser",
  "sessions.tabs.profileDefault",
  "sessions.tabs.profileDefaultHint",
  "sessions.tabs.profileRunning",
  "sessions.tabs.profileDiskUsage",
  "sessions.tabs.profileDiskUnknown",
  "sessions.tabs.profileTemporary",
  "sessions.tabs.profileTemporaryDescription",
  "sessions.tabs.profileLoading",
  "sessions.tabs.profileLoadFailed",
];

test("profile support is gated by the capability the instance actually reports", () => {
  assert.match(profilesSource, /export function supportsBrowserProfiles\(instance: InstanceWithAppInventory \| undefined, appId = BROWSER_PROFILE_APP_ID\) \{/);
  assert.match(profilesSource, /return browserProfileApp\(instance, appId\)\?\.capabilities\.supportsProfiles === true;/);
  assert.match(profilesSource, /export function browserProfileApp\(instance: InstanceWithAppInventory \| undefined, appId = BROWSER_PROFILE_APP_ID\) \{/);
  assert.match(instanceSessions, /supportsProfiles: app\.capabilities\.supportsProfiles === true/);
});

test("the untouched default profile name renders in the active locale", () => {
  assert.match(profilesSource, /import \{ DEFAULT_APP_PROFILE_NAME, type AppProfile \} from "@task-handoff\/protocol\/app-profiles"/);
  assert.match(profilesSource, /export function usesDefaultProfileName\(profile: Pick<AppProfile, "name" \| "isDefault">\) \{/);
  assert.match(profilesSource, /return profile\.isDefault && profile\.name === DEFAULT_APP_PROFILE_NAME;/);
  assert.match(browserSection, /function profileLabel\(profile: AppProfile\)/);
  assert.match(browserSection, /usesDefaultProfileName\(profile\) \? t\("instances\.settings\.browserProfileDefaultName"\) : profile\.name/);
  assert.match(launchMenu, /usesDefaultProfileName\(profile\) \? t\("sessions\.tabs\.profileDefault"\) : profile\.name/);
  assert.match(launchMenu, /function defaultProfileLabel\(profile: AppProfile\)/);
  // The localized label already says "default", so the redundant badge is hidden.
  assert.match(browserSection, /<Badge v-if="profile\.isDefault && !usesDefaultProfileName\(profile\)"/);
  assert.match(launchMenu, /<Badge v-if="profile\.isDefault && !usesDefaultProfileName\(profile\)"/);
});

test("browser and Codex tabs stay visible and guide missing installs to Apps", () => {
  assert.match(dialog, /<TabsTrigger value="browser"><Globe2 :size="14" \/>\{\{ t\("instances\.settings\.browser"\) \}\}<\/TabsTrigger>/);
  assert.match(dialog, /<TabsTrigger value="codex"><AiAgentIcon agent="codex" :size="14" \/>/);
  assert.doesNotMatch(dialog, /<TabsTrigger v-if/);
  assert.match(dialog, /import BrowserProfilesSection from "\.\/BrowserProfilesSection\.vue"/);
  assert.match(dialog, /<BrowserProfilesSection[\s\S]*@open-apps="section = 'apps'"/);
  assert.match(dialog, /const codexInstalled = computed/);
  assert.match(dialog, /!codexInstalled"[\s\S]*t\("instances\.settings\.codexNotInstalled"\)/);
  assert.match(dialog, /@click="section = 'apps'">{{ t\("instances\.settings\.browserGoToApps"\) }}/);
  assert.match(dialog, /<div v-else class="instance-settings-control-surface instance-settings-surface">[\s\S]*codexSettingsSupported/);
  for (const section of ["browser", "codex"]) assert.match(dialog, new RegExp(`activeSection === "${section}"`));
});

test("browser tab covers install, capability, loading, and profile management states", () => {
  assert.match(browserSection, /"instances\.settings\.browserNotInstalled"/);
  assert.match(browserSection, /"instances\.settings\.browserNeedsAttention"/);
  assert.match(browserSection, /t\("instances\.settings\.browserProfilesLoading"\)/);
  assert.match(browserSection, /t\("instances\.settings\.browserProfilesUnsupported"\)/);
  assert.match(browserSection, /translateApiError\(error, t, t\("instances\.settings\.browserProfilesFailed"\)\)/);
  assert.match(browserSection, /emit\('open-apps'\)/);
  assert.match(browserSection, /const installed = computed/);
  assert.match(browserSection, /const supported = computed\(\(\) => supportsBrowserProfiles\(props\.instance, appId\.value\)\)/);
  assert.match(browserSection, /enabled: showList/);
  assert.match(browserSection, /await createProfileRequest\(name\)/);
  assert.match(browserSection, /await renameProfile\(profile\.id, name\)/);
  assert.match(browserSection, /await setDefaultProfile\(profile\.id\)/);
  assert.match(browserSection, /await removeProfile\(profile\.id\)/);
  assert.match(browserSection, /diskUsageBytes === undefined/);
  assert.match(browserSection, /t\("instances\.settings\.browserProfileDiskUsage", \{ size: formatBytes\(profile\.diskUsageBytes, locale\.value\) \}\)/);
  assert.match(browserSection, /profile\.runningSessionId"[\s\S]*emit\('open-session', profile\.runningSessionId\)/);
  assert.match(browserSection, /:disabled="profile\.isDefault \|\| Boolean\(profile\.runningSessionId\) \|\| busyProfileId === profile\.id"/);
  assert.match(browserSection, /<AlertDialog[\s\S]*browserProfileDeleteTitle[\s\S]*browserProfileDeleteDescription/);
  // Status and description copy never drops below the 12px body metric.
  assert.doesNotMatch(browserSection, /font-size: 1[01]px/);
});

test("profile CRUD consumes the shared authoritative query and invalidates it", () => {
  assert.match(profilesSource, /useInstanceAppProfilesQuery\(options\.instanceId, appId, enabled\)/);
  assert.match(profilesSource, /queryClient\.invalidateQueries\(\{ queryKey: controlPlaneQueryKeys\.instanceAppProfiles\(toValue\(options\.instanceId\), toValue\(appId\)\) \}\)/);
  for (const mutation of ["createInstanceAppProfile", "renameInstanceAppProfile", "setDefaultInstanceAppProfile", "removeInstanceAppProfile"]) {
    assert.match(profilesSource, new RegExp(mutation));
  }
  assert.match(profilesSource, /const runningProfiles = computed\(\(\) => profiles\.value\.filter\(\(profile\) => Boolean\(profile\.runningSessionId\)\)\)/);
});

test("launcher preselects the default profile and focuses running sessions", () => {
  assert.match(launchMenu, /<DropdownMenuSub v-if="app\.supportsProfiles">/);
  assert.match(launchMenu, /const orderedProfiles = computed\(\(\) => \[\.\.\.profiles\.value\]\.sort/);
  assert.match(launchMenu, /defaultProfileLabel\(defaultProfile\)/);
  assert.match(launchMenu, /t\("sessions\.tabs\.profileDefaultHint", \{ name: profile\.name \}\)/);
  assert.match(launchMenu, /if \(profile\.runningSessionId\) emit\("focusSession", profile\.runningSessionId\)/);
  assert.match(launchMenu, /else emit\("launch", appId, undefined, profile\.id\)/);
  assert.match(launchMenu, /@select="\$emit\('launch', app\.id\)"/);
  assert.match(launchMenu, /t\("sessions\.tabs\.profileTemporary"\)/);
  assert.match(launchMenu, /t\("sessions\.tabs\.profileTemporaryDescription"\)/);
  // The submenu subtitle reports the running session or disk usage, never the internal brp_ id.
  assert.match(launchMenu, /if \(profile\.runningSessionId\) return t\("sessions\.tabs\.profileRunning"\)/);
  assert.match(launchMenu, /profile\.diskUsageBytes === undefined/);
  assert.match(launchMenu, /t\("sessions\.tabs\.profileDiskUsage", \{ size: formatBytes\(profile\.diskUsageBytes, locale\.value\) \}\)/);
  assert.match(launchMenu, /t\("sessions\.tabs\.profileDiskUnknown"\)/);
  assert.doesNotMatch(launchMenu, /return profile\.runningSessionId \? t\("sessions\.tabs\.profileRunning"\) : profile\.id/);
  assert.match(launchMenu, /const profileApps = computed\(\(\) => props\.apps\.filter\(\(app\) => app\.supportsProfiles === true\)\)/);
});

test("every launcher surface focuses the running profile session instead of relaunching", () => {
  assert.match(sessionPreview, /@focus-session="\(sessionId\) => \$emit\('selectSession', sessionId\)"/);
  assert.match(boardView, /@focus-session="\(sessionId\) => \$emit\('selectBoardSession', instance\.id, sessionId\)"/);
  assert.match(storySidebar, /@focus-session="\(sessionId\) => \$emit\('focusAppSession', targetInstance\?\.id \|\| '', sessionId\)"/);
  assert.match(workbench, /@focus-app-session="\(instanceId, sessionId\) => storyResourceSidebar\.focusApp\(instanceId, sessionId\)"/);
  assert.match(workbench, /@open-app-session="focusAppSessionById"/);
  assert.match(workbench, /function focusAppSession\(instance: InstanceBoardItem, sessionId: string\)[\s\S]*boardSessionKeys\[instance\.id\] = sessionId/);
  assert.match(workbench, /closeFloatingLayers\(\);[\s\S]*void refresh\(\);/);
  assert.match(workbench, /focusAppSession,\n  notifyError: showToast,/);
  assert.match(sessionHook, /error\.code !== "BROWSER_PROFILE_BUSY"/);
  assert.match(sessionHook, /typeof error\.details\?\.sessionId === "string" \? error\.details\.sessionId : ""/);
  assert.match(sessionHook, /await focusAppSession\(instance, sessionId\)/);
});

test("the embedded browser is named separately from the Chromium Browser app", () => {
  assert.match(instanceSessions, /\[EMBEDDED_BROWSER_APP_ID\]: t\("sessions\.tabs\.embeddedBrowser"\)/);
  assert.match(sessionHook, /\{ id: EMBEDDED_BROWSER_APP_ID, label: t\("sessions\.tabs\.embeddedBrowser"\) \}/);
  assert.match(sessionHook, /title: t\("sessions\.tabs\.embeddedBrowser"\)/);
  assert.match(storySidebar, /resource\.kind === "embedded-browser" \? resource\.title \|\| t\("sessions\.tabs\.embeddedBrowser"\)/);
  assert.equal(localeValue(enUS, "sessions.tabs.embeddedBrowser"), "Embedded browser");
  assert.equal(localeValue(zhCN, "sessions.tabs.embeddedBrowser"), "内嵌浏览器");
});

test("browser profile copy exists in both locales", () => {
  for (const keyPath of copyKeys) {
    assert.equal(typeof localeValue(enUS, keyPath), "string", `en-US:${keyPath}`);
    assert.equal(typeof localeValue(zhCN, keyPath), "string", `zh-CN:${keyPath}`);
    assert.notEqual(localeValue(zhCN, keyPath), localeValue(enUS, keyPath), `zh-CN should localize ${keyPath}`);
  }
  assert.equal(localeValue(enUS, "instances.settings.browserProfilesUnsupported") !== "", true);
});
