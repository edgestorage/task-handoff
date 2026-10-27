import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import {
  CLOUD_CLIENT_HANDSHAKE_AUDIENCE,
  CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
  ClientHelloSchema,
  HandshakeResponseSchema,
  cloudClientTranscriptSigningInput,
  type ClientHello,
  type HandshakeResponse,
} from "./device-auth.ts";
import type { AccessTicket } from "./relay.ts";
import type { RelaySessionGrant, RelaySessionTranscriptTicket } from "./relay-session.ts";

export { ClientHelloSchema, HandshakeResponseSchema, type ClientHello, type HandshakeResponse } from "./device-auth.ts";

interface ClientPrivateState {
  privateKey: KeyObject;
  ticket: AccessTicket | RelaySessionTranscriptTicket;
  grant?: RelaySessionGrant;
}

type RelayTranscriptCredential = AccessTicket | RelaySessionTranscriptTicket;

/** Inputs that may only be produced after the device-auth signature was verified. */
export type AuthenticatedClientHandshake = {
  ticket: RelayTranscriptCredential;
  grant?: RelaySessionGrant;
  clientEphemeralPublicKey: string;
};

export function beginClientHandshake(ticket: AccessTicket | RelaySessionTranscriptTicket, grant?: RelaySessionGrant): { privateState: ClientPrivateState; hello: ClientHello } {
  const keyPair = generateKeyPairSync("x25519");
  const clientEphemeralPublicKey = jwkX(keyPair.publicKey);
  return { privateState: { privateKey: keyPair.privateKey, ticket, grant }, hello: { ticketId: transcriptTicketId(ticket), deviceSessionId: ticket.deviceSessionId, clientEphemeralPublicKey } };
}

export function acceptControlPlaneHandshake(input: {
  authenticated: AuthenticatedClientHandshake;
  controlPlaneFingerprint: string;
  controlPlanePrivateKey: KeyObject | string | Buffer;
}): { sessionKey: Buffer; response: HandshakeResponse } {
  const { ticket, grant, clientEphemeralPublicKey } = input.authenticated;
  if (ticket.targetPublicKeyFingerprint !== input.controlPlaneFingerprint) throw handshakeError();
  const keyPair = generateKeyPairSync("x25519");
  const serverEphemeralPublicKey = jwkX(keyPair.publicKey);
  const transcript = transcriptHash(ticket, grant, clientEphemeralPublicKey, serverEphemeralPublicKey);
  const sharedSecret = diffieHellman({ privateKey: keyPair.privateKey, publicKey: x25519PublicKey(clientEphemeralPublicKey) });
  const sessionKey = deriveSessionKey(sharedSecret, transcript);
  const publicKey = createPublicKey(input.controlPlanePrivateKey).export({ format: "jwk" }).x;
  if (!publicKey) throw handshakeError();
  return {
    sessionKey,
    response: HandshakeResponseSchema.parse({
      protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
      audience: CLOUD_CLIENT_HANDSHAKE_AUDIENCE,
      state: "accepted",
      controlPlaneId: ticket.controlPlaneId,
      bindingId: ticket.bindingId,
      ticketId: transcriptTicketId(ticket),
      deviceSessionId: ticket.deviceSessionId,
      controlPlanePublicKey: publicKey,
      serverEphemeralPublicKey,
      transcript,
      signature: sign(null, Buffer.from(transcript), input.controlPlanePrivateKey).toString("base64url"),
    }),
  };
}

export function finishClientHandshake(privateState: ClientPrivateState, rawResponse: unknown, controlPlanePublicKey: KeyObject | string): Buffer {
  const response = HandshakeResponseSchema.parse(rawResponse);
  const publicKey = typeof controlPlanePublicKey === "string" ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: controlPlanePublicKey }, format: "jwk" }) : controlPlanePublicKey;
  const expectedPublicKey = publicKey.export({ format: "jwk" }).x;
  if (!expectedPublicKey || response.controlPlanePublicKey !== expectedPublicKey
    || response.ticketId !== transcriptTicketId(privateState.ticket)
    || response.deviceSessionId !== privateState.ticket.deviceSessionId) throw handshakeError();
  const expected = transcriptHash(privateState.ticket, privateState.grant, jwkX(createPublicKey(privateState.privateKey)), response.serverEphemeralPublicKey);
  if (response.transcript !== expected || !verify(null, Buffer.from(expected), publicKey, Buffer.from(response.signature, "base64url"))) throw handshakeError();
  const sharedSecret = diffieHellman({ privateKey: privateState.privateKey, publicKey: x25519PublicKey(response.serverEphemeralPublicKey) });
  return deriveSessionKey(sharedSecret, expected);
}

function transcriptHash(ticket: RelayTranscriptCredential, grant: RelaySessionGrant | undefined, clientKey: string, serverKey: string): string {
  return createHash("sha256").update(cloudClientTranscriptSigningInput({ ticket, ...(grant === undefined ? {} : { grant }), clientEphemeralPublicKey: clientKey, serverEphemeralPublicKey: serverKey })).digest("base64url");
}

function transcriptTicketId(ticket: RelayTranscriptCredential): string {
  return "ticketId" in ticket ? ticket.ticketId : ticket.transcriptTicketId;
}

function deriveSessionKey(sharedSecret: NodeJS.ArrayBufferView, transcript: string): Buffer {
  return createHash("sha256").update(sharedSecret).update(transcript).update("task-handoff:control-plane-access:e2e:v1").digest();
}

function x25519PublicKey(x: string): KeyObject { return createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" }); }

function jwkX(key: KeyObject): string {
  const x = key.export({ format: "jwk" }).x;
  if (!x) throw handshakeError();
  return x;
}

function handshakeError(): Error & { code: string } {
  return Object.assign(new Error("End-to-end handshake is invalid."), { code: "E2E_HANDSHAKE_INVALID" });
}
