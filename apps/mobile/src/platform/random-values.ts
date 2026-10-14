import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';

// Hermes ships no Web Crypto global, so tweetnacl cannot seed the Relay
// end-to-end handshake on its own ("no PRNG"). Route its random source
// through expo-crypto, which works in the Expo runtime on every platform.
nacl.setPRNG((buffer: Uint8Array, length: number) => {
  buffer.set(Crypto.getRandomValues(new Uint8Array(length)));
});
