import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import type { EncryptedRelayChannel, RelayChannelFactory } from './relay-transport';
import { MobileControlPlaneTransportError } from './transport';

type SocketLike = { readyState: number; bufferedAmount?: number; addEventListener(type: 'open'|'message'|'error'|'close', listener: (event: { data?: unknown }) => void): void; send(data: string): void; close(code?: number, reason?: string): void };
type SocketFactory = (url: string) => SocketLike;

export function createMobileRelayChannelFactory(options: { webSocketFactory?: SocketFactory; allowRelayUrl?: (url: URL) => boolean } = {}): RelayChannelFactory {
  return async (input) => {
    const ticket = input.ticket as any;
    const url = new URL(input.relayUrl);
    if (url.protocol !== 'wss:' || !(options.allowRelayUrl ?? cloudRelayUrl)(url)) throw relayError('UNTRUSTED_RELAY_URL');
    const socket = (options.webSocketFactory ?? ((target) => new WebSocket(target) as unknown as SocketLike))(url.toString());
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: 'attach', capability: input.clientAttach }));
    const attached = await nextMessage(socket, (value) => value?.type === 'attached');
    const keyPair = nacl.box.keyPair();
    const hello = { ticketId: ticket.ticketId, deviceSessionId: ticket.deviceSessionId, clientEphemeralPublicKey: base64Url(keyPair.publicKey) };
    let sendSequence = 0;
    socket.send(JSON.stringify({ type: 'frame', frame: { protocolVersion: '2026-08-10', channelId: attached.channelId, sequence: sendSequence++, kind: 'handshake', ciphertext: base64Url(new TextEncoder().encode(JSON.stringify(hello))) } }));
    const handshakeFrame = await nextMessage(socket, (value) => value?.type === 'frame' && value.frame?.kind === 'handshake');
    const response = JSON.parse(new TextDecoder().decode(fromBase64Url(handshakeFrame.frame.ciphertext)));
    const identityKey = fromBase64Url(response.controlPlanePublicKey);
    const fingerprint = `sha256:${base64Url(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, identityKey)))}`;
    const transcript = await transcriptHash(ticket, hello.clientEphemeralPublicKey, response.serverEphemeralPublicKey);
    if (fingerprint !== input.targetPublicKeyFingerprint || response.transcript !== transcript || !nacl.sign.detached.verify(new TextEncoder().encode(transcript), fromBase64Url(response.signature), identityKey)) throw relayError('RELAY_E2E_IDENTITY_INVALID');
    const shared = nacl.box.before(fromBase64Url(response.serverEphemeralPublicKey), keyPair.secretKey);
    const sessionKey = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, concat(shared, new TextEncoder().encode(transcript), new TextEncoder().encode('task-handoff:control-plane-access:e2e:v1'))));
    return new WebSocketEncryptedRelayChannel(socket, attached.channelId, sessionKey, sendSequence);
  };
}

export function allowCloudRelayUrlForService(url: URL, serviceOrigin: string, allowIsolatedEnvironment = false) {
  if (cloudRelayUrl(url)) return true;
  if (!allowIsolatedEnvironment) return false;
  const service = new URL(serviceOrigin);
  return service.hostname !== 'cloud.thandoff.com' && url.hostname === service.hostname;
}

class WebSocketEncryptedRelayChannel implements EncryptedRelayChannel {
  private readonly listeners = new Set<(value: any) => void>(); private readonly closeListeners = new Set<(error?: unknown) => void>(); private sendCounter = 0; private receiveCounter = 0; private receiveSequence = 1;
  constructor(private readonly socket: SocketLike, private readonly channelId: string, private readonly key: Uint8Array, private sendSequence: number) {
    socket.addEventListener('message', (event) => this.receive(event.data)); socket.addEventListener('error', () => this.closed(relayError('RELAY_SOCKET_ERROR', true))); socket.addEventListener('close', () => this.closed());
  }
  send(value: any) { if (this.socket.readyState !== 1 || (this.socket.bufferedAmount ?? 0) > 2 * 1024 * 1024) throw relayError('RELAY_BACKPRESSURE_LIMIT', true); const plaintext = new TextEncoder().encode(JSON.stringify(value)); const sealed = nacl.secretbox(plaintext, nonce(1, this.sendCounter++), this.key); this.socket.send(JSON.stringify({ type: 'frame', frame: { protocolVersion: '2026-08-10', channelId: this.channelId, sequence: this.sendSequence++, kind: value.type === 'cancel' ? 'cancel' : 'data', ciphertext: base64Url(sealed) } })); }
  close(code=1000,reason='normal'){this.socket.close(code,reason)}
  subscribe(listener:(value:any)=>void,onClose:(error?:unknown)=>void){this.listeners.add(listener);this.closeListeners.add(onClose);return()=>{this.listeners.delete(listener);this.closeListeners.delete(onClose)}}
  private receive(raw:unknown){try{const value=JSON.parse(String(raw));const frame=value.frame;if(value.type!=='frame'||frame.channelId!==this.channelId||frame.sequence!==this.receiveSequence++)throw relayError('RELAY_FRAME_SEQUENCE_INVALID');const opened=nacl.secretbox.open(fromBase64Url(frame.ciphertext),nonce(2,this.receiveCounter++),this.key);if(!opened)throw relayError('RELAY_E2E_DECRYPT_FAILED');const envelope=JSON.parse(new TextDecoder().decode(opened));for(const listener of this.listeners)listener(envelope)}catch(error){this.closed(error);this.socket.close(4400,'protocol-error')}}
  private closed(error?:unknown){for(const listener of this.closeListeners)listener(error);this.listeners.clear();this.closeListeners.clear()}
}

function cloudRelayUrl(url:URL){return url.hostname==='relay.thandoff.com'||url.hostname.endsWith('.relay.thandoff.com')}
function waitForOpen(socket:SocketLike){return new Promise<void>((resolve,reject)=>{socket.addEventListener('open',()=>resolve());socket.addEventListener('error',()=>reject(relayError('RELAY_SOCKET_FAILED',true)));socket.addEventListener('close',()=>reject(relayError('RELAY_SOCKET_CLOSED',true)))})}
function nextMessage(socket:SocketLike,predicate:(value:any)=>boolean){return new Promise<any>((resolve,reject)=>{const message=(event:{data?:unknown})=>{try{const value=JSON.parse(String(event.data));if(predicate(value))resolve(value)}catch{reject(relayError('RELAY_PROTOCOL_INVALID'))}};socket.addEventListener('message',message);socket.addEventListener('error',()=>reject(relayError('RELAY_SOCKET_FAILED',true)));socket.addEventListener('close',()=>reject(relayError('RELAY_SOCKET_CLOSED',true)))})}
async function transcriptHash(ticket:any,clientKey:string,serverKey:string){const canonical=canonicalJson({audience:ticket.audience,ticketId:ticket.ticketId,accountId:ticket.accountId,deviceSessionId:ticket.deviceSessionId,controlPlaneId:ticket.controlPlaneId,bindingId:ticket.bindingId,bindingRevision:ticket.bindingRevision,nonce:ticket.nonce,clientEphemeralPublicKey:clientKey,serverEphemeralPublicKey:serverKey});return base64Url(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256,new TextEncoder().encode(canonical))))}
function canonicalJson(value:any):string{if(Array.isArray(value))return`[${value.map(canonicalJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;return JSON.stringify(value)}
function nonce(direction:number,counter:number){const value=new Uint8Array(24);value[0]=direction;for(let index=0;index<6;index+=1)value[23-index]=(counter/(2**(8*index)))&255;return value}
function concat(...values:Uint8Array[]){const length=values.reduce((sum,value)=>sum+value.length,0);const result=new Uint8Array(length);let offset=0;for(const value of values){result.set(value,offset);offset+=value.length}return result}
function base64Url(value:Uint8Array){let binary='';for(const byte of value)binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')}
function fromBase64Url(value:string){const normalized=value.replace(/-/g,'+').replace(/_/g,'/');const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4));return Uint8Array.from(binary,(char)=>char.charCodeAt(0))}
function relayError(code:string,retryable=false){return new MobileControlPlaneTransportError(code,'Cloud Relay channel failed.',retryable)}
