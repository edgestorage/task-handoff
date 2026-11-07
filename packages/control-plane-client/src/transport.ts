import type { BrowserChannel, BrowserChannelHandlers } from "@task-handoff/protocol/relay-browser-channel";
import type { z } from "zod";

export interface ControlPlaneClientTransport {
  supportsBrowserChannel?(): Promise<boolean>;
  openBrowserChannel?(instanceId: string, handlers: BrowserChannelHandlers, signal?: AbortSignal): Promise<BrowserChannel>;
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, onUploadProgress?: (progress: number) => void): Promise<T>;
  /**
   * Optional binary download support. Transports that can stream a non-JSON
   * response implement it; consumers must fail with a capability error when it
   * is missing instead of falling back to a direct fetch.
   */
  requestBinary?(path: string, init?: RequestInit): Promise<{ body: Uint8Array; filename?: string; contentType?: string }>;
}
