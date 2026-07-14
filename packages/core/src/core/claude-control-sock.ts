import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PROTO = 1;
const SHORT_RE = /^[a-f0-9]{8}$/;

export type ClaudeDaemonJob = {
  short?: string;
  nonce?: string;
  sessionId?: string;
  pid?: number;
  attempt?: number;
  startedAt?: number;
  cwd?: string;
  backend?: string;
  tempo?: string;
  state?: string;
  detail?: string;
  intent?: string;
  cliVersion?: string;
  source?: string;
};

export type ClaudeControlResponse = {
  ok?: boolean;
  op?: string;
  code?: string;
  error?: string;
  jobs?: ClaudeDaemonJob[];
  present?: boolean;
  alive?: boolean;
  [key: string]: unknown;
};

export type ClaudeControlOptions = {
  sockPath?: string;
  timeoutMs?: number;
};

export function claudeControlSocketDir(env: NodeJS.ProcessEnv = process.env) {
  const uid = process.getuid?.() ?? 0;
  const tmp = env.TERMUX_VERSION && env.PREFIX ? path.join(env.PREFIX, "tmp") : "/tmp";
  const claudeConfig = (env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")).normalize("NFC");
  const hash = crypto.createHash("sha256").update(path.resolve(claudeConfig)).digest("hex").slice(0, 8);
  return path.join(tmp, `cc-daemon-${uid}`, hash);
}

export function claudeControlSock(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAUDE_CONTROL_SOCK || path.join(claudeControlSocketDir(env), "control.sock");
}

export function newClaudeShort() {
  return crypto.randomBytes(4).toString("hex");
}

export function callClaudeControl(req: Record<string, unknown>, options: ClaudeControlOptions = {}) {
  const sockPath = options.sockPath || claudeControlSock();
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise<ClaudeControlResponse>((resolve) => {
    let socket: net.Socket;
    try {
      socket = net.connect(sockPath);
    } catch (error) {
      resolve({ ok: false, code: "ENOCONN", error: String(error) });
      return;
    }
    let settled = false;
    let buffer = "";
    const done = (value: ClaudeControlResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, code: "ETIMEOUT", error: "control socket timeout" }));
    socket.on("error", (error) => done({ ok: false, code: "ENOCONN", error: String(error) }));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ proto: PROTO, ...req })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      try {
        done(JSON.parse(line) as ClaudeControlResponse);
      } catch (error) {
        done({ ok: false, code: "EBADJSON", error: String(error), raw: line });
      }
    });
    socket.once("close", () => {
      if (!settled) {
        done({ ok: false, code: "ENOCONN", error: "connection dropped mid-request" });
      }
    });
  });
}

export function listClaudeDaemonJobs(options?: ClaudeControlOptions) {
  return callClaudeControl({ op: "list" }, options);
}

export function hasClaudeDaemonJob(short: string, options?: ClaudeControlOptions) {
  assertClaudeShort(short);
  return callClaudeControl({ op: "has", short }, options);
}

export function replyClaudeDaemonJob(short: string, text: string, options?: ClaudeControlOptions) {
  assertClaudeShort(short);
  return callClaudeControl({ op: "reply", short, text }, options);
}

export function killClaudeDaemonJob(short: string, signal = "SIGTERM", options?: ClaudeControlOptions) {
  assertClaudeShort(short);
  return callClaudeControl({ op: "kill", short, signal }, options);
}

export function subscribeClaudeDaemonJob(
  short: string,
  {
    tail,
    onMessage,
    options = {},
  }: {
    tail?: number;
    onMessage?: (message: Record<string, unknown>) => void;
    options?: ClaudeControlOptions;
  } = {},
) {
  assertClaudeShort(short);
  const socket = net.connect(options.sockPath || claudeControlSock());
  let buffer = "";
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ proto: PROTO, op: "subscribe", short, tail })}\n`);
  });
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          onMessage?.(JSON.parse(line) as Record<string, unknown>);
        } catch {
          onMessage?.({ raw: line });
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => {});
  return () => socket.destroy();
}

function assertClaudeShort(short: string) {
  if (!SHORT_RE.test(short)) {
    throw new Error(`Claude worker short id must be 8 hex chars: ${short}`);
  }
}
