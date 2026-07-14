<template>
  <section class="panel">
    <h1>Desktop</h1>
    <div class="apps-layout">
      <ScrollArea class="catalog">
        <aside class="catalog-content">
        <div class="section-head">
          <h2>Apps</h2>
          <Button variant="outline" size="sm" @click="showCustomApps = true">Custom Apps</Button>
        </div>
        <Card v-for="app in catalog.data.value || []" :key="app.id">
          <CardContent class="catalog-item">
            <div class="catalog-head">
              <div>
                <div class="item-title">{{ app.name }}</div>
                <div class="item-meta">
                  <Badge variant="secondary">{{ app.kind }}</Badge>
                  <span v-if="app.command">{{ app.command }}</span>
                </div>
              </div>
              <div class="catalog-actions">
                <Button size="sm" @click="launch(app)">Launch</Button>
                <Button v-if="isCustomApp(app.id)" variant="outline" size="sm" @click="editCustomApp(app)">Edit</Button>
                <Button v-if="isCustomApp(app.id)" variant="outline" size="sm" @click="removeCustomApp(app.id)">Remove</Button>
              </div>
            </div>
            <div class="launch-form">
              <Input v-model="formFor(app.id).title" placeholder="title" />
              <Input v-model="formFor(app.id).cwd" placeholder="/workspace" />
              <div v-if="app.kind === 'gui'" class="display-fields">
                <Input v-model="formFor(app.id).width" inputmode="numeric" placeholder="width" />
                <Input v-model="formFor(app.id).height" inputmode="numeric" placeholder="height" />
                <Input v-model="formFor(app.id).depth" inputmode="numeric" placeholder="depth" />
              </div>
              <Textarea v-model="formFor(app.id).argsJson" class="launch-json" spellcheck="false" placeholder='args JSON, e.g. ["https://example.com"]' />
              <Textarea v-model="formFor(app.id).envJson" class="launch-json" spellcheck="false" placeholder='env JSON, e.g. {"LANG":"C.UTF-8"}' />
              <p v-if="launchErrors[app.id]" class="form-error">{{ launchErrors[app.id] }}</p>
            </div>
          </CardContent>
        </Card>

        <div class="section-head sessions-head">
          <h2>Sessions</h2>
          <div class="section-actions">
            <span>{{ visibleSessions.length }}</span>
            <Button v-if="restoredSessions.length" variant="outline" size="sm" @click="showRestoredSessions = !showRestoredSessions">
              {{ showRestoredSessions ? "Hide restored" : `Show restored (${restoredSessions.length})` }}
            </Button>
          </div>
        </div>
        <Card v-for="session in visibleSessions" :key="session.id" class="session-card">
          <CardHeader class="session-header">
            <div>
              <CardTitle>{{ session.title }}</CardTitle>
              <CardDescription>{{ session.appId }} · {{ shortDate(session.updatedAt) }}</CardDescription>
            </div>
            <div class="session-actions">
              <Badge :variant="session.status === 'running' ? 'default' : 'secondary'">{{ session.status }}</Badge>
              <Button variant="outline" size="sm" :disabled="!isLive(session)" @click="stop(session.id)">Stop</Button>
              <Button variant="outline" size="sm" @click="restart(session.id)">Restart</Button>
              <Button variant="outline" size="sm" :disabled="!canOpenRuntime(session)" @click="openRuntime(session)">Open</Button>
              <Button variant="outline" size="sm" @click="openLogs(session)">Logs</Button>
              <Button v-if="session.kind === 'gui' && isLive(session)" variant="outline" size="sm" as="a" :href="screenshotUrl(session)" target="_blank" rel="noreferrer">Screenshot</Button>
              <Button variant="outline" size="sm" @click="remove(session.id)">Delete</Button>
            </div>
          </CardHeader>
          <CardContent>
            <p v-if="session.error" class="session-error">{{ session.error.code }}: {{ session.error.message }}</p>
            <dl class="session-metadata">
              <div>
                <dt>Created</dt>
                <dd>{{ shortDate(session.createdAt) }}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{{ shortDate(session.updatedAt) }}</dd>
              </div>
              <div v-if="session.tty?.cwd || session.launch?.cwd">
                <dt>CWD</dt>
                <dd>{{ session.launch?.cwd || session.tty?.cwd }}</dd>
              </div>
              <div v-if="session.launch?.args?.length">
                <dt>Args</dt>
                <dd>{{ session.launch.args.join(" ") }}</dd>
              </div>
              <div v-if="session.launch?.env && Object.keys(session.launch.env).length">
                <dt>Env</dt>
                <dd>{{ envSummary(session.launch.env) }}</dd>
              </div>
              <div v-if="session.display">
                <dt>Display</dt>
                <dd>{{ session.display.display }} {{ session.display.width }}x{{ session.display.height }}x{{ session.display.depth }}</dd>
              </div>
              <div v-if="session.vnc">
                <dt>Ports</dt>
                <dd>{{ session.vnc.backend === "kasmvnc" ? "kasmvnc" : "vnc" }} {{ session.vnc.port }}<span v-if="session.vnc.websockifyPort"> · ws {{ session.vnc.websockifyPort }}</span><span v-if="session.automation"> · cdp {{ session.automation.port }}</span></dd>
              </div>
              <div v-if="session.automation">
                <dt>Automation</dt>
                <dd><AutomationStatus :session="session" /></dd>
              </div>
              <div v-if="session.process">
                <dt>Process</dt>
                <dd>{{ session.process.command }}<span v-if="session.process.pid"> · pid {{ session.process.pid }}</span><span v-if="session.process.exitCode !== undefined && session.process.exitCode !== null"> · exit {{ session.process.exitCode }}</span></dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        </aside>
      </ScrollArea>
      <section class="sessions">
        <h2>Workspace</h2>
        <div v-if="workspace.tabs.length" class="workspace-tabs">
          <ScrollArea class="workspace-tab-list-scroll">
            <div class="workspace-tab-list">
            <button
              v-for="tab in workspace.tabs"
              :key="tab.id"
              type="button"
              :class="{ active: workspace.activeTabId === tab.id }"
              @click="workspace.setActive(tab.id)"
            >
              <span>{{ tab.title }}</span>
              <span class="tab-kind">{{ tabKind(tab) }}</span>
              <span class="tab-close" title="Close tab" aria-label="Close tab" @click.stop="closeTab(tab)">
                <XIcon :size="13" :stroke-width="2.2" />
              </span>
            </button>
            </div>
          </ScrollArea>
          <div v-if="activeSession" class="desktop-tab-toolbar">
            <span>{{ activeSession.appId }} · {{ activeSession.status }}</span>
            <div>
              <div v-if="activeSession.kind === 'gui' && activeSession.status === 'running'" class="segmented-control">
                <ToggleGroup type="single" :model-value="vncResizeMode" aria-label="VNC resize mode" @update:model-value="(value) => value && setVncResizeMode(value as VncResizeMode)">
                  <ToggleGroupItem value="scale">Scale</ToggleGroupItem>
                  <ToggleGroupItem value="remote">Resize</ToggleGroupItem>
                </ToggleGroup>
                <Toggle :model-value="workspace.guiHidpi" aria-label="Toggle HiDPI" @update:model-value="setGuiHidpi">HiDPI</Toggle>
              </div>
            </div>
          </div>
          <div class="workspace-tab-panel">
            <template v-if="activeSession && activeTab">
              <TerminalSession v-if="activeTab.type === 'app-tty' && activeSession.status === 'running'" :session="activeSession" />
              <iframe v-else-if="activeTab.type === 'app-web' && activeSession.status === 'running' && activeSession.web" class="web-frame" :src="webUrl(activeSession)" :title="activeSession.title" allow="clipboard-read; clipboard-write; fullscreen" />
              <div v-else-if="activeTab.type === 'app-vnc' || activeTab.type === 'shared-vnc'" class="gui-session">
                <iframe
                  v-if="activeSession.vnc"
                  :key="`${activeSession.id}:${vncResizeMode}:${workspace.guiHidpi ? 'hidpi' : '1x'}`"
                  class="vnc-frame workspace-vnc-frame"
                  :src="noVncUrl(activeSession)"
                  :title="`${activeTab.title} VNC`"
                  allow="clipboard-read; clipboard-write; fullscreen"
                  @load="syncKasmVncResize($event, activeSession)"
                />
                <p v-else class="logs-empty">VNC is unavailable for this session.</p>
              </div>
              <SessionLogs v-else-if="activeTab.type === 'logs'" :session="activeSession" />
              <p v-else class="logs-empty">Runtime view is unavailable for this session state.</p>
            </template>
            <p v-else class="logs-empty">The selected workspace tab no longer has a running session.</p>
          </div>
        </div>
        <p v-else class="logs-empty">Open a running app to create a workspace tab.</p>
      </section>
    </div>
    <Dialog v-model:open="showCustomApps">
      <DialogContent class="modal-panel gap-0 p-0" style="width: min(1180px, calc(100vw - 48px)); max-width: calc(100vw - 48px)">
        <header class="modal-header">
          <div>
            <DialogTitle>Custom Apps</DialogTitle>
            <DialogDescription class="sr-only">Create and manage custom applications available in this controlled instance.</DialogDescription>
            <p v-if="customCatalog.data.value">{{ customCatalog.data.value.path }}</p>
          </div>
        </header>
        <ScrollArea class="modal-scroll">
          <div class="modal-scroll-content">
          <Card class="catalog-editor">
            <CardContent>
              <div class="custom-app-form">
                <Input v-model="customAppForm.id" placeholder="id" />
                <Input v-model="customAppForm.name" placeholder="name" />
                <Textarea v-model="customAppForm.description" class="launch-json" spellcheck="false" placeholder="description" />
                <Select v-model="customAppForm.kind">
                  <SelectTrigger class="native-select"><SelectValue placeholder="App kind" /></SelectTrigger>
                  <SelectContent><SelectItem value="tty">TTY</SelectItem><SelectItem value="gui">GUI</SelectItem></SelectContent>
                </Select>
                <Input v-model="customAppForm.command" placeholder="/usr/bin/app" />
                <Input v-model="customAppForm.args" placeholder='args, e.g. --new-window "https://example.com"' />
                <Input v-model="customAppForm.cwd" placeholder="/workspace" />
                <Textarea v-model="customAppForm.envJson" class="launch-json" spellcheck="false" placeholder='env JSON, e.g. {"LANG":"C.UTF-8"}' />
                <div v-if="customAppForm.kind === 'gui'" class="display-fields">
                  <Input v-model="customAppForm.width" inputmode="numeric" placeholder="width" />
                  <Input v-model="customAppForm.height" inputmode="numeric" placeholder="height" />
                  <Input v-model="customAppForm.depth" inputmode="numeric" placeholder="depth" />
                </div>
                <div class="catalog-actions">
                  <Button size="sm" @click="saveCustomAppForm">{{ editingCustomAppId ? "Update App" : "Add App" }}</Button>
                  <Button v-if="editingCustomAppId" variant="outline" size="sm" @click="cancelCustomAppEdit">Cancel</Button>
                </div>
              </div>
            </CardContent>
            <CardContent>
              <Textarea v-model="customCatalogText" class="catalog-json" spellcheck="false" />
              <p v-if="customCatalogLoadError" class="form-error">{{ customCatalogLoadError }}</p>
            </CardContent>
            <CardFooter class="editor-actions">
              <Button variant="outline" size="sm" @click="resetCustomCatalog">Reset</Button>
              <Button size="sm" @click="saveCustomCatalog">Save</Button>
            </CardFooter>
            <CardContent v-if="catalogError">
              <p class="form-error">{{ catalogError }}</p>
            </CardContent>
          </Card>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { X as XIcon } from "@lucide/vue";
import { computed, reactive, ref, watch, watchEffect } from "vue";
import {
  deleteAppSession,
  restartAppSession,
  saveCustomAppCatalog as patchCustomAppCatalog,
  startAppSession,
  stopAppSession,
  useAppCatalogQuery,
  useAppSessionsQuery,
  useCustomAppCatalogQuery,
} from "../../api/queries";
import { publicPathParam, publicUrl } from "../../api/base";
import type { AppCatalogItem, AppLaunchOptions, AppSession } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { Toggle } from "../../components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { useAuthStore } from "../../stores/auth";
import type { WorkspaceTab } from "../../stores/workspace";
import { sessionForWorkspaceTab, sharedDisplayIdsForSessions, useWorkspaceStore, workspaceTabForSession } from "../../stores/workspace";
import AutomationStatus from "./AutomationStatus.vue";
import SessionLogs from "./SessionLogs.vue";
import TerminalSession from "./TerminalSession.vue";

type LaunchForm = {
  title: string;
  cwd: string;
  argsJson: string;
  envJson: string;
  width: string;
  height: string;
  depth: string;
};

type CustomAppForm = {
  id: string;
  name: string;
  description: string;
  kind: "tty" | "gui";
  command: string;
  args: string;
  cwd: string;
  envJson: string;
  width: string;
  height: string;
  depth: string;
};

type VncResizeMode = "scale" | "remote";

const queryClient = useQueryClient();
const catalog = useAppCatalogQuery();
const customCatalog = useCustomAppCatalogQuery();
const sessions = useAppSessionsQuery();
const auth = useAuthStore();
const workspace = useWorkspaceStore();
const customCatalogText = ref("[]");
const catalogError = ref("");
const editingCustomAppId = ref("");
const showCustomApps = ref(false);
const showRestoredSessions = ref(false);
const vncResizeMode = ref<VncResizeMode>("scale");
const customAppForm = reactive<CustomAppForm>({
  id: "",
  name: "",
  description: "",
  kind: "tty",
  command: "",
  args: "",
  cwd: "",
  envJson: "{}",
  width: "",
  height: "",
  depth: "",
});
const launchForms = reactive<Record<string, LaunchForm>>({});
const launchErrors = reactive<Record<string, string>>({});
const activeTab = computed(() => workspace.tabs.find((tab) => tab.id === workspace.activeTabId));
const activeSession = computed(() => sessionForWorkspaceTab(activeTab.value, sessions.data.value || []));
const customAppIds = computed(() => new Set((customCatalog.data.value?.items || []).map((app) => app.id)));
const restoredSessions = computed(() => (sessions.data.value || []).filter(isRestoredWithoutProcess));
const visibleSessions = computed(() =>
  showRestoredSessions.value ? sessions.data.value || [] : (sessions.data.value || []).filter((session) => !isRestoredWithoutProcess(session)),
);
const customCatalogLoadError = computed(() => {
  const error = customCatalog.error.value;
  if (!error) {
    return "";
  }
  return `Custom app catalog is invalid: ${error instanceof Error ? error.message : String(error)}`;
});

watch(
  () => customCatalog.data.value?.items,
  (items) => {
    customCatalogText.value = JSON.stringify(items || [], null, 2);
  },
  { immediate: true },
);

watchEffect(() => {
  if (!sessions.data.value) {
    return;
  }
  const currentSessions = sessions.data.value || [];
  workspace.pruneSession(new Set(currentSessions.map((session) => session.id)), sharedDisplayIdsForSessions(currentSessions));
});

function formFor(appId: string) {
  launchForms[appId] ||= {
    title: "",
    cwd: "",
    argsJson: "[]",
    envJson: "{}",
    width: "",
    height: "",
    depth: "",
  };
  return launchForms[appId];
}

function parsedJson<T>(value: string, fallback: T, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function launchOptions(app: AppCatalogItem): AppLaunchOptions {
  const form = formFor(app.id);
  const options: AppLaunchOptions = {};
  const args = parsedJson<unknown>(form.argsJson, [], "Args");
  const env = parsedJson<unknown>(form.envJson, {}, "Env");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Args JSON must be an array of strings.");
  }
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((value) => typeof value !== "string")) {
    throw new Error("Env JSON must be an object with string values.");
  }
  if (form.title.trim()) {
    options.title = form.title.trim();
  }
  if (form.cwd.trim()) {
    options.cwd = form.cwd.trim();
  }
  if (args.length) {
    options.args = args;
  }
  if (Object.keys(env).length) {
    options.env = env as Record<string, string>;
  }
  const display = {
    width: numberFromInput(form.width),
    height: numberFromInput(form.height),
    depth: numberFromInput(form.depth),
  };
  const cleanDisplay = Object.fromEntries(Object.entries(display).filter(([, value]) => value !== undefined));
  if (app.kind === "gui" && Object.keys(cleanDisplay).length) {
    options.display = cleanDisplay;
  }
  return options;
}

function numberFromInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Display values must be positive integers.");
  }
  return parsed;
}

function noVncUrl(session: AppSession) {
  if (session.vnc?.backend === "kasmvnc") {
    const guiScale = workspace.guiHidpi ? currentGuiScaleNumber() : 1;
    const params = new URLSearchParams({
      path: publicPathParam(`/api/apps/sessions/${session.id}/web/websockify`),
      autoconnect: "1",
      resize: vncResizeMode.value,
      enable_hidpi: workspace.guiHidpi && guiScale > 1 ? "1" : "0",
      show_control_bar: "1",
    });
    const resolution = kasmVncResolution(session, guiScale);
    if (vncResizeMode.value === "scale" && resolution) {
      params.set("forced_resolution_x", String(resolution.width));
      params.set("forced_resolution_y", String(resolution.height));
    }
    if (auth.token) {
      params.set("token", auth.token);
    }
    return `${publicUrl(session.vnc.webPath)}?${params.toString()}`;
  }
  const token = auth.token ? `?token=${encodeURIComponent(auth.token)}` : "";
  const path = session.vnc?.webPath ? `${publicPathParam(session.vnc.webPath)}${token}` : "";
  const params = new URLSearchParams({
    path,
    autoconnect: "1",
    resize: vncResizeMode.value,
  });
  return publicUrl(`/api/novnc/vnc.html?${params.toString()}`);
}

function syncKasmVncResize(event: Event, session: AppSession) {
  if (session.vnc?.backend !== "kasmvnc") {
    return;
  }
  const frame = event.target;
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }
  frame.contentWindow?.postMessage({ action: "resize", value: vncResizeMode.value }, "*");
  const resolution = kasmVncResolution(session, workspace.guiHidpi ? currentGuiScaleNumber() : 1);
  if (vncResizeMode.value === "scale" && resolution) {
    frame.contentWindow?.postMessage({ action: "set_resolution", value_x: resolution.width, value_y: resolution.height }, "*");
  }
}

function kasmVncResolution(session: AppSession, guiScale: number) {
  if (!session.display) {
    return undefined;
  }
  const scale = guiScale > 1 ? guiScale : 1;
  return {
    width: Math.max(1, Math.round(session.display.width / scale)),
    height: Math.max(1, Math.round(session.display.height / scale)),
  };
}

function setVncResizeMode(mode: VncResizeMode) {
  vncResizeMode.value = mode;
}

function setGuiHidpi(enabled: boolean) {
  workspace.setGuiHidpi(enabled);
}

function screenshotUrl(session: AppSession) {
  const params = new URLSearchParams();
  if (auth.token) {
    params.set("token", auth.token);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return publicUrl(`/api/apps/sessions/${session.id}/screenshot${suffix}`);
}

function webUrl(session: AppSession) {
  const base = publicUrl(session.web?.webPath || "");
  if (!auth.token) {
    return base;
  }
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(auth.token)}`;
}

function tabKind(tab: WorkspaceTab) {
  if (tab.type === "logs") {
    return "logs";
  }
  if (tab.type === "shared-vnc") {
    return "shared";
  }
  if (tab.type === "app-vnc") {
    return "vnc";
  }
  if (tab.type === "app-web") {
    return "web";
  }
  return "tty";
}

function isLive(session: AppSession) {
  return session.status === "running";
}

function canOpenRuntime(session: AppSession) {
  return isLive(session) && (session.kind === "tty" || (session.kind === "web" && Boolean(session.web)) || (session.kind === "gui" && Boolean(session.vnc)));
}

function isRestoredWithoutProcess(session: AppSession) {
  return session.error?.code === "APP_SESSION_RESTORED_WITHOUT_PROCESS";
}

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function envSummary(env: Record<string, string>) {
  return Object.keys(env).sort().join(", ");
}

async function launch(app: AppCatalogItem) {
  launchErrors[app.id] = "";
  try {
    const session = await startAppSession(app.id, withGuiScale(app, launchOptions(app)));
    upsertSession(session);
    openRuntime(session);
    await queryClient.invalidateQueries({ queryKey: ["app-sessions"] });
    await queryClient.invalidateQueries({ queryKey: ["status"] });
  } catch (error) {
    launchErrors[app.id] = error instanceof Error ? error.message : String(error);
  }
}

function withGuiScale(app: AppCatalogItem, options: AppLaunchOptions): AppLaunchOptions {
  if (app.kind !== "gui") {
    return options;
  }
  const scale = workspace.guiHidpi ? currentGuiScaleNumber() : 1;
  const env = { ...(options.env || {}) };
  if (!env.TASK_HANDOFF_GUI_SCALE) {
    env.TASK_HANDOFF_GUI_SCALE = formatGuiScale(scale);
  }
  const display = scaledDisplay(options.display || app.display, scale);
  return { ...options, env, ...(display ? { display } : {}) };
}

function currentGuiScaleNumber() {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(3, Math.max(1, ratio));
}

function formatGuiScale(scale: number) {
  return scale.toFixed(2).replace(/\.?0+$/, "");
}

function scaledDisplay(display: AppLaunchOptions["display"] | AppCatalogItem["display"], scale: number) {
  if (!display?.width || !display.height) {
    return display;
  }
  return {
    ...display,
    width: Math.round(display.width * scale),
    height: Math.round(display.height * scale),
  };
}

async function stop(sessionId: string) {
  await stopAppSession(sessionId);
  await queryClient.invalidateQueries({ queryKey: ["app-sessions"] });
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function closeTab(tab: WorkspaceTab) {
  if (tab.type === "app-vnc" || tab.type === "app-web" || tab.type === "app-tty") {
    await stopAppSession(tab.sessionId);
    workspace.close(tab.id);
    await queryClient.invalidateQueries({ queryKey: ["app-sessions"] });
    await queryClient.invalidateQueries({ queryKey: ["status"] });
    return;
  }
  workspace.close(tab.id);
}

async function restart(sessionId: string) {
  const session = await restartAppSession(sessionId);
  upsertSession(session);
  openRuntime(session);
  await queryClient.invalidateQueries({ queryKey: ["app-sessions"] });
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function remove(sessionId: string) {
  await deleteAppSession(sessionId);
  const remainingSessions = (sessions.data.value || []).filter((session) => session.id !== sessionId);
  workspace.pruneSession(new Set(remainingSessions.map((session) => session.id)), sharedDisplayIdsForSessions(remainingSessions));
  await queryClient.invalidateQueries({ queryKey: ["app-sessions"] });
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

function openRuntime(session: AppSession) {
  if (!canOpenRuntime(session)) {
    openLogs(session);
    return;
  }
  workspace.open(workspaceTabForSession(session));
}

function upsertSession(session: AppSession) {
  queryClient.setQueryData<AppSession[]>(["app-sessions"], (current = []) => [
    session,
    ...current.filter((item) => item.id !== session.id),
  ]);
}

function openLogs(session: AppSession) {
  workspace.open({ type: "logs", id: `logs:${session.id}`, sessionId: session.id, title: `${session.title} logs` });
}

function resetCustomCatalog() {
  catalogError.value = "";
  customCatalogText.value = JSON.stringify(customCatalog.data.value?.items || [], null, 2);
}

function isCustomApp(appId: string) {
  return customAppIds.value.has(appId);
}

function shellSplit(value: string) {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((match) => match.replace(/^(['"])(.*)\1$/, "$2"));
}

function customCatalogItems() {
  const parsed = JSON.parse(customCatalogText.value || "[]");
  if (!Array.isArray(parsed)) {
    throw new Error("Custom Apps JSON must be an array.");
  }
  return parsed as AppCatalogItem[];
}

function resetCustomAppForm() {
  editingCustomAppId.value = "";
  customAppForm.id = "";
  customAppForm.name = "";
  customAppForm.description = "";
  customAppForm.kind = "tty";
  customAppForm.command = "";
  customAppForm.args = "";
  customAppForm.cwd = "";
  customAppForm.envJson = "{}";
  customAppForm.width = "";
  customAppForm.height = "";
  customAppForm.depth = "";
}

function fillCustomAppForm(app: AppCatalogItem) {
  editingCustomAppId.value = app.id;
  customAppForm.id = app.id;
  customAppForm.name = app.name;
  customAppForm.description = app.description || "";
  customAppForm.kind = app.kind === "gui" ? "gui" : "tty";
  customAppForm.command = app.command || "";
  customAppForm.args = (app.args || []).map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
  customAppForm.cwd = app.cwd || "";
  customAppForm.envJson = JSON.stringify(app.env || {}, null, 2);
  customAppForm.width = app.display?.width === undefined ? "" : String(app.display.width);
  customAppForm.height = app.display?.height === undefined ? "" : String(app.display.height);
  customAppForm.depth = app.display?.depth === undefined ? "" : String(app.display.depth);
}

function editCustomApp(app: AppCatalogItem) {
  catalogError.value = "";
  fillCustomAppForm(app);
}

function cancelCustomAppEdit() {
  catalogError.value = "";
  resetCustomAppForm();
}

function customAppFromForm(): AppCatalogItem {
  const id = customAppForm.id.trim();
  const name = customAppForm.name.trim();
  const command = customAppForm.command.trim();
  if (!id || !name || !command) {
    throw new Error("Custom app id, name, and command are required.");
  }
  const app: AppCatalogItem = {
    id,
    name,
    kind: customAppForm.kind,
    command,
  };
  if (customAppForm.description.trim()) {
    app.description = customAppForm.description.trim();
  }
  const args = shellSplit(customAppForm.args);
  if (args.length) {
    app.args = args;
  }
  if (customAppForm.cwd.trim()) {
    app.cwd = customAppForm.cwd.trim();
  }
  const env = parsedJson<unknown>(customAppForm.envJson, {}, "Custom app env");
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((value) => typeof value !== "string")) {
    throw new Error("Custom app env JSON must be an object with string values.");
  }
  if (Object.keys(env).length) {
    app.env = env as Record<string, string>;
  }
  if (customAppForm.kind === "gui") {
    const display = {
      width: numberFromInput(customAppForm.width),
      height: numberFromInput(customAppForm.height),
      depth: numberFromInput(customAppForm.depth),
    };
    const cleanDisplay = Object.fromEntries(Object.entries(display).filter(([, value]) => value !== undefined));
    if (Object.keys(cleanDisplay).length) {
      app.display = cleanDisplay;
    }
  }
  return app;
}

async function saveCustomAppForm() {
  catalogError.value = "";
  try {
    const items = customCatalogItems();
    const app = customAppFromForm();
    const editingId = editingCustomAppId.value;
    if (!editingId && items.some((item) => item.id === app.id)) {
      throw new Error("Custom app id already exists.");
    }
    if (editingId && app.id !== editingId && items.some((item) => item.id === app.id)) {
      throw new Error("Custom app id already exists.");
    }
    if (editingId && !items.some((item) => item.id === editingId)) {
      throw new Error("Custom app was not found.");
    }
    const next = editingId ? items.map((item) => (item.id === editingId ? app : item)) : [...items, app];
    await patchCustomAppCatalog(next);
    customCatalogText.value = JSON.stringify(next, null, 2);
    resetCustomAppForm();
    await queryClient.invalidateQueries({ queryKey: ["app-catalog"] });
    await queryClient.invalidateQueries({ queryKey: ["app-catalog-custom"] });
  } catch (error) {
    catalogError.value = error instanceof Error ? error.message : String(error);
  }
}

async function removeCustomApp(appId: string) {
  catalogError.value = "";
  try {
    const items = customCatalogItems();
    const next = items.filter((item) => item.id !== appId);
    if (next.length === items.length) {
      throw new Error("Custom app was not found.");
    }
    await patchCustomAppCatalog(next);
    customCatalogText.value = JSON.stringify(next, null, 2);
    if (editingCustomAppId.value === appId) {
      resetCustomAppForm();
    }
    await queryClient.invalidateQueries({ queryKey: ["app-catalog"] });
    await queryClient.invalidateQueries({ queryKey: ["app-catalog-custom"] });
  } catch (error) {
    catalogError.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveCustomCatalog() {
  catalogError.value = "";
  try {
    const parsed = customCatalogItems();
    await patchCustomAppCatalog(parsed);
    await queryClient.invalidateQueries({ queryKey: ["app-catalog"] });
    await queryClient.invalidateQueries({ queryKey: ["app-catalog-custom"] });
    catalogError.value = "";
  } catch (error) {
    catalogError.value = error instanceof Error ? error.message : String(error);
  }
}
</script>

<style src="../../styles/features/apps/apps-view.css"></style>
<style src="../../styles/features/apps/workspace-tabs.css"></style>
<style src="../../styles/features/apps/catalog.css"></style>
<style src="../../styles/features/apps/sessions.css"></style>
<style src="../../styles/features/apps/row.css"></style>
