const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PUBLISHER_ID_FILE = "embedded-browser-publisher-id";
const PUBLISHER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveDesktopBrowserPublisherId(options = {}) {
  const userDataDir = typeof options.userDataDir === "string" ? options.userDataDir.trim() : "";
  const fileSystem = options.fs || fs;
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  const logInfo = options.logInfo;
  if (!userDataDir) return randomUUID();

  const filePath = path.join(userDataDir, PUBLISHER_ID_FILE);
  try {
    const existing = fileSystem.readFileSync(filePath, "utf8").trim();
    if (PUBLISHER_ID_PATTERN.test(existing)) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") logInfo?.(`[desktop-shell] embedded browser publisher id read failed path=${filePath} error=${error instanceof Error ? error.message : String(error)}`);
  }

  const publisherId = randomUUID();
  try {
    fileSystem.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    fileSystem.writeFileSync(filePath, `${publisherId}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    logInfo?.(`[desktop-shell] embedded browser publisher id write failed path=${filePath} error=${error instanceof Error ? error.message : String(error)}`);
  }
  return publisherId;
}

module.exports = { resolveDesktopBrowserPublisherId };
