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

function isAllowedEmbeddedBrowserUrl(targetUrl) {
  if (String(targetUrl || "") === "about:blank") return true;
  const target = parseUrl(targetUrl);
  return Boolean(target && WEB_PROTOCOLS.has(target.protocol));
}

function isAllowedEmbeddedBrowserFrameUrl(targetUrl) {
  if (isAllowedEmbeddedBrowserUrl(targetUrl)) return true;
  const target = parseUrl(targetUrl);
  if (!target) return false;
  if (target.protocol === "about:") return target.href === "about:srcdoc" || target.href === "about://srcdoc";
  if (target.protocol !== "blob:") return false;
  // Blob documents inherit their creator's origin. Challenge widgets such as
  // Cloudflare Turnstile run in HTTP(S)-origin blobs; opaque blobs stay blocked.
  return target.origin.startsWith("http:") || target.origin.startsWith("https:");
}

function externalNavigationUrl(targetUrl) {
  const target = parseUrl(targetUrl);
  if (!target || !EXTERNAL_PROTOCOLS.has(target.protocol)) return undefined;
  return target.toString();
}

module.exports = {
  externalNavigationUrl,
  isAllowedControlPlaneNavigation,
  isAllowedEmbeddedBrowserFrameUrl,
  isAllowedEmbeddedBrowserUrl,
};
