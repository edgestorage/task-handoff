function shellQuote(value: unknown) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function restartShellCommand() {
  return `sleep 0.3; exec ${[process.execPath, ...process.argv.slice(1)].map(shellQuote).join(" ")}`;
}

type RawModeStream = NodeJS.ReadStream & {
  __taskHandoffReadEioGuard?: boolean;
  __taskHandoffRawModeGuard?: boolean;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function retryRawMode(originalSetRawMode: (mode: boolean) => unknown, stream: RawModeStream, mode: boolean, attempts: number) {
  if (attempts <= 0) {
    return;
  }
  setTimeout(() => {
    try {
      originalSetRawMode.call(stream, mode);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "EIO") {
        retryRawMode(originalSetRawMode, stream, mode, attempts - 1);
      }
    }
  }, 100).unref?.();
}

export function guardRawModeEio(stream: RawModeStream = process.stdin) {
  if (!stream) {
    return;
  }
  if (!stream.__taskHandoffReadEioGuard) {
    stream.__taskHandoffReadEioGuard = true;
    stream.on("error", (error: unknown) => {
      if (!isNodeError(error) || error.code !== "EIO") {
        setTimeout(() => {
          throw error;
        }, 0);
      }
    });
  }
  if (!stream.setRawMode || stream.__taskHandoffRawModeGuard) {
    return;
  }
  const originalSetRawMode = stream.setRawMode;
  stream.__taskHandoffRawModeGuard = true;
  stream.setRawMode = function setRawModeWithEioRetry(this: RawModeStream, mode: boolean) {
    try {
      return originalSetRawMode.call(this, mode);
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EIO") {
        throw error;
      }
      retryRawMode(originalSetRawMode, this, mode, 5);
      return this;
    }
  };
}
