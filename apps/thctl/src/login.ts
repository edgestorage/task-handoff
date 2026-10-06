import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import type { CliProfileStore } from "./config.ts";
import { cliClientInfo } from "./client-info.ts";
import { ThctlError, CLI_EXIT_CODES, protocolError } from "./errors.ts";
import { connectToControlPlane, type ThctlConnection } from "./control-plane.ts";
import type { CliOutput } from "./output.ts";

const LOOPBACK_ATTEMPTS = 5;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export type CliLoginMode = "browser" | "device";

export type LoopbackCallback = {
  redirectUri: string;
  port: number;
  waitForCode: Promise<{ code: string; state: string }>;
  close: () => void;
};

function callbackPage(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b0c;color:#f5f5f5">`
    + `<main style="max-width:32rem;padding:2rem;text-align:center"><h1 style="font-size:1.1rem;font-weight:500">${title}</h1><p style="color:#a1a1aa;font-size:.9rem">${body}</p></main></body></html>`;
}

/** 只在 loopback 上接收一次性授权 code；端口随机，路径固定为 /callback。 */
export async function startLoopbackCallback(): Promise<LoopbackCallback> {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOOPBACK_ATTEMPTS; attempt += 1) {
    const server = http.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      lastError = error;
      server.close();
      continue;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      lastError = new Error("Loopback callback did not expose a TCP port.");
      continue;
    }
    let settle: (value: { code: string; state: string }) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const waitForCode = new Promise<{ code: string; state: string }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // 超时或取消后没人再 await 这个 promise，先挂一个兜底处理避免未处理的 rejection。
    void waitForCode.catch(() => {});
    let settled = false;
    server.on("request", (request, response) => {
      const url = new URL(request.url || "/", `http://127.0.0.1:${address.port}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const failure = url.searchParams.get("error") || "";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (failure) {
        response.end(callbackPage("Authorization failed", `The Control Plane reported ${failure}. Return to the terminal and try again.`));
        if (!settled) {
          settled = true;
          fail(new ThctlError("CLI_AUTHORIZATION_FAILED", `The Control Plane rejected the CLI authorization: ${failure}.`, CLI_EXIT_CODES.notAuthenticated));
        }
        return;
      }
      if (!code || !state) {
        response.end(callbackPage("Authorization failed", "The callback did not include a usable authorization code. Return to the terminal and try again."));
        if (!settled) {
          settled = true;
          fail(protocolError("The loopback callback did not include a code and state."));
        }
        return;
      }
      response.end(callbackPage("Authorization complete", "You can close this tab and return to the terminal."));
      if (!settled) {
        settled = true;
        settle({ code, state });
      }
    });
    return {
      port: address.port,
      redirectUri: `http://127.0.0.1:${address.port}/callback`,
      waitForCode,
      close: () => {
        if (!settled) {
          settled = true;
          fail(new ThctlError("CLI_LOGIN_CANCELLED", "The CLI login was cancelled.", CLI_EXIT_CODES.cancelled));
        }
        server.close();
        server.closeAllConnections?.();
      },
    };
  }
  throw new ThctlError(
    "CLI_LOOPBACK_UNAVAILABLE",
    `Could not bind a local callback port (${lastError instanceof Error ? lastError.message : String(lastError)}). Retry with \`thctl login --device\` to authorize from another device.`,
    CLI_EXIT_CODES.network,
  );
}

export function createPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

export function createState() {
  return crypto.randomBytes(24).toString("base64url");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 打开浏览器失败不算致命错误：授权 URL 已经打印给用户。 */
export function openInBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: process.platform !== "win32" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

type LoginDependencies = {
  store: CliProfileStore;
  fetchImpl: typeof fetch;
  output: CliOutput;
  openUrl?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  loginTimeoutMs?: number;
  pollIntervalMs?: number;
};

async function authorizationConnection(options: {
  store: CliProfileStore;
  profileLabel: string;
  fetchImpl: typeof fetch;
}) {
  const profile = options.store.select(options.profileLabel);
  return connectToControlPlane({ store: options.store, profile, fetchImpl: options.fetchImpl, withSession: false });
}

export async function storeCliSession(
  connection: ThctlConnection,
  session: { sessionToken: string; session: { id: string; expiresAt: string }; },
  loginMode: CliLoginMode,
) {
  connection.store.secrets().write(connection.profile.label, {
    sessionToken: session.sessionToken,
    sessionId: session.session.id,
    expiresAt: session.session.expiresAt,
    mode: "authorization",
    savedAt: new Date().toISOString(),
  });
  connection.store.save({ ...connection.profile, loginMode, lastUsedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

export async function loginWithBrowser(dependencies: LoginDependencies & { profileLabel: string }) {
  const { store, fetchImpl, output } = dependencies;
  // 先完成身份与能力校验，再占用本地端口；失败时不该留下监听中的回调服务。
  const connection = await authorizationConnection({ store, profileLabel: dependencies.profileLabel, fetchImpl });
  const loopback = await startLoopbackCallback();
  const { verifier, challenge } = createPkce();
  const state = createState();
  try {
    const authorization = await connection.client.auth.cliAuthorize({
      mode: "browser",
      client: cliClientInfo(),
      redirectUri: loopback.redirectUri,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (authorization.mode !== "browser") throw protocolError("The Control Plane returned a device authorization for a browser request.");
    output.message(`Open this URL to approve the CLI session:\n${authorization.verificationUri}`);
    try {
      await (dependencies.openUrl ?? openInBrowser)(authorization.verificationUri);
    } catch {
      output.warn("Could not open a browser automatically; open the URL above manually.");
    }
    const timeoutMs = dependencies.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    const callback = await withTimeout(
      loopback.waitForCode,
      timeoutMs,
      () => new ThctlError("CLI_LOGIN_TIMEOUT", "Timed out waiting for the browser authorization.", CLI_EXIT_CODES.cancelled),
    );
    if (callback.state !== state) {
      throw new ThctlError("CLI_LOGIN_STATE_MISMATCH", "The browser callback state did not match this login attempt. The authorization code was discarded.", CLI_EXIT_CODES.identity);
    }
    const token = await connection.client.auth.cliToken({
      grantType: "authorization_code",
      requestId: authorization.requestId,
      code: callback.code,
      codeVerifier: verifier,
    });
    await storeCliSession(connection, token, "browser");
    return { profile: connection.profile, session: token.session };
  } finally {
    loopback.close();
  }
}

export async function loginWithDevice(dependencies: LoginDependencies & { profileLabel: string }) {
  const { store, fetchImpl, output } = dependencies;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const connection = await authorizationConnection({
    store,
    profileLabel: dependencies.profileLabel,
    fetchImpl,
  });
  const authorization = await connection.client.auth.cliAuthorize({ mode: "device", client: cliClientInfo() });
  if (authorization.mode !== "device") throw protocolError("The Control Plane returned a browser authorization for a device request.");
  output.message(`Open this URL on any device and confirm the code:\n${authorization.verificationUri}\nUser code: ${authorization.userCode}`);
  let intervalMs = Math.max(1, authorization.intervalSeconds) * 1_000;
  const expiresAt = Date.parse(authorization.expiresAt);
  for (;;) {
    if (Date.now() >= expiresAt) {
      throw new ThctlError("CLI_AUTHORIZATION_EXPIRED", "The device authorization expired before it was approved. Run `thctl login --device` again.", CLI_EXIT_CODES.notAuthenticated);
    }
    await sleep(dependencies.pollIntervalMs ?? intervalMs);
    try {
      const token = await connection.client.auth.cliToken({ grantType: "urn:ietf:params:oauth:grant-type:device_code", requestId: authorization.requestId });
      await storeCliSession(connection, token, "device");
      return { profile: connection.profile, session: token.session };
    } catch (error) {
      if (!(error instanceof ThctlError)) throw error;
      if (error.code === "CLI_AUTHORIZATION_PENDING") continue;
      if (error.code === "CLI_AUTHORIZATION_SLOW_DOWN") {
        const suggested = Number((error.details as { intervalSeconds?: unknown } | undefined)?.intervalSeconds);
        intervalMs = Math.max(intervalMs + 5_000, Number.isFinite(suggested) ? suggested * 1_000 : 0);
        continue;
      }
      throw error;
    }
  }
}

export async function loginToProfile(dependencies: LoginDependencies & { profileLabel: string; mode: CliLoginMode }) {
  if (dependencies.mode === "device") return loginWithDevice(dependencies);
  return loginWithBrowser(dependencies);
}
