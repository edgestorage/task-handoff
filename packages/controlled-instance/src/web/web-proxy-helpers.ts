import http from "node:http";

const WEB_PROXY_STARTUP_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH"]);

export const WEB_PROXY_STARTUP_RETRY_MS = 8000;
export const WEB_PROXY_STARTUP_RETRY_INTERVAL_MS = 200;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableWebProxyError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return Boolean(code && WEB_PROXY_STARTUP_ERROR_CODES.has(code));
}

export function proxyPath(sessionId: string, rawUrl = "/") {
  const parsed = new URL(rawUrl, "http://task-handoff.local");
  const prefix = `/api/apps/sessions/${sessionId}/web`;
  const suffix = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : "/";
  return `${suffix.startsWith("/") ? suffix : `/${suffix}`}${parsed.search}`;
}

export function kasmVncAuthorizationHeader() {
  const username = process.env.TASK_HANDOFF_KASMVNC_USERNAME || "agent";
  const password = process.env.TASK_HANDOFF_KASMVNC_PASSWORD || "taskhandoff";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function proxyHeaders(headers: http.IncomingHttpHeaders, host: string, port: number, extraHeaders: http.OutgoingHttpHeaders = {}) {
  const blocked = new Set(["connection", "content-length", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "referer", "referrer", "te", "trailer", "transfer-encoding", "upgrade"]);
  const isBlocked = (key: string) => {
    const lower = key.toLowerCase();
    return blocked.has(lower) || lower.startsWith("sec-ch-") || lower.startsWith("sec-fetch-");
  };
  return {
    ...Object.fromEntries(Object.entries(headers)
      .filter(([key, value]) => !isBlocked(key) && value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)])),
    ...Object.fromEntries(Object.entries(extraHeaders)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)])),
    host: `${host}:${port}`,
  };
}

export function proxyWebSocketHeaders(headers: http.IncomingHttpHeaders, host: string, port: number, extraHeaders: http.OutgoingHttpHeaders = {}) {
  return Object.fromEntries(Object.entries(proxyHeaders(headers, host, port, extraHeaders)).filter(([key]) => {
    const lower = key.toLowerCase();
    return !lower.startsWith("sec-websocket-") || lower === "sec-websocket-origin";
  }));
}

export function proxyWebSocketProtocols(headers: http.IncomingHttpHeaders) {
  const raw = headers["sec-websocket-protocol"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const protocols = values.flatMap((value) => value.split(",").map((protocol) => protocol.trim()).filter(Boolean));
  return protocols.length ? protocols : undefined;
}

function responseHeaderValue(headers: http.IncomingHttpHeaders, key: string) {
  const value = headers[key];
  return Array.isArray(value) ? value.join(",") : value || "";
}

export function shouldThemeKasmVncResponse(headers: http.IncomingHttpHeaders) {
  if (responseHeaderValue(headers, "content-encoding")) {
    return false;
  }
  const contentType = responseHeaderValue(headers, "content-type").toLowerCase();
  return contentType.includes("text/css") || contentType.includes("text/html");
}

function kasmVncLoadingThemeStyle() {
  return [
    "<style id=\"task-handoff-kasm-loading-theme\">",
    "html,body{background:#05090b!important;}",
    "#noVNC_transition{background-color:#05090b!important;color:#31c6b6!important;}",
    "#noVNC_transition::after{color:#9fb4bc!important;}",
    "html.task-handoff-kasm-quiet-start #noVNC_control_bar{transition:none!important;}",
    "html.task-handoff-kasm-quiet-start #noVNC_control_bar.noVNC_open{left:-100%!important;}",
    "html.task-handoff-kasm-quiet-start.noVNC_right #noVNC_control_bar.noVNC_open{left:100%!important;}",
    "html.task-handoff-kasm-quiet-start #noVNC_control_bar_handle::after,html.task-handoff-kasm-quiet-start .noVNC_panel{transition:none!important;}",
    "</style>",
    "<script id=\"task-handoff-kasm-quiet-start\">",
    "(function(){",
    "var root=document.documentElement;",
    "root.classList.add('task-handoff-kasm-quiet-start');",
    "var attempts=0;",
    "var timer=window.setInterval(function(){",
    "var bar=document.getElementById('noVNC_control_bar');",
    "if(bar){bar.classList.remove('noVNC_open');}",
    "attempts+=1;",
    "if(attempts>=20){window.clearInterval(timer);root.classList.remove('task-handoff-kasm-quiet-start');}",
    "},100);",
    "})();",
    "</script>",
  ].join("");
}

export function themeKasmVncResponseBody(body: Buffer, headers: http.IncomingHttpHeaders) {
  const contentType = responseHeaderValue(headers, "content-type").toLowerCase();
  const text = body.toString("utf8");
  if (contentType.includes("text/css")) {
    return text
      .replace(/(#noVNC_transition\s*\{[\s\S]*?background\s*:\s*)#fff(\s+url\()/g, "$1#05090b$2")
      .replace(/(#noVNC_transition\s*\{[\s\S]*?background-color\s*:\s*)#fff\b/g, "$1#05090b");
  }
  if (contentType.includes("text/html")) {
    const style = kasmVncLoadingThemeStyle();
    return text.includes("</head>") ? text.replace("</head>", `${style}</head>`) : `${style}${text}`;
  }
  return text;
}

export function fetchHeadersToNode(headers: Headers) {
  const result: http.IncomingHttpHeaders = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  const cookies = headers.getSetCookie?.();
  if (cookies?.length) {
    result["set-cookie"] = cookies;
  }
  return result;
}

export function fetchHeadersToOutgoing(headers: Headers) {
  const result: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  const cookies = headers.getSetCookie?.();
  if (cookies?.length) {
    result["set-cookie"] = cookies;
  }
  return result;
}
