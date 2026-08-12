const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_INSTANCE_DETAIL_SIZE = Object.freeze({ width: 1280, height: 820 });
const INSTANCE_DETAIL_SIZE_LIMITS = Object.freeze({ minWidth: 400, minHeight: 520, maxWidth: 7680, maxHeight: 4320 });

function sanitizeInstanceDetailSize(value) {
  if (!value || typeof value !== "object") return undefined;
  const width = value.width;
  const height = value.height;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width < INSTANCE_DETAIL_SIZE_LIMITS.minWidth || width > INSTANCE_DETAIL_SIZE_LIMITS.maxWidth) return undefined;
  if (height < INSTANCE_DETAIL_SIZE_LIMITS.minHeight || height > INSTANCE_DETAIL_SIZE_LIMITS.maxHeight) return undefined;
  return { width, height };
}

function createDesktopWindowPreferences(options) {
  const file = options.file;
  let instanceDetailSize = DEFAULT_INSTANCE_DETAIL_SIZE;
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    instanceDetailSize = sanitizeInstanceDetailSize(stored?.instanceDetailSize) || DEFAULT_INSTANCE_DETAIL_SIZE;
  } catch {
    // Missing, historical, and partially written local preferences use current defaults.
  }

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ instanceDetailSize }, undefined, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  return {
    instanceDetailSize() {
      return { ...instanceDetailSize };
    },
    rememberInstanceDetailSize(value) {
      const next = sanitizeInstanceDetailSize(value);
      if (!next || (next.width === instanceDetailSize.width && next.height === instanceDetailSize.height)) return false;
      instanceDetailSize = next;
      write();
      return true;
    },
  };
}

module.exports = {
  createDesktopWindowPreferences,
  DEFAULT_INSTANCE_DETAIL_SIZE,
  INSTANCE_DETAIL_SIZE_LIMITS,
  sanitizeInstanceDetailSize,
};
