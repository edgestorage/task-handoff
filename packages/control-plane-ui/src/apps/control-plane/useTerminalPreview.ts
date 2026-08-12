import { nextTick, type Ref } from "vue";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import { TTY_STREAM_PROTOCOL_VERSION } from "@task-handoff/protocol/app-sessions";
import { BoundedInactiveLruCache } from "./terminalPreviewCache";
import { canPublishTerminalResize } from "./terminalResizeOwnership.ts";

export const MAX_CACHED_TERMINAL_PREVIEWS = 5;

let terminalModules: Promise<{
  Terminal: typeof import("@xterm/xterm")["Terminal"];
  FitAddon: typeof import("@xterm/addon-fit")["FitAddon"];
}> | undefined;
let terminalPreviewUseSequence = 0;
let terminalPreviewParkingElement: HTMLElement | undefined;

function loadTerminalModules() {
  return terminalModules ||= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
    .then(([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }));
}

function terminalTheme() {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-text").trim(),
    cursor: styles.getPropertyValue("--status-success").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}

function terminalPreviewCacheId(scope: string, key: string) {
  return `${scope}\n${key}`;
}

function terminalPreviewParkingRoot() {
  if (terminalPreviewParkingElement?.isConnected) return terminalPreviewParkingElement;
  const element = document.createElement("div");
  element.dataset.terminalPreviewParking = "";
  Object.assign(element.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(element);
  terminalPreviewParkingElement = element;
  return element;
}

class CachedTerminalPreview {
  readonly cacheId: string;
  readonly scope: string;
  readonly key: string;
  readonly socketUrl: string;
  lastUsed = ++terminalPreviewUseSequence;
  active = false;

  private terminal?: XTermTerminal;
  private fit?: FitAddon;
  private container?: HTMLElement;
  private host?: HTMLElement;
  private socket?: WebSocket;
  private resizeObserver?: ResizeObserver;
  private refreshFrame?: number;
  private resizeGeneration = 0;
  private repaintRequested = false;
  private initialResizeRequested = false;
  private restoringSnapshot = false;
  private applyingRemoteResize = false;
  private lastSentDimensions?: { cols: number; rows: number };
  private disposed = false;
  private initialization?: Promise<void>;

  constructor(scope: string, key: string, socketUrl: string) {
    this.scope = scope;
    this.key = key;
    this.socketUrl = socketUrl;
    this.cacheId = terminalPreviewCacheId(scope, key);
    window.addEventListener("focus", this.handleWindowFocus);
    window.addEventListener("blur", this.handleWindowBlur);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  async attach(host: HTMLElement) {
    if (this.disposed) return;
    this.lastUsed = ++terminalPreviewUseSequence;
    this.active = true;
    if (this.host && this.host !== host) this.resizeObserver?.disconnect();
    this.host = host;
    await this.ensureTerminal(host);
    if (this.disposed || !this.active || this.host !== host || !this.terminal || !this.container) return;
    this.container.style.width = "100%";
    this.container.style.height = "100%";
    if (this.container.parentElement !== host) host.appendChild(this.container);
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(host);
    this.ensureSocket();
    this.scheduleResize({ repaint: true, sendInitialSize: true });
  }

  detach(host: HTMLElement | undefined) {
    if (host && this.host !== host) return;
    this.active = false;
    this.host = undefined;
    this.resizeObserver?.disconnect();
    this.cancelScheduledResize();
    if (this.container) {
      const width = Math.max(this.container.clientWidth, this.terminal?.element?.clientWidth || 0);
      const height = Math.max(this.container.clientHeight, this.terminal?.element?.clientHeight || 0);
      if (width > 0) this.container.style.width = `${width}px`;
      if (height > 0) this.container.style.height = `${height}px`;
      terminalPreviewParkingRoot().appendChild(this.container);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.host = undefined;
    this.cancelScheduledResize();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.terminal?.dispose();
    this.terminal = undefined;
    this.fit = undefined;
    this.container?.remove();
    this.container = undefined;
    window.removeEventListener("focus", this.handleWindowFocus);
    window.removeEventListener("blur", this.handleWindowBlur);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private async ensureTerminal(host: HTMLElement) {
    if (this.terminal || this.initialization) return this.initialization;
    this.initialization = (async () => {
      const { Terminal, FitAddon } = await loadTerminalModules();
      if (this.disposed) return;
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
        fontSize: 13,
        theme: terminalTheme(),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.height = "100%";
      container.style.minWidth = "0";
      container.style.minHeight = "0";
      host.appendChild(container);
      terminal.open(container);
      terminal.onResize(({ cols, rows }) => this.sendResize(cols, rows));
      terminal.onData((data) => {
        if (this.active && this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "input", data }));
        }
      });
      this.terminal = terminal;
      this.fit = fit;
      this.container = container;
      this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
      if (!this.active || this.host !== host) terminalPreviewParkingRoot().appendChild(container);
    })().finally(() => {
      this.initialization = undefined;
    });
    return this.initialization;
  }

  private ensureSocket() {
    if (this.disposed || !this.terminal || (this.socket && this.socket.readyState < WebSocket.CLOSING)) return;
    const socket = new WebSocket(this.socketUrl);
    this.socket = socket;
    this.lastSentDimensions = undefined;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.socket === socket) this.scheduleResize({ repaint: true, sendInitialSize: true });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || !this.terminal) return;
      if (typeof event.data !== "string") {
        this.terminal.write(new Uint8Array(event.data));
        return;
      }
      try {
        const message = JSON.parse(event.data) as { type?: string; data?: unknown; message?: unknown; pendingEscape?: unknown; protocolVersion?: unknown; cols?: unknown; rows?: unknown };
        if (message.type === "connected" && message.protocolVersion !== TTY_STREAM_PROTOCOL_VERSION) {
          console.warn("TTY stream protocol version mismatch.", {
            expected: TTY_STREAM_PROTOCOL_VERSION,
            received: message.protocolVersion,
          });
        } else if (message.type === "snapshot" && typeof message.data === "string") {
          this.restoringSnapshot = true;
          this.cancelScheduledResize();
          if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && Number(message.cols) > 0 && Number(message.rows) > 0) {
            this.applyRemoteDimensions(Number(message.cols), Number(message.rows));
          }
          this.terminal.reset();
          const pendingEscape = typeof message.pendingEscape === "string" ? message.pendingEscape : "";
          this.terminal.write(`${message.data}${pendingEscape}`, () => {
            if (this.socket !== socket || !this.terminal) return;
            this.restoringSnapshot = false;
            this.scheduleResize({ repaint: true, sendInitialSize: true });
          });
        } else if (message.type === "output" && typeof message.data === "string") {
          this.terminal.write(message.data);
        } else if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && Number(message.cols) > 0 && Number(message.rows) > 0) {
          this.applyRemoteDimensions(Number(message.cols), Number(message.rows));
        } else if (message.type === "error") {
          this.terminal.writeln(String(message.message || "TTY session error."));
        }
      } catch {
        this.terminal.write(event.data);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
    });
  }

  private sendResize(cols: number, rows: number) {
    if (
      !canPublishTerminalResize({
        active: this.active,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        applyingRemoteResize: this.applyingRemoteResize || this.restoringSnapshot,
      })
      || this.restoringSnapshot
      || this.socket?.readyState !== WebSocket.OPEN
      || (this.lastSentDimensions?.cols === cols && this.lastSentDimensions.rows === rows)
    ) return;
    this.lastSentDimensions = { cols, rows };
    this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  private applyRemoteDimensions(cols: number, rows: number) {
    if (!this.terminal) return;
    this.applyingRemoteResize = true;
    this.lastSentDimensions = { cols, rows };
    try {
      this.terminal.resize(cols, rows);
    } finally {
      this.applyingRemoteResize = false;
    }
  }

  private readonly handleWindowFocus = () => {
    if (this.active) this.scheduleResize({ repaint: true, sendInitialSize: true });
  };

  private readonly handleWindowBlur = () => {
    this.cancelScheduledResize();
  };

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
      this.scheduleResize({ repaint: true, sendInitialSize: true });
    } else {
      this.cancelScheduledResize();
    }
  };

  private cancelScheduledResize() {
    this.resizeGeneration += 1;
    if (this.refreshFrame !== undefined) {
      window.cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = undefined;
    }
  }

  private scheduleResize(options: { repaint?: boolean; sendInitialSize?: boolean } = {}) {
    this.repaintRequested ||= Boolean(options.repaint);
    this.initialResizeRequested ||= Boolean(options.sendInitialSize);
    if (!this.active || !this.host || this.restoringSnapshot) return;
    this.cancelScheduledResize();
    const generation = this.resizeGeneration;
    let previousDimensions: { cols: number; rows: number } | undefined;
    let stableFrames = 0;
    let attempts = 0;

    const measure = () => {
      this.refreshFrame = undefined;
      const host = this.host;
      if (generation !== this.resizeGeneration || !this.active || !host) return;
      attempts += 1;
      if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) {
        if (attempts < 12) this.refreshFrame = window.requestAnimationFrame(measure);
        return;
      }
      let dimensions: { cols: number; rows: number } | undefined;
      try {
        dimensions = this.fit?.proposeDimensions() || undefined;
      } catch {
        return;
      }
      if (!dimensions || !this.terminal) return;
      if (previousDimensions?.cols === dimensions.cols && previousDimensions.rows === dimensions.rows) stableFrames += 1;
      else {
        previousDimensions = dimensions;
        stableFrames = 1;
      }
      if (stableFrames < 2 && attempts < 8) {
        this.refreshFrame = window.requestAnimationFrame(measure);
        return;
      }

      const shouldRepaint = this.repaintRequested;
      const shouldSendInitialSize = this.initialResizeRequested;
      this.repaintRequested = false;
      this.initialResizeRequested = false;
      try {
        if (this.terminal.cols !== dimensions.cols || this.terminal.rows !== dimensions.rows) this.fit?.fit();
        if (shouldRepaint && this.terminal.rows > 0) this.terminal.refresh(0, this.terminal.rows - 1);
        if (shouldSendInitialSize) this.sendResize(this.terminal.cols, this.terminal.rows);
      } catch {
        // The next visible layout observation will retry the fit.
      }
    };

    this.refreshFrame = window.requestAnimationFrame(measure);
  }
}

const terminalPreviewCache = new BoundedInactiveLruCache<CachedTerminalPreview>(MAX_CACHED_TERMINAL_PREVIEWS);

function acquireTerminalPreview(scope: string, key: string, socketUrl: string) {
  const cacheId = terminalPreviewCacheId(scope, key);
  const cached = terminalPreviewCache.get(cacheId);
  if (cached?.socketUrl === socketUrl) return cached;
  if (cached) terminalPreviewCache.remove(cacheId);
  const created = new CachedTerminalPreview(scope, key, socketUrl);
  if (!terminalPreviewCache.add(cacheId, created)) {
    created.dispose();
    return undefined;
  }
  return created;
}

export function pruneTerminalPreviewCache(scope: string, validKeys: ReadonlySet<string>) {
  terminalPreviewCache.prune((entry) => entry.scope !== scope || validKeys.has(entry.key));
}

export function clearTerminalPreviewCache() {
  terminalPreviewCache.clear();
}

export function useTerminalPreview(
  cacheScope: Ref<string>,
  cacheKey: Ref<string>,
  socketUrl: Ref<string>,
  host: Ref<HTMLElement | null>,
  active: Ref<boolean>,
) {
  let attachedEntry: CachedTerminalPreview | undefined;
  let attachedHost: HTMLElement | undefined;
  let mountGeneration = 0;

  async function mountTerminalPreview() {
    const generation = ++mountGeneration;
    await nextTick();
    const scope = cacheScope.value;
    const key = cacheKey.value;
    const url = socketUrl.value;
    const target = host.value;
    if (!active.value || !scope || !key || !url || !target) {
      detachTerminalPreview();
      return;
    }
    if (attachedEntry?.scope === scope && attachedEntry.key === key && attachedEntry.socketUrl === url && attachedHost === target) {
      await attachedEntry.attach(target);
      // A stale mount must not detach an entry already adopted by a newer mount.
      if (generation !== mountGeneration) return;
      if (!active.value || host.value !== target) detachTerminalPreview();
      return;
    }
    releaseAttachedTerminalPreview();
    if (generation !== mountGeneration) return;
    const entry = acquireTerminalPreview(scope, key, url);
    if (!entry) return;
    attachedEntry = entry;
    attachedHost = target;
    await entry.attach(target);
    // A newer mount owns cleanup after it advances the generation.
    if (generation !== mountGeneration) return;
    if (!active.value || host.value !== target) {
      entry.detach(target);
      if (attachedEntry === entry) {
        attachedEntry = undefined;
        attachedHost = undefined;
      }
    }
  }

  function detachTerminalPreview() {
    mountGeneration += 1;
    releaseAttachedTerminalPreview();
  }

  function releaseAttachedTerminalPreview() {
    attachedEntry?.detach(attachedHost);
    attachedEntry = undefined;
    attachedHost = undefined;
  }

  return {
    detachTerminalPreview,
    mountTerminalPreview,
  };
}
