import { nextTick, type Ref } from "vue";

function terminalTheme() {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-text").trim(),
    cursor: styles.getPropertyValue("--status-success").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}

export function useTerminalPreview(socketUrl: Ref<string>, host: Ref<HTMLElement | null>) {
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
    const sendResize = () => {
      const dimensions = fit.proposeDimensions();
      if (dimensions && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: dimensions.cols, rows: dimensions.rows }));
      }
    };
    const resize = () => {
      if (!target.isConnected || target.clientWidth === 0 || target.clientHeight === 0) {
        return;
      }
      try {
        fit.fit();
        if (terminal.rows > 0) {
          terminal.refresh(0, terminal.rows - 1);
        }
        sendResize();
      } catch {
        // xterm can throw while the preview is hidden during a layout change.
      }
    };
    let refreshFrame: number | undefined;
    let refreshTimer: number | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const scheduleResize = () => {
      if (refreshFrame !== undefined) {
        window.cancelAnimationFrame(refreshFrame);
      }
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = undefined;
        resize();
      });
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        resize();
      }, 80);
    };
    refreshTerminalPreview = scheduleResize;
    terminal.loadAddon(fit);
    terminal.open(target);
    resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(target);
    scheduleResize();
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", scheduleResize);
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      try {
        const message = JSON.parse(event.data) as { type?: string; data?: unknown; message?: unknown };
        if (message.type === "output" && typeof message.data === "string") {
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
    window.addEventListener("resize", scheduleResize);
    scheduleResize();
    terminalCleanup = () => {
      if (refreshFrame !== undefined) {
        window.cancelAnimationFrame(refreshFrame);
      }
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleResize);
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
