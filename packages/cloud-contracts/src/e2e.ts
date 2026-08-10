import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./common.ts";
import { AccessTicketSchema, type AccessTicket } from "./relay.ts";

export const ClientHelloSchema = z.object({
  ticketId: z.string().trim().min(3).max(160),
  deviceSessionId: z.string().trim().min(3).max(160),
  clientEphemeralPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const HandshakeResponseSchema = z.object({
  serverEphemeralPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  transcript: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export type ClientHello = z.infer<typeof ClientHelloSchema>;
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

interface ClientPrivateState {
  privateKey: KeyObject;
  ticket: AccessTicket;
}

export function beginClientHandshake(ticket: AccessTicket): { privateState: ClientPrivateState; hello: ClientHello } {
  const keyPair = generateKeyPairSync("x25519");
  const clientEphemeralPublicKey = jwkX(keyPair.publicKey);
  return { privateState: { privateKey: keyPair.privateKey, ticket }, hello: { ticketId: ticket.ticketId, deviceSessionId: ticket.deviceSessionId, clientEphemeralPublicKey } };
}

export function acceptControlPlaneHandshake(input: {
  ticket: unknown;
  clientHello: unknown;
  controlPlaneFingerprint: string;
  controlPlanePrivateKey: KeyObject | string | Buffer;
}): { sessionKey: Buffer; response: HandshakeResponse } {
  const ticket = AccessTicketSchema.parse(input.ticket);
  const clientHello = ClientHelloSchema.parse(input.clientHello);
  if (ticket.ticketId !== clientHello.ticketId || ticket.deviceSessionId !== clientHello.deviceSessionId || ticket.targetPublicKeyFingerprint !== input.controlPlaneFingerprint) throw handshakeError();
  const keyPair = generateKeyPairSync("x25519");
  const serverEphemeralPublicKey = jwkX(keyPair.publicKey);
  const transcript = transcriptHash(ticket, clientHello.clientEphemeralPublicKey, serverEphemeralPublicKey);
  const sharedSecret = diffieHellman({ privateKey: keyPair.privateKey, publicKey: x25519PublicKey(clientHello.clientEphemeralPublicKey) });
  const sessionKey = deriveSessionKey(sharedSecret, transcript);
  return { sessionKey, response: { serverEphemeralPublicKey, transcript, signature: sign(null, Buffer.from(transcript), input.controlPlanePrivateKey).toString("base64url") } };
}

export function finishClientHandshake(privateState: ClientPrivateState, rawResponse: unknown, controlPlanePublicKey: KeyObject | string): Buffer {
  const response = HandshakeResponseSchema.parse(rawResponse);
  const publicKey = typeof controlPlanePublicKey === "string" ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: controlPlanePublicKey }, format: "jwk" }) : controlPlanePublicKey;
  const expected = transcriptHash(privateState.ticket, jwkX(createPublicKey(privateState.privateKey)), response.serverEphemeralPublicKey);
  if (response.transcript !== expected || !verify(null, Buffer.from(expected), publicKey, Buffer.from(response.signature, "base64url"))) throw handshakeError();
  const sharedSecret = diffieHellman({ privateKey: privateState.privateKey, publicKey: x25519PublicKey(response.serverEphemeralPublicKey) });
  return deriveSessionKey(sharedSecret, expected);
}

function transcriptHash(ticket: AccessTicket, clientKey: string, serverKey: string): string {
  return createHash("sha256").update(canonicalJson({ audience: ticket.audience, ticketId: ticket.ticketId, accountId: ticket.accountId, deviceSessionId: ticket.deviceSessionId, controlPlaneId: ticket.controlPlaneId, bindingId: ticket.bindingId, bindingRevision: ticket.bindingRevision, nonce: ticket.nonce, clientEphemeralPublicKey: clientKey, serverEphemeralPublicKey: serverKey })).digest("base64url");
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
