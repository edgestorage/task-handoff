const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function parseUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return undefined;
  }
}

function isAllowedControlPlaneNavigation(targetUrl, trustedOrigin) {
  if (String(targetUrl || "") === "about:blank") return true;
  const target = parseUrl(targetUrl);
  const trusted = parseUrl(trustedOrigin);
  if (!target || !trusted || !WEB_PROTOCOLS.has(target.protocol) || !WEB_PROTOCOLS.has(trusted.protocol)) return false;
  return target.origin === trusted.origin;
}

function externalNavigationUrl(targetUrl) {
  const target = parseUrl(targetUrl);
  if (!target || !EXTERNAL_PROTOCOLS.has(target.protocol)) return undefined;
  return target.toString();
}

module.exports = { externalNavigationUrl, isAllowedControlPlaneNavigation };
