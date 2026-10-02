import { loginToProfile } from "../login.ts";
import { CLI_EXIT_CODES, ThctlError } from "../errors.ts";
import { openConnection, resolveProfile, type CliContext, type CliInvocation } from "../runtime.ts";

export async function loginCommand(context: CliContext, invocation: CliInvocation) {
  const profile = await resolveProfile(context);
  const mode = invocation.options.device ? "device" : "browser";
  const result = await loginToProfile({
    profileLabel: profile.label,
    mode,
    store: context.store,
    fetchImpl: context.fetchImpl,
    output: context.output,
    openUrl: context.openUrl,
    sleep: context.sleep,
  });
  return {
    data: { profile: result.profile.label, sessionId: result.session.id, expiresAt: result.session.expiresAt, loginMode: mode },
    message: `Signed in to ${result.profile.origin} as ${result.session.user.primaryUsername || result.session.user.displayName}.`,
  };
}

export async function logoutCommand(context: CliContext) {
  const profile = await resolveProfile(context);
  const credential = context.store.secrets().read(profile.label);
  if (!credential) {
    return { data: { profile: profile.label, revoked: false }, message: `No stored CLI session for \`${profile.label}\`.` };
  }
  let revoked = false;
  try {
    const connection = await openConnection(context, { profile });
    const result = await connection.client.auth.logoutCli();
    revoked = result.ok;
  } catch (error) {
    // 服务端已经拒绝这个会话时注销仍然要成功：本地凭证必须被清掉。
    if (!(error instanceof ThctlError) || error.exitCode !== CLI_EXIT_CODES.notAuthenticated) throw error;
  } finally {
    context.store.secrets().remove(profile.label);
  }
  return {
    data: { profile: profile.label, revoked },
    message: revoked ? `Signed out of ${profile.origin}.` : `Local CLI credentials for \`${profile.label}\` were cleared.`,
  };
}

export async function whoamiCommand(context: CliContext) {
  const profile = await resolveProfile(context);
  const connection = await openConnection(context, { profile });
  const credential = context.store.secrets().read(profile.label);
  const session = await connection.client.auth.session();
  if (!session.authenticated || !session.user) {
    throw new ThctlError("CLI_NOT_AUTHENTICATED", `The stored CLI session for \`${profile.label}\` is not valid. Run \`thctl login\`.`, CLI_EXIT_CODES.notAuthenticated);
  }
  const data = {
    profile: profile.label,
    origin: profile.origin,
    controlPlaneId: connection.identity.payload.controlPlaneId,
    protocolVersion: connection.identity.payload.protocolVersion,
    user: session.user,
    authorization: session.authorization,
    ...(credential?.mode ? { sessionMode: credential.mode } : {}),
    ...(credential?.sessionId ? { sessionId: credential.sessionId } : {}),
    ...(credential?.expiresAt ? { sessionExpiresAt: credential.expiresAt } : {}),
  };
  const localTrust = credential?.mode === "local-trust";
  return {
    data,
    columns: [
      { key: "profile", header: "profile" },
      { key: "origin", header: "origin" },
      { key: "controlPlaneId", header: "controlPlaneId" },
      { key: "sessionExpiresAt", header: "expires" },
    ],
    message: localTrust
      ? `Connected to the local Control Plane at ${profile.origin} as ${session.user.displayName} (local trust session).`
      : `Signed in to ${profile.origin} as ${session.user.primaryUsername || session.user.displayName}.`,
  };
}
