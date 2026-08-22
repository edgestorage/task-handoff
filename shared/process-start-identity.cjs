const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function processStartIdentity(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const startTime = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
      return startTime ? `linux:${startTime}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (["darwin", "freebsd", "openbsd", "aix", "sunos"].includes(platform)) {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
    const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
    return startedAt ? `${platform}:${startedAt}` : undefined;
  }
  if (platform === "win32") {
    const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", timeout: 2_000 });
    const ticks = result.status === 0 ? result.stdout.trim() : "";
    return /^\d+$/.test(ticks) ? `win32:${ticks}` : undefined;
  }
  return undefined;
}

module.exports = { processStartIdentity };
