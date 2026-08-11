const fs = require("node:fs");
const path = require("node:path");

function claimBackgroundNotice(dataDir, fsImpl = fs) {
  const preferencesDir = path.join(dataDir, "desktop");
  const marker = path.join(preferencesDir, "background-notice-v1");
  fsImpl.mkdirSync(preferencesDir, { recursive: true });
  try {
    const descriptor = fsImpl.openSync(marker, "wx", 0o600);
    fsImpl.closeSync(descriptor);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

module.exports = { claimBackgroundNotice };
