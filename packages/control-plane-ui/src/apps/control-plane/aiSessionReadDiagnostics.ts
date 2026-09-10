import { logDesktopBrowserDiagnostic } from "../../lib/desktopBridge.ts";

type DiagnosticFields = Record<string, string | number | boolean | undefined>;

export function createAiSessionReadDiagnostics(
  enabled: boolean,
  sink: (message: string, instanceId?: string) => void,
  pageId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
) {
  let sequence = 0;
  return (event: string, fields: DiagnosticFields = {}) => {
    if (!enabled) return;
    try {
      const id = `${pageId}:${++sequence}`;
      const text = JSON.stringify({ time: new Date().toISOString(), event, ...fields });
      const count = Math.ceil(text.length / 150);
      for (let index = 0; index < count; index += 1) {
        sink(`ai-session-read ${id} ${index + 1}/${count} ${text.slice(index * 150, (index + 1) * 150)}`, fields.instanceId as string | undefined);
      }
    } catch {}
  };
}

export const recordAiSessionRead = createAiSessionReadDiagnostics(
  import.meta.env?.VITE_AI_SESSION_READ_DIAGNOSTICS === "1",
  logDesktopBrowserDiagnostic,
);
