<template>
  <div class="terminal-panel">
    <div class="terminal-canvas-shell">
      <div ref="terminalEl" class="terminal-canvas" />
    </div>
    <div class="terminal-status">
      <span>{{ status }} · {{ session.tty?.mode || "pty" }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { publicWebSocketUrl } from "../../api/base";
import type { AppSession } from "../../api/types";
import { useAuthStore } from "../../stores/auth";

const props = defineProps<{ session: AppSession }>();
const auth = useAuthStore();
const terminalEl = ref<HTMLElement | null>(null);
const status = ref("connecting");
let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let socket: WebSocket | undefined;
let resizeObserver: ResizeObserver | undefined;
let refreshFrame: number | undefined;
let refreshTimer: number | undefined;
let restoringSnapshot = false;

const wsUrl = computed(() => {
  return publicWebSocketUrl(`/api/apps/sessions/${props.session.id}/tty`, auth.token);
});

function sendResize() {
  if (restoringSnapshot || !terminal || socket?.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
}

function fit() {
  if (restoringSnapshot) return;
  try {
    fitAddon?.fit();
    if (terminal && terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
    sendResize();
  } catch {
    // xterm can throw while the element is hidden during tab switches.
  }
}

function scheduleRefresh() {
  if (refreshFrame !== undefined) {
    window.cancelAnimationFrame(refreshFrame);
  }
  if (refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer);
  }
  const refresh = () => {
    refreshFrame = undefined;
    fit();
  };
  refreshFrame = window.requestAnimationFrame(refresh);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    fit();
  }, 80);
}

function terminalTheme() {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-surface").trim(),
    foreground: styles.getPropertyValue("--terminal-text").trim(),
    cursor: styles.getPropertyValue("--text").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}

function dispose() {
  if (refreshFrame !== undefined) {
    window.cancelAnimationFrame(refreshFrame);
    refreshFrame = undefined;
  }
  if (refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  socket?.close();
  socket = undefined;
  terminal?.dispose();
  terminal = undefined;
  fitAddon = undefined;
}

async function connect() {
  dispose();
  await nextTick();
  if (!terminalEl.value) {
    return;
  }

  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    theme: terminalTheme(),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(terminalEl.value);
  scheduleRefresh();

  socket = new WebSocket(wsUrl.value);
  socket.addEventListener("open", () => {
    status.value = "connected";
    scheduleRefresh();
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data || "{}"));
    if (message.type === "snapshot") {
      restoringSnapshot = true;
      if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0) {
        terminal?.resize(message.cols, message.rows);
      }
      terminal?.reset();
      terminal?.write(`${String(message.data || "")}${String(message.pendingEscape || "")}`, () => {
        restoringSnapshot = false;
        scheduleRefresh();
      });
    } else if (message.type === "output") {
      terminal?.write(String(message.data || ""));
    } else if (message.type === "connected") {
      status.value = "connected";
    } else if (message.type === "exit") {
      status.value = "exited";
      terminal?.writeln("\r\n[process exited]");
    } else if (message.type === "error") {
      status.value = "error";
      terminal?.writeln(`\r\n[error] ${message.message}`);
    }
  });
  socket.addEventListener("close", () => {
    status.value = status.value === "exited" ? "exited" : "disconnected";
  });
  socket.addEventListener("error", () => {
    status.value = "error";
  });
  terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  });
  resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(terminalEl.value);
  scheduleRefresh();
}

watch(() => props.session.id, connect, { immediate: true });

onBeforeUnmount(dispose);
</script>

<style src="../../styles/features/apps/terminal.css"></style>
