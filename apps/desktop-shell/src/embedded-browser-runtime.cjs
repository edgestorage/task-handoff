function webkitVersionFromUserAgent(userAgent) {
  const match = /AppleWebKit\/([^\s)]+)/.exec(String(userAgent || ""));
  return match?.[1] || "537.36";
}

function chromePlatformToken(userAgent) {
  const match = /^Mozilla\/5\.0 \(([^)]*)\)/.exec(String(userAgent || "").trim());
  return match?.[1] || "";
}

function fallbackChromePlatformToken(platform, arch) {
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (platform === "win32") return arch === "ia32" ? "Windows NT 10.0; WOW64" : "Windows NT 10.0; Win64; x64";
  if (arch === "arm64") return "X11; Linux aarch64";
  if (arch === "ia32") return "X11; Linux i686";
  return "X11; Linux x86_64";
}

function embeddedBrowserChromeUserAgent(options = {}) {
  const versions = options.versions || process.versions;
  const chromeMajor = /^(\d+)/.exec(String(versions.chrome || "").trim())?.[1];
  if (!chromeMajor) return "";
  const platformToken = chromePlatformToken(options.userAgent)
    || fallbackChromePlatformToken(options.platform || process.platform, options.arch || process.arch);
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
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
  embeddedBrowserChromeUserAgent,
  webkitVersionFromUserAgent,
};
