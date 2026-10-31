import os from "node:os";
import {
  controlledInstanceShellRoute,
  CONTROLLED_INSTANCE_SHELL_PROTOCOL,
} from "@task-handoff/control-plane-client";
import {
  directoryInstanceShellCapabilities,
  supportsDirectoryInstanceShell,
} from "@task-handoff/protocol/control-plane-directory";
import {
  INSTANCE_SHELL_DATA_FRAME_MAX_BYTES,
  INSTANCE_SHELL_PROTOCOL_VERSION,
  INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES,
  InstanceShellDataChannel,
  InstanceShellProtocolError,
  decodeInstanceShellBinaryFrame,
  encodeInstanceShellBinaryFrame,
  parseInstanceShellServerControlFrame,
  type InstanceShellStartedFrame,
} from "@task-handoff/protocol/instance-shell";
import { requestUrl } from "../control-plane.ts";
import { CLI_EXIT_CODES, ThctlError, capabilityMissingError, networkError, protocolError, routeMissingError, usageError } from "../errors.ts";
import { createControlPlaneWebSocket, type CliWebSocket, type CliWebSocketData } from "../event-socket.ts";
import { assertActive, openConnection, type CliContext, type CliInvocation } from "../runtime.ts";

type ShellCommandMode = "interactive" | "exec";

const REMOTE_SIGNAL_WAIT_MS = 5_000;

function instanceIdOf(invocation: CliInvocation) {
  const instanceId = invocation.rawArgs?.[0]?.trim();
  if (!instanceId) throw usageError("CLI_ARGUMENT_MISSING", "Missing required argument <instanceId>.");
  return instanceId;
}

function outputModeBeforeDelimiter(context: CliContext) {
  const delimiter = context.commandLine.indexOf("--");
  const before = delimiter >= 0 ? context.commandLine.slice(0, delimiter) : context.commandLine;
  return before.find((token) => token === "--json" || token === "--table");
}

function execArgv(invocation: CliInvocation) {
  const argv = [...(invocation.rawArgs?.slice(1) ?? [])];
  if (argv.length === 0) {
    throw usageError("CLI_ARGUMENT_MISSING", "Missing remote command. Use `thctl instance exec <instanceId> -- <command...>`.");
  }
  return argv;
}

function terminalDimensions(context: CliContext) {
  const cols = context.terminal.stdout.columns ?? context.terminal.stdin.columns;
  const rows = context.terminal.stdout.rows ?? context.terminal.stdin.rows;
  return {
    cols: Number.isInteger(cols) && (cols as number) > 0 ? cols as number : 120,
    rows: Number.isInteger(rows) && (rows as number) > 0 ? rows as number : 40,
  };
}

function signalExitCode(signal: string) {
  if (process.platform === "win32") return 1;
  const number = (os.constants.signals as Record<string, number>)[signal];
  return Number.isInteger(number) ? 128 + number : CLI_EXIT_CODES.server;
}

function serverErrorExitCode(code: string) {
  if (["INSTANCE_SHELL_UNAUTHORIZED", "INSTANCE_SHELL_AUTH_REQUIRED"].includes(code)) return CLI_EXIT_CODES.notAuthenticated;
  if (["INSTANCE_SHELL_FORBIDDEN", "INSTANCE_SHELL_SCOPE_NOT_VISIBLE"].includes(code)) return CLI_EXIT_CODES.forbidden;
  if (["INSTANCE_SHELL_UNSUPPORTED", "INSTANCE_SHELL_CAPABILITY_MISSING"].includes(code)) return CLI_EXIT_CODES.capability;
  if (code === "INSTANCE_SHELL_PROTOCOL_ERROR") return CLI_EXIT_CODES.protocol;
  if (code === "INSTANCE_SHELL_LIMIT_REACHED") return CLI_EXIT_CODES.rateLimited;
  return CLI_EXIT_CODES.server;
}

function assertShellCapability(context: CliContext, capabilities: unknown, mode: ShellCommandMode, tty: boolean) {
  const shell = directoryInstanceShellCapabilities(capabilities);
  if (!shell) {
    throw capabilityMissingError(`instance ${mode}`, "instanceShell", { instanceShell: null });
  }
  if (shell.protocolVersion !== INSTANCE_SHELL_PROTOCOL_VERSION) {
    context.output.warn(
      `Instance Shell protocol ${shell.protocolVersion} differs from this CLI (${INSTANCE_SHELL_PROTOCOL_VERSION}); the feature is disabled.`,
    );
    throw capabilityMissingError(`instance ${mode}`, "instanceShell", {
      expectedProtocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
      actualProtocolVersion: shell.protocolVersion,
    });
  }
  const supported = mode === "interactive" ? shell.interactive : tty ? shell.execTty : shell.exec;
  if (!supported) {
    throw capabilityMissingError(`instance ${mode}${tty ? " --tty" : ""}`, tty ? "instanceShell.execTty" : `instanceShell.${mode}`, {
      capabilities: shell,
    });
  }
}

function assertInstanceReady(instanceId: string, entry: Awaited<ReturnType<Awaited<ReturnType<typeof openConnection>>["client"]["resources"]["instanceBoard"]>>[number]) {
  if (entry.status !== "running" || entry.connectionStatus !== "online" || !entry.ready) {
    throw new ThctlError(
      "CLI_INSTANCE_OFFLINE",
      `Controlled instance \`${instanceId}\` is not running and ready for interactive access.`,
      CLI_EXIT_CODES.conflict,
      { instanceId, status: entry.status, connectionStatus: entry.connectionStatus, ready: entry.ready },
    );
  }
}

function shellUrl(origin: string, instanceId: string) {
  const url = new URL(requestUrl(origin, controlledInstanceShellRoute(instanceId)));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function mapUpgradeRejection(status: number, path: string) {
  if (status === 404 || status === 405 || status === 501) return routeMissingError(status, "GET", path);
  if (status === 401) return new ThctlError("CLI_NOT_AUTHENTICATED", "The Control Plane rejected the Instance Shell credential (HTTP 401). Run `thctl login`.", CLI_EXIT_CODES.notAuthenticated, { status });
  if (status === 403) return new ThctlError("CLI_FORBIDDEN", "The Control Plane refused Instance Shell for this account (HTTP 403).", CLI_EXIT_CODES.forbidden, { status });
  if (status === 409) return new ThctlError("CLI_INSTANCE_SHELL_UNAVAILABLE", "The controlled instance is not currently available for Instance Shell (HTTP 409).", CLI_EXIT_CODES.conflict, { status });
  if (status === 400) return usageError("CLI_INSTANCE_SHELL_UPGRADE_REJECTED", "The Instance Shell WebSocket upgrade was rejected (HTTP 400).", { status });
  return networkError(`The Instance Shell WebSocket upgrade failed (HTTP ${status}).`, { status, path });
}

function closeCode(
  info: { code: number; reason: string },
  started: boolean,
) {
  if (info.code === 4001) {
    return new ThctlError("CLI_AUTHORIZATION_CHANGED", "Instance Shell closed because authorization or instance access changed.", CLI_EXIT_CODES.forbidden, info);
  }
  if (info.code === 1002 || info.code === 4400) {
    return protocolError("The instance closed Instance Shell because the protocol is incompatible.", info);
  }
  const reasonCode = info.reason.trim();
  if (reasonCode === "CONTROL_PLANE_AUTH_REQUIRED") {
    return new ThctlError("CLI_NOT_AUTHENTICATED", "The Control Plane rejected the Instance Shell credential. Run `thctl login`.", CLI_EXIT_CODES.notAuthenticated, info);
  }
  if (reasonCode === "CONTROL_PLANE_FORBIDDEN") {
    return new ThctlError("CLI_FORBIDDEN", "The Control Plane refused Instance Shell for this account.", CLI_EXIT_CODES.forbidden, info);
  }
  if (reasonCode === "CONTROL_PLANE_RESOURCE_NOT_VISIBLE") {
    return new ThctlError("CLI_INSTANCE_NOT_FOUND", "The controlled instance is not visible to this account.", CLI_EXIT_CODES.notFound, info);
  }
  if (reasonCode === "INSTANCE_SHELL_UNSUPPORTED") {
    return new ThctlError("CLI_CAPABILITY_MISSING", "The controlled instance does not support Instance Shell.", CLI_EXIT_CODES.capability, info);
  }
  if (["INSTANCE_SHELL_UNAVAILABLE", "INSTANCE_REGISTRATION_TOKEN_MISSING"].includes(reasonCode)) {
    return new ThctlError("CLI_INSTANCE_SHELL_UNAVAILABLE", "The controlled instance is not currently available for Instance Shell.", CLI_EXIT_CODES.conflict, info);
  }
  if (reasonCode === "INSTANCE_SHELL_PROTOCOL_ERROR") {
    return protocolError("The instance rejected the Instance Shell protocol.", info);
  }
  if (!started) {
    return networkError(
      `Instance Shell closed before the remote process started (code ${info.code}${info.reason ? `: ${info.reason}` : ""}).`,
      info,
    );
  }
  return networkError(
    `Instance Shell disconnected before reporting a process exit (code ${info.code}${info.reason ? `: ${info.reason}` : ""}).`,
    info,
  );
}

async function runShellWebSocket(context: CliContext, options: {
  instanceId: string;
  profileLabel: string;
  origin: string;
  authorization: string;
  mode: ShellCommandMode;
  tty: boolean;
  command?: readonly string[];
}) {
  assertActive(context.signal);
  const factory = context.createWebSocket ?? createControlPlaneWebSocket;
  const terminal = context.terminal;
  const interactive = options.mode === "interactive";
  const localTty = terminal.stdin.isTTY === true && terminal.stdout.isTTY === true;
  const shouldUseRawMode = localTty && options.tty;
  const route = controlledInstanceShellRoute(options.instanceId);
  const initialDimensions = terminalDimensions(context);
  let socket: CliWebSocket | undefined;
  let started = false;
  let settled = false;
  let rawMode = false;
  let stdinClosed = false;
  let resizeCleanup: (() => void) | undefined;
  let previousSignalHandler: CliContext["handleProcessSignal"];
  let signalWait: ReturnType<typeof setTimeout> | undefined;
  let lastDimensions = initialDimensions;

  const removeInputListeners = () => {
    terminal.stdin.removeListener("data", onInput as never);
    terminal.stdin.removeListener("end", onStdinEnd);
    terminal.stdin.removeListener("error", onStdinError);
  };
  const cleanup = () => {
    if (signalWait) clearTimeout(signalWait);
    signalWait = undefined;
    removeInputListeners();
    resizeCleanup?.();
    resizeCleanup = undefined;
    if (rawMode) {
      try {
        terminal.stdin.setRawMode?.(false);
      } catch {
        // Terminal reset continues below even when the stream already closed.
      }
      rawMode = false;
    }
    if (shouldUseRawMode) {
      try {
        terminal.stdout.write("\u001b[?25h");
      } catch {
        // The terminal may already be gone while the network cleanup continues.
      }
    }
    // A resumed TTY keeps the Node event loop alive after the remote socket and
    // listeners have gone away. Pause it while restoring raw mode so `exit` in
    // the remote shell terminates thctl, matching an SSH client.
    terminal.stdin.pause?.();
    context.handleProcessSignal = previousSignalHandler;
    try {
      socket?.close(1000, "thctl closed the instance shell.");
    } catch {
      // The socket may never have completed its upgrade.
    }
  };
  const finish = (error?: Error, exitCode?: number) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve({ exitCode: exitCode ?? CLI_EXIT_CODES.ok });
  };

  let resolve!: (outcome: { exitCode: number }) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<{ exitCode: number }>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  const send = (data: CliWebSocketData) => {
    if (!socket || settled) return;
    const pendingBytes = socket.bufferedAmount + (typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength);
    if (pendingBytes > INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES) {
      throw protocolError("The Instance Shell socket backlog exceeded the bounded limit.", {
        bufferedAmount: socket.bufferedAmount,
        frameBytes: pendingBytes - socket.bufferedAmount,
        maxBytes: INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES,
      });
    }
    socket.send(data);
  };
  const sendControl = (frame: Record<string, unknown>) => send(JSON.stringify(frame));
  const closeStdin = () => {
    if (stdinClosed || !started) return;
    stdinClosed = true;
    sendControl({ type: "stdin-close" });
  };
  const sendInput = (data: string | Uint8Array) => {
    if (!started || stdinClosed) return;
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    for (let offset = 0; offset < bytes.byteLength; offset += INSTANCE_SHELL_DATA_FRAME_MAX_BYTES) {
      const payload = bytes.subarray(offset, offset + INSTANCE_SHELL_DATA_FRAME_MAX_BYTES);
      if (payload.byteLength > 0) send(encodeInstanceShellBinaryFrame(InstanceShellDataChannel.Input, payload));
    }
  };
  function onInput(data: string | Uint8Array) {
    try {
      sendInput(data);
    } catch (error) {
      finish(error instanceof Error ? error : protocolError(String(error)));
    }
  }
  function onStdinEnd() {
    try {
      closeStdin();
    } catch (error) {
      finish(error instanceof Error ? error : networkError(String(error)));
    }
  }
  function onStdinError(error: Error) {
    finish(networkError(`Local stdin failed: ${error.message}`));
  }

  const resize = () => {
    if (!started || !options.tty) return;
    const next = terminalDimensions(context);
    if (next.cols === lastDimensions.cols && next.rows === lastDimensions.rows) return;
    lastDimensions = next;
    try {
      sendControl({ type: "resize", ...next });
    } catch (error) {
      finish(error instanceof Error ? error : protocolError(String(error)));
    }
  };

  const handleLocalSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (settled) return true;
    if (started && options.mode === "exec" && !options.tty) {
      try {
        sendControl({ type: "signal", signal });
      } catch (error) {
        finish(error instanceof Error ? error : protocolError(String(error)));
        return true;
      }
      if (!signalWait) {
        signalWait = setTimeout(() => finish(undefined, signalExitCode(signal)), REMOTE_SIGNAL_WAIT_MS);
      }
      return true;
    }
    finish(undefined, signalExitCode(signal));
    return true;
  };

  const attachTerminal = () => {
    if (shouldUseRawMode && !rawMode) {
      if (!terminal.stdin.setRawMode) {
        finish(usageError("CLI_INTERACTIVE_TERMINAL_UNAVAILABLE", "The local terminal cannot enter raw mode; use `instance exec` instead."));
        return;
      }
      try {
        terminal.stdin.setRawMode(true);
        rawMode = true;
      } catch (error) {
        finish(usageError("CLI_INTERACTIVE_TERMINAL_UNAVAILABLE", `The local terminal could not enter raw mode: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
    }

    terminal.stdin.on("data", onInput as never);
    terminal.stdin.on("end", onStdinEnd);
    terminal.stdin.on("error", onStdinError as never);
    terminal.stdin.resume?.();

    if (options.tty) {
      const onResize = () => resize();
      if (terminal.onResize) resizeCleanup = terminal.onResize(onResize);
      else {
        process.on("SIGWINCH", onResize);
        resizeCleanup = () => process.off("SIGWINCH", onResize);
      }
    }
    if (terminal.stdin.readableEnded) closeStdin();
  };

  previousSignalHandler = context.handleProcessSignal;
  context.handleProcessSignal = handleLocalSignal;

  try {
    socket = factory({
      url: shellUrl(options.origin, options.instanceId),
      authorization: options.authorization,
      subprotocols: [CONTROLLED_INSTANCE_SHELL_PROTOCOL],
      handlers: {
        opened: () => {
          if (settled) return;
          try {
            sendControl({
              type: "start",
              mode: options.mode,
              tty: options.tty,
              ...(options.mode === "exec" ? { command: [...options.command!] } : {}),
              ...(options.tty ? initialDimensions : {}),
            });
          } catch (error) {
            finish(error instanceof Error ? error : protocolError(String(error)));
          }
        },
        message: (data, isBinary) => {
          if (settled) return;
          try {
            if (isBinary) {
              if (!started || !(data instanceof Uint8Array)) {
                throw protocolError("The instance sent shell data before the process started.", { route });
              }
              const decoded = decodeInstanceShellBinaryFrame(data, "instance-to-client");
              const output = decoded.payload;
              if (decoded.channel === InstanceShellDataChannel.Output) context.output.streams.stdout(output);
              else context.output.streams.stderr(output);
              return;
            }
            const frame = parseInstanceShellServerControlFrame(String(data));
            if (frame.type === "started") {
              if (started) throw protocolError("The instance sent more than one started frame.", { route });
              if (frame.mode !== options.mode || frame.tty !== options.tty) {
                throw protocolError("The instance started a different shell mode than requested.", {
                  requested: { mode: options.mode, tty: options.tty },
                  actual: { mode: frame.mode, tty: frame.tty },
                });
              }
              started = true;
              attachTerminal();
              return;
            }
            if (frame.type === "error") {
              throw new ThctlError(frame.code, frame.message, serverErrorExitCode(frame.code), { route, frame: frame.type });
            }
            if (!started) throw protocolError("The instance reported an exit before the process started.", { route });
            if (frame.type === "exit") {
              finish(undefined, frame.code ?? signalExitCode(frame.signal!));
            }
          } catch (error) {
            if (error instanceof InstanceShellProtocolError) {
              finish(protocolError(error.message, { code: error.code, route }));
              return;
            }
            finish(error instanceof Error ? error : protocolError(String(error)));
          }
        },
        closed: (info) => {
          if (!settled) finish(closeCode(info, started));
        },
        failed: (error) => {
          if (!settled) finish(networkError(`Instance Shell connection failed: ${error.message}`, { route }));
        },
        rejected: (status) => {
          if (status === 401) context.store.secrets().remove(options.profileLabel);
          if (!settled) finish(mapUpgradeRejection(status, route));
        },
      },
    });
  } catch (error) {
    finish(error instanceof Error ? error : networkError(String(error)));
  }

  const abort = () => finish(new ThctlError("CLI_CANCELLED", "Instance Shell was cancelled.", CLI_EXIT_CODES.cancelled));
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    const outcome = await result;
    return outcome.exitCode;
  } finally {
    context.signal.removeEventListener("abort", abort);
  }
}

async function instanceShellCommand(context: CliContext, invocation: CliInvocation, mode: ShellCommandMode) {
  const requestedOutput = outputModeBeforeDelimiter(context);
  if (requestedOutput) {
    throw usageError(
      "CLI_OUTPUT_MODE_UNSUPPORTED",
      `Instance Shell streams raw command output and does not support \`${requestedOutput}\`.`,
      { option: requestedOutput },
    );
  }

  const instanceId = instanceIdOf(invocation);
  const tty = mode === "interactive" || invocation.options.tty === true;
  if (mode === "interactive" && !(context.terminal.stdin.isTTY === true && context.terminal.stdout.isTTY === true)) {
    throw usageError(
      "CLI_INTERACTIVE_TTY_REQUIRED",
      "`thctl instance shell` requires stdin and stdout to be TTYs. Use `thctl instance exec` for piped or one-shot commands.",
    );
  }
  const command = mode === "exec" ? execArgv(invocation) : undefined;

  const connection = await openConnection(context);
  const entries = await connection.client.resources.instanceBoard(context.signal);
  const entry = entries.find((candidate) => candidate.id === instanceId);
  if (!entry) {
    throw new ThctlError("CLI_INSTANCE_NOT_FOUND", `No controlled instance \`${instanceId}\` is visible to this account.`, CLI_EXIT_CODES.notFound, { instanceId });
  }
  assertShellCapability(context, entry.capabilities, mode, tty);
  assertInstanceReady(instanceId, entry);

  const credential = context.store.secrets().read(connection.profile.label);
  if (!credential) {
    throw new ThctlError("CLI_NOT_AUTHENTICATED", `No CLI session stored for \`${connection.profile.label}\`. Run \`thctl login\`.`, CLI_EXIT_CODES.notAuthenticated);
  }
  return runShellWebSocket(context, {
    instanceId,
    profileLabel: connection.profile.label,
    origin: connection.profile.origin,
    authorization: `Bearer ${credential.sessionToken}`,
    mode,
    tty,
    ...(command ? { command } : {}),
  });
}

export async function instanceShell(context: CliContext, invocation: CliInvocation) {
  return { exitCode: await instanceShellCommand(context, invocation, "interactive") };
}

export async function instanceExec(context: CliContext, invocation: CliInvocation) {
  return { exitCode: await instanceShellCommand(context, invocation, "exec") };
}
