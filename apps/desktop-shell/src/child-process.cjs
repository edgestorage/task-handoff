function superviseDesktopChild(child, options) {
  child.stdout.on("data", (chunk) => options.logInfo(`[${options.label}] ${chunk.toString("utf8").trimEnd()}`));
  child.stderr.on("data", (chunk) => options.logError(`[${options.label}] ${chunk.toString("utf8").trimEnd()}`));
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

module.exports = { superviseDesktopChild };
