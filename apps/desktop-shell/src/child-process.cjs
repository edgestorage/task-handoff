function superviseDesktopChild(child, options) {
  child.stdout?.on("data", (chunk) => options.logInfo(`[${options.label}] ${chunk.toString("utf8").trimEnd()}`));
  child.stderr?.on("data", (chunk) => options.logError(`[${options.label}] ${chunk.toString("utf8").trimEnd()}`));
  child.on("error", (error) => {
    options.onError?.(error);
    options.logError(`[${options.label}] failed to spawn command=${options.command} cwd=${options.cwd}: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (code || signal) options.logError(`[${options.label}] exited code=${code ?? ""} signal=${signal ?? ""}`);
    options.onExit?.(code, signal);
  });
  return child;
}

function waitForDesktopChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopSupervisedDesktopChild(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForDesktopChildExit(child, options.gracefulTimeoutMs ?? 3_000)) return;
  options.onForce?.();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (await waitForDesktopChildExit(child, options.forceTimeoutMs ?? 2_000)) return;
  throw new Error(`${options.label || "Desktop child"} did not exit after SIGKILL.`);
}

module.exports = { stopSupervisedDesktopChild, superviseDesktopChild, waitForDesktopChildExit };
