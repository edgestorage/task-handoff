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

export function useBoardTerminalPreviews(boardMode: Ref<boolean>, interactive: Ref<boolean>) {
  const boardTerminalHosts = new Map<string, { url: string; element: HTMLElement }>();
  const boardTerminalCleanups = new Map<string, { url: string; interactive: boolean; cleanup: () => void }>();
  const boardTerminalGenerations = new Map<string, number>();

  function setBoardTerminalHost(instanceId: string, url: string, element: unknown) {
    if (element instanceof HTMLElement && url) {
      boardTerminalHosts.set(instanceId, { url, element });
      void mountBoardTerminalPreview(instanceId);
      return;
    }
    boardTerminalHosts.delete(instanceId);
    disposeBoardTerminalPreview(instanceId);
  }

  async function mountBoardTerminalPreviews() {
    await nextTick();
    await Promise.all([...boardTerminalHosts.keys()].map((instanceId) => mountBoardTerminalPreview(instanceId)));
  }

  async function mountBoardTerminalPreview(instanceId: string) {
    await nextTick();
    if (!boardMode.value) {
      disposeBoardTerminalPreview(instanceId);
      return;
    }
    const target = boardTerminalHosts.get(instanceId);
    if (!target) {
      disposeBoardTerminalPreview(instanceId);
      return;
    }
    const existing = boardTerminalCleanups.get(instanceId);
    if (existing?.url === target.url && existing.interactive === interactive.value) {
      return;
    }
    disposeBoardTerminalPreview(instanceId);
    const generation = boardTerminalGenerations.get(instanceId) || 0;
    const terminalInteractive = interactive.value;
    if (!boardMode.value || boardTerminalHosts.get(instanceId)?.url !== target.url) {
      return;
    }
    const { Terminal: XTermTerminal } = await import("@xterm/xterm");
    if (
      generation !== boardTerminalGenerations.get(instanceId)
      || !boardMode.value
      || interactive.value !== terminalInteractive
      || boardTerminalHosts.get(instanceId)?.url !== target.url
    ) {
      return;
    }
    const surface = document.createElement("div");
    surface.className = "board-terminal-surface";
    const terminalHost = document.createElement("div");
    terminalHost.className = "board-terminal-host";
    surface.appendChild(terminalHost);
    target.element.replaceChildren(surface);
    let terminalCols = 120;
    let terminalRows = 32;
    const terminal = new XTermTerminal({
      convertEol: true,
      cursorBlink: terminalInteractive,
      disableStdin: !terminalInteractive,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
      fontSize: 10,
      lineHeight: 1.12,
      cols: terminalCols,
      rows: terminalRows,
      scrollback: 0,
      theme: terminalTheme(),
    });
    const socket = new WebSocket(target.url);
    let naturalWidth = terminalCols * 6.2;
    let naturalHeight = terminalRows * 11.2;
    const resizeTerminalGrid = (dimensions: { cols?: unknown; rows?: unknown } | undefined) => {
      const cols = typeof dimensions?.cols === "number" && Number.isFinite(dimensions.cols) ? Math.floor(dimensions.cols) : 0;
      const rows = typeof dimensions?.rows === "number" && Number.isFinite(dimensions.rows) ? Math.floor(dimensions.rows) : 0;
      if (cols < 2 || rows < 2 || (cols === terminalCols && rows === terminalRows)) {
        return;
      }
      terminalCols = cols;
      terminalRows = rows;
      naturalWidth = terminalCols * 6.2;
      naturalHeight = terminalRows * 11.2;
      terminal.resize(terminalCols, terminalRows);
      window.requestAnimationFrame(resize);
    };
    const resize = () => {
      const screen = surface.querySelector<HTMLElement>(".xterm-screen");
      const canvas = surface.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
      const nextWidth = Math.max(screen?.offsetWidth || 0, canvas ? canvas.width / window.devicePixelRatio : 0);
      const nextHeight = Math.max(screen?.offsetHeight || 0, canvas ? canvas.height / window.devicePixelRatio : 0);
      if (nextWidth > 0) {
        naturalWidth = nextWidth;
        surface.style.width = `${naturalWidth}px`;
      }
      if (nextHeight > 0) {
        naturalHeight = nextHeight;
        surface.style.height = `${naturalHeight}px`;
      }
      const style = window.getComputedStyle(target.element);
      const availableWidth = target.element.clientWidth - Number.parseFloat(style.paddingLeft || "0") - Number.parseFloat(style.paddingRight || "0");
      const availableHeight = target.element.clientHeight - Number.parseFloat(style.paddingTop || "0") - Number.parseFloat(style.paddingBottom || "0");
      const scale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
      const verticalOffset = Math.max(0, (availableHeight - naturalHeight * scale) / 2);
      surface.style.top = `${6 + verticalOffset}px`;
      surface.style.transform = `scale(${Math.max(0.1, scale)})`;
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    };
    let refreshFrame: number | undefined;
    let refreshTimer: number | undefined;
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
    const resizeObserver = new ResizeObserver(resize);
    terminal.open(terminalHost);
    terminal.resize(terminalCols, terminalRows);
    scheduleResize();
    resizeObserver.observe(target.element);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      try {
        const message = JSON.parse(event.data) as { type?: string; data?: unknown; message?: unknown; pendingEscape?: unknown; dimensions?: { cols?: unknown; rows?: unknown }; cols?: unknown; rows?: unknown };
        if (message.type === "connected") {
          resizeTerminalGrid(message.dimensions);
          return;
        }
        if (message.type === "resize") {
          resizeTerminalGrid(message);
          return;
        }
        if (message.type === "snapshot" && typeof message.data === "string") {
          resizeTerminalGrid(message);
          terminal.reset();
          terminal.write(message.data);
          if (typeof message.pendingEscape === "string" && message.pendingEscape) terminal.write(message.pendingEscape);
        } else if (message.type === "output" && typeof message.data === "string") {
          terminal.write(message.data);
        } else if (message.type === "error") {
          terminal.writeln(String(message.message || "TTY session error."));
        }
      } catch {
        terminal.write(event.data);
      }
    });
    if (terminalInteractive) {
      terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", data }));
        }
      });
    }
    scheduleResize();
    boardTerminalCleanups.set(instanceId, {
      url: target.url,
      interactive: terminalInteractive,
      cleanup: () => {
        if (refreshFrame !== undefined) {
          window.cancelAnimationFrame(refreshFrame);
        }
        if (refreshTimer !== undefined) {
          window.clearTimeout(refreshTimer);
        }
        resizeObserver.disconnect();
        socket.close();
        terminal.dispose();
        surface.remove();
      },
    });
  }

  function disposeBoardTerminalPreview(instanceId: string) {
    boardTerminalGenerations.set(instanceId, (boardTerminalGenerations.get(instanceId) || 0) + 1);
    boardTerminalCleanups.get(instanceId)?.cleanup();
    boardTerminalCleanups.delete(instanceId);
  }

  function disposeBoardTerminalPreviews() {
    for (const instanceId of [...boardTerminalCleanups.keys()]) {
      disposeBoardTerminalPreview(instanceId);
    }
  }

  function disposeHiddenBoardTerminalPreviews(visibleIds: Set<string>) {
    for (const instanceId of [...boardTerminalCleanups.keys()]) {
      if (!visibleIds.has(instanceId)) {
        disposeBoardTerminalPreview(instanceId);
      }
    }
  }

  return {
    disposeBoardTerminalPreviews,
    disposeHiddenBoardTerminalPreviews,
    mountBoardTerminalPreviews,
    setBoardTerminalHost,
  };
}
