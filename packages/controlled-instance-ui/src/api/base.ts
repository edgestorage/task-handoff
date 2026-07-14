declare global {
  interface Window {
    __TASK_HANDOFF_PUBLIC_BASE__?: string;
  }
}

export function publicBasePath() {
  if (typeof window === "undefined") {
    return "";
  }
  return (window.__TASK_HANDOFF_PUBLIC_BASE__ || "").replace(/\/$/, "");
}

export function publicUrl(path: string) {
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    return path;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${publicBasePath()}${normalized}`;
}

export function publicPathParam(path: string) {
  return publicUrl(path).replace(/^\//, "");
}

export function publicApiBaseUrl() {
  return publicUrl("/api");
}

export function publicWebSocketUrl(path: string, token = "") {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(publicUrl(path), window.location.origin);
  url.protocol = protocol;
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export {};
