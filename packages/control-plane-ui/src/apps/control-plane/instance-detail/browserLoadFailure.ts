export type BrowserLoadFailureInput = {
  chromiumCode?: number;
  tunnelCode?: string;
};

// The webview only exposes Chromium's coarse SOCKS error (-120) for every
// tunnel failure. When the desktop shell forwards the tunnel's own code we
// prefer it, so the prompt can name the real cause: an unusable relay versus a
// target the controlled instance could not connect to.
export function browserLoadFailureKey(input: BrowserLoadFailureInput): string {
  switch (input.tunnelCode) {
    case "BROWSER_TUNNEL_CONNECT_FAILED":
      return "sessions.browser.loadFailedTargetUnavailable";
    case "BROWSER_TUNNEL_CONNECT_TIMEOUT":
      return "sessions.browser.loadFailedTimeout";
    case "BROWSER_TUNNEL_STREAM_LIMIT":
    case "BROWSER_TUNNEL_FLOW_CONTROL":
    case "BROWSER_TUNNEL_IDLE_TIMEOUT":
      return "sessions.browser.loadFailedBusy";
    case "BROWSER_RELAY_UNAVAILABLE":
    case "BROWSER_TUNNEL_CLOSED":
    case "BROWSER_TUNNEL_PROTOCOL_ERROR":
      return "sessions.browser.loadFailedTunnel";
    default:
      break;
  }
  switch (input.chromiumCode) {
    case -105:
    case -137:
      return "sessions.browser.loadFailedDns";
    case -106:
      return "sessions.browser.loadFailedOffline";
    case -7:
    case -118:
      return "sessions.browser.loadFailedTimeout";
    case -100:
    case -101:
    case -102:
      return "sessions.browser.loadFailedTunnel";
    case -104:
    case -109:
    case -120:
    case -121:
    case -138:
      return "sessions.browser.loadFailedTargetUnavailable";
    default:
      return "sessions.browser.loadFailed";
  }
}

// Mirrors the desktop shell's diagnostic redaction: keep the origin and path,
// drop any query/fragment that could carry a one-time token.
export function browserFailureTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 200);
  } catch {
    return String(value || "").slice(0, 200);
  }
}
