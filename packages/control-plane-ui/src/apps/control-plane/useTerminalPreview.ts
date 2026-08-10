import { nextTick, type Ref } from "vue";
import { TTY_STREAM_PROTOCOL_VERSION } from "@task-handoff/protocol/app-sessions";

function terminalTheme() {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-text").trim(),
    cursor: styles.getPropertyValue("--status-success").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}

export function useTerminalPreview(socketUrl: Ref<string>, host: Ref<HTMLElement | null>, active: Ref<boolean>) {
  let terminalCleanup: (() => void) | undefined;
  let mountedTerminalUrl = "";
  let mountedTerminalHost: HTMLElement | undefined;
  let refreshTerminalPreview: (() => void) | undefined;
  let mountGeneration = 0;

  async function mountTerminalPreview() {
    await nextTick();
    const url = socketUrl.value;
    const target = host.value;
    if (!url || !target) {
      disposeTerminalPreview();
      return;
    }
    if (mountedTerminalUrl === url && mountedTerminalHost === target) {
      refreshTerminalPreview?.();
      return;
    }
    disposeTerminalPreview();
    const generation = mountGeneration;
    mountedTerminalUrl = url;
    mountedTerminalHost = target;
    const [{ Terminal: XTermTerminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    if (generation !== mountGeneration || socketUrl.value !== url || host.value !== target) {
      return;
    }
    const terminal = new XTermTerminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
      fontSize: 13,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    const socket = new WebSocket(url);
    let lastSentDimensions: { cols: number; rows: number } | undefined;
    const sendResize = (cols: number, rows: number) => {
      if (socket.readyState === WebSocket.OPEN && (lastSentDimensions?.cols !== cols || lastSentDimensions.rows !== rows)) {
        lastSentDimensions = { cols, rows };
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };
    let refreshFrame: number | undefined;
    let resizeGeneration = 0;
    let repaintRequested = false;
    let initialResizeRequested = false;
    let resizeObserver: ResizeObserver | undefined;
    const cancelScheduledResize = () => {
      resizeGeneration += 1;
      if (refreshFrame !== undefined) {
        window.cancelAnimationFrame(refreshFrame);
        refreshFrame = undefined;
      }
    };
    const scheduleResize = (options: { repaint?: boolean; sendInitialSize?: boolean } = {}) => {
      repaintRequested ||= Boolean(options.repaint);
      initialResizeRequested ||= Boolean(options.sendInitialSize);
      cancelScheduledResize();
      const generation = resizeGeneration;
      let previousDimensions: { cols: number; rows: number } | undefined;
      let stableFrames = 0;
      let attempts = 0;

      const measure = () => {
        refreshFrame = undefined;
        if (generation !== resizeGeneration || !active.value || !target.isConnected || target.clientWidth === 0 || target.clientHeight === 0) {
          return;
        }
        let dimensions: { cols: number; rows: number } | undefined;
        try {
          dimensions = fit.proposeDimensions() || undefined;
        } catch {
          return;
        }
        if (!dimensions) {
          return;
        }
        attempts += 1;
        if (previousDimensions?.cols === dimensions.cols && previousDimensions.rows === dimensions.rows) {
          stableFrames += 1;
        } else {
          previousDimensions = dimensions;
          stableFrames = 1;
        }
        if (stableFrames < 2 && attempts < 8) {
          refreshFrame = window.requestAnimationFrame(measure);
          return;
        }

        const shouldRepaint = repaintRequested;
        const shouldSendInitialSize = initialResizeRequested;
        repaintRequested = false;
        initialResizeRequested = false;
        try {
          if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) {
            fit.fit();
          }
          if (shouldRepaint && terminal.rows > 0) {
            terminal.refresh(0, terminal.rows - 1);
          }
          if (shouldSendInitialSize) {
            sendResize(terminal.cols, terminal.rows);
          }
        } catch {
          // The next visible layout observation will retry the fit.
        }
      };

      refreshFrame = window.requestAnimationFrame(measure);
    };
    refreshTerminalPreview = () => scheduleResize({ repaint: true, sendInitialSize: true });
    terminal.loadAddon(fit);
    terminal.open(target);
    terminal.onResize(({ cols, rows }) => sendResize(cols, rows));
    resizeObserver = new ResizeObserver(() => scheduleResize());
    resizeObserver.observe(target);
    scheduleResize({ repaint: true });
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => scheduleResize({ repaint: true, sendInitialSize: true }));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      try {
        const message = JSON.parse(event.data) as { type?: string; data?: unknown; message?: unknown; pendingEscape?: unknown; protocolVersion?: unknown };
        if (message.type === "connected" && message.protocolVersion !== TTY_STREAM_PROTOCOL_VERSION) {
          console.warn("TTY stream protocol version mismatch.", {
            expected: TTY_STREAM_PROTOCOL_VERSION,
            received: message.protocolVersion,
          });
        } else if (message.type === "snapshot" && typeof message.data === "string") {
          terminal.reset();
          terminal.write(message.data);
          if (typeof message.pendingEscape === "string" && message.pendingEscape) {
            terminal.write(message.pendingEscape);
          }
        } else if (message.type === "output" && typeof message.data === "string") {
          terminal.write(message.data);
        } else if (message.type === "error") {
          terminal.writeln(String(message.message || "TTY session error."));
        }
      } catch {
        terminal.write(event.data);
      }
    });
    terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    scheduleResize({ repaint: true });
    terminalCleanup = () => {
      cancelScheduledResize();
      resizeObserver?.disconnect();
      socket.close();
      terminal.dispose();
      mountedTerminalUrl = "";
    };
  }

  function disposeTerminalPreview() {
    mountGeneration += 1;
    terminalCleanup?.();
    terminalCleanup = undefined;
    mountedTerminalUrl = "";
    mountedTerminalHost = undefined;
    refreshTerminalPreview = undefined;
  }

  return {
    disposeTerminalPreview,
    mountTerminalPreview,
  };
}
