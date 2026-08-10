<template>
  <main class="app-access-view">
    <header class="app-access-header">
      <div>
        <span>{{ accessModeLabel }}</span>
        <strong>{{ title }}</strong>
      </div>
      <small>{{ statusText }}</small>
    </header>

    <section class="app-access-surface">
      <div v-if="loading" class="app-access-state">{{ t("common.appAccess.loading") }}</div>
      <div v-else-if="error" class="app-access-state">{{ error }}</div>
      <div v-else-if="mode === 'tty'" ref="terminalHost" class="app-access-terminal" />
      <iframe
        v-else-if="vncFrameUrl"
        class="app-access-frame"
        :src="vncFrameUrl"
        :title="t('common.appAccess.vncSession')"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      <div v-else class="app-access-state">{{ t("common.appAccess.noDirectView") }}</div>
    </section>
  </main>
</template>

<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { formatTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { getApiData } from "../../../api/client";
import type { AppSession } from "../../../api/types";
import "./app-access.css";
import { translateApiError } from "../../../i18n/apiError";

type AppAccessSession = {
  mode: "tty" | "vnc" | "web";
  instance: {
    id: string;
    name: string;
    projectName?: string;
  };
  session: AppSession;
  expiresAt: string;
  ttySocketPath?: string;
  vncFramePath?: string;
};

const loading = ref(true);
const error = ref("");
const access = ref<AppAccessSession | undefined>();
const terminalHost = ref<HTMLElement | null>(null);
let cleanupTerminal: (() => void) | undefined;
const { locale, t } = useI18n();

const mode = computed(() => (window.location.pathname.includes("/vnc") ? "vnc" : window.location.pathname.includes("/web") ? "web" : "tty"));
const token = computed(() => new URLSearchParams(window.location.search).get("token") || "");
const title = computed(() => {
  const session = access.value?.session;
  const instance = access.value?.instance;
  return [instance?.name, session?.title || session?.appId || session?.id].filter(Boolean).join(" / ") || t("common.appAccess.appSession");
});
const accessModeLabel = computed(() => (mode.value === "vnc" ? "VNC" : mode.value === "web" ? "Web" : "TTY"));
const statusText = computed(() => {
  if (loading.value) return t("common.appAccess.connecting");
  if (error.value) return t("common.appAccess.unavailable");
  const expiresAt = access.value?.expiresAt ? formatTime(access.value.expiresAt, locale.value as SupportedLocale) : "";
  return expiresAt ? t("common.appAccess.linkExpires", { time: expiresAt }) : t("common.appAccess.connected");
});
const vncFrameUrl = computed(() => access.value?.vncFramePath || "");

function websocketUrl(path: string) {
  const url = new URL(path, window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function terminalTheme() {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim() || "#050505",
    foreground: styles.getPropertyValue("--terminal-text").trim() || "#e8e8e8",
    cursor: styles.getPropertyValue("--status-success").trim() || "#24d7c8",
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim() || "#31464f",
  };
}

async function mountTerminal() {
  await nextTick();
  const host = terminalHost.value;
  const socketPath = access.value?.ttySocketPath;
  if (!host || !socketPath) {
    return;
  }
  cleanupTerminal?.();
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: 14,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  const socket = new WebSocket(websocketUrl(socketPath));
  let restoringSnapshot = false;
  const resize = () => {
    if (restoringSnapshot) return;
    fit.fit();
    const dimensions = fit.proposeDimensions();
    if (dimensions && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", cols: dimensions.cols, rows: dimensions.rows }));
    }
  };
  terminal.loadAddon(fit);
  terminal.open(host);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", resize);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      terminal.write(new Uint8Array(event.data));
      return;
    }
    try {
      const message = JSON.parse(event.data) as { type?: string; data?: unknown; message?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown };
      if (message.type === "snapshot" && typeof message.data === "string") {
        restoringSnapshot = true;
        if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && Number(message.cols) > 0 && Number(message.rows) > 0) {
          terminal.resize(Number(message.cols), Number(message.rows));
        }
        terminal.reset();
        const pendingEscape = typeof message.pendingEscape === "string" ? message.pendingEscape : "";
        terminal.write(`${message.data}${pendingEscape}`, () => {
          restoringSnapshot = false;
          resize();
        });
      } else if (message.type === "output" && typeof message.data === "string") {
        terminal.write(message.data);
      } else if (message.type === "error") {
        terminal.writeln(String(message.message || "TTY session error."));
      }
    } catch {
      terminal.write(event.data);
    }
  });
  socket.addEventListener("close", () => terminal.writeln("\r\n[connection closed]"));
  terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  });
  window.addEventListener("resize", resize);
  window.setTimeout(resize, 50);
  cleanupTerminal = () => {
    window.removeEventListener("resize", resize);
    socket.close();
    terminal.dispose();
  };
}

onMounted(async () => {
  try {
    access.value = await getApiData<AppAccessSession>(`app-access/session?mode=${encodeURIComponent(mode.value)}&token=${encodeURIComponent(token.value)}`);
    loading.value = false;
    if (mode.value === "tty") {
      await mountTerminal();
    }
  } catch (err) {
    loading.value = false;
    error.value = translateApiError(err, t, t("common.appAccess.unavailable"));
  }
});

onBeforeUnmount(() => {
  cleanupTerminal?.();
});
</script>
