const { events: ALLOWED_CDP_EVENTS, methods: CDP_METHODS, profile } = require("./embedded-browser-cdp-profile.json");

const ALLOWED_CDP_METHODS = new Map(Object.entries(CDP_METHODS));
const ALLOWED_CDP_EVENT_SET = new Set(ALLOWED_CDP_EVENTS);

function embeddedBrowserCdpMethodKind(value) {
  const method = typeof value === "string" ? value.trim() : "";
  if (!method || method.length > 240 || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) return undefined;
  return ALLOWED_CDP_METHODS.get(method);
}

function assertEmbeddedBrowserCdpMethod(value, options = {}) {
  const method = typeof value === "string" ? value.trim() : "";
  const kind = embeddedBrowserCdpMethodKind(method);
  if (!kind || (kind === "adapter-only" && options.adapterOnly !== true)) {
    throw Object.assign(new Error("BROWSER_OPERATION_UNSUPPORTED"), { code: "BROWSER_OPERATION_UNSUPPORTED" });
  }
  return method;
}

function supportsEmbeddedBrowserCdpEvent(value) {
  return typeof value === "string" && ALLOWED_CDP_EVENT_SET.has(value);
}

module.exports = {
  ALLOWED_CDP_EVENTS,
  ALLOWED_CDP_METHODS,
  EMBEDDED_BROWSER_CDP_PROFILE: profile,
  assertEmbeddedBrowserCdpMethod,
  embeddedBrowserCdpMethodKind,
  supportsEmbeddedBrowserCdpEvent,
};
