function webkitVersionFromUserAgent(userAgent) {
  const match = /AppleWebKit\/([^\s)]+)/.exec(String(userAgent || ""));
  return match?.[1] || "537.36";
}

function embeddedBrowserCdpIdentity(options = {}) {
  const versions = options.versions || process.versions;
  const chromeVersion = String(versions.chrome || "").trim();
  const v8Version = String(versions.v8 || "").trim();
  const userAgent = String(options.userAgent || "").trim();
  if (!chromeVersion || !v8Version || !userAgent) return undefined;
  return Object.freeze({
    chromeVersion,
    userAgent,
    v8Version,
    webkitVersion: webkitVersionFromUserAgent(userAgent),
  });
}

module.exports = {
  embeddedBrowserCdpIdentity,
  webkitVersionFromUserAgent,
};
