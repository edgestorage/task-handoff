const EMBEDDED_BROWSER_PAGE_HOST_ENV = "TASK_HANDOFF_EMBEDDED_BROWSER_PAGE_HOST";
const EMBEDDED_BROWSER_PAGE_HOSTS = Object.freeze({
  rendererWebview: "renderer-webview",
  mainPagePool: "main-page-pool",
});

function embeddedBrowserHostCapabilities(pageHost) {
  const custom = pageHost === EMBEDDED_BROWSER_PAGE_HOSTS.mainPagePool;
  return Object.freeze({
    backgroundCreation: custom,
    surviveHostWindowClose: custom,
    crossWindowAdopt: custom,
  });
}

function requestedEmbeddedBrowserPageHost(env = process.env) {
  const configured = String(env[EMBEDDED_BROWSER_PAGE_HOST_ENV] || "").trim();
  if (!configured) return { pageHost: EMBEDDED_BROWSER_PAGE_HOSTS.rendererWebview, invalid: false };
  if (Object.values(EMBEDDED_BROWSER_PAGE_HOSTS).includes(configured)) return { pageHost: configured, invalid: false };
  return { pageHost: EMBEDDED_BROWSER_PAGE_HOSTS.rendererWebview, invalid: true };
}

function detectEmbeddedBrowserPagePoolApi(target) {
  return Boolean(
    target
    && typeof target.createWebViewPage === "function"
    && typeof target.getAllWebViewPages === "function"
    && typeof target.fromWebViewPageId === "function",
  );
}

function resolveEmbeddedBrowserPageHost(env = process.env, customPagePoolAvailable = false) {
  const requested = requestedEmbeddedBrowserPageHost(env);
  const customAvailable = requested.pageHost === EMBEDDED_BROWSER_PAGE_HOSTS.mainPagePool && customPagePoolAvailable === true;
  const pageHost = customAvailable ? EMBEDDED_BROWSER_PAGE_HOSTS.mainPagePool : EMBEDDED_BROWSER_PAGE_HOSTS.rendererWebview;
  const degraded = requested.invalid || (requested.pageHost === EMBEDDED_BROWSER_PAGE_HOSTS.mainPagePool && !customAvailable);
  return Object.freeze({
    requestedPageHost: requested.pageHost,
    pageHost,
    capabilities: embeddedBrowserHostCapabilities(pageHost),
    customPagePoolAvailable: customPagePoolAvailable === true,
    degraded,
    degradedReason: requested.invalid
      ? "invalid-configuration"
      : degraded
        ? "page-pool-api-unavailable"
        : undefined,
  });
}

module.exports = {
  EMBEDDED_BROWSER_PAGE_HOST_ENV,
  EMBEDDED_BROWSER_PAGE_HOSTS,
  detectEmbeddedBrowserPagePoolApi,
  embeddedBrowserHostCapabilities,
  requestedEmbeddedBrowserPageHost,
  resolveEmbeddedBrowserPageHost,
};
