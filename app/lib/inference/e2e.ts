/**
 * End-to-end encryption for inference jobs. Pure JS (audited @noble libraries) so the browser, the desktop app and
 * Node all run the same code. A sealed box is:
 *   shared = X25519(ephemeral secret, recipient public)
 *   key    = HKDF-SHA256(shared, salt = epk || recipient public, info = "delphi-infer:v1:" + purpose)
 *   ct     = XChaCha20-Poly1305(key, random 24-byte nonce, plaintext, aad = purpose)
 * A fresh ephemeral key per message gives forward secrecy for the sender side; `purpose` binds a box to its use
 * (a request can't be replayed as a response). Tampering with any byte fails authentication.
 */
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { PROTOCOL_VERSION, type Sealed } from "./protocol";

export type Purpose = "request" | "response";
export type KeyPair = { secret: Uint8Array; publicKey: Uint8Array };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = (data: Uint8Array | string): string => hex(sha256(typeof data === "string" ? enc.encode(data) : data));

/** random id for jobs (16 bytes -> 22 base64url chars): unguessable, so it doubles as the requester's claim ticket */
export const newJobId = (): string => b64u(randomBytes(16));

export function newKeyPair(): KeyPair {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

export const keyPairFromSecret = (secret: Uint8Array): KeyPair => ({ secret, publicKey: x25519.getPublicKey(secret) });

function boxKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array, purpose: Purpose): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(recipient, 32);
  return hkdf(sha256, shared, salt, enc.encode(`delphi-infer:v${PROTOCOL_VERSION}:${purpose}`), 32);
}

function allZero(b: Uint8Array) {
  let acc = 0;
  for (const x of b) acc |= x;
  return acc === 0;
}

/** Seal `plaintext` (string or JSON-able value) so only the holder of `recipientPublic`'s secret can open it. */
export function seal(recipientPublic: Uint8Array | string, plaintext: unknown, purpose: Purpose): Sealed {
  const to = typeof recipientPublic === "string" ? fromB64u(recipientPublic) : recipientPublic;
  if (to.length !== 32) throw new Error("bad recipient key");
  const eph = newKeyPair();
  const shared = x25519.getSharedSecret(eph.secret, to);
  if (allZero(shared)) throw new Error("bad recipient key");
  const key = boxKey(shared, eph.publicKey, to, purpose);
  const nonce = randomBytes(24);
  const body = enc.encode(typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext));
  const ct = xchacha20poly1305(key, nonce, enc.encode(purpose)).encrypt(body);
  return { v: PROTOCOL_VERSION, epk: b64u(eph.publicKey), nonce: b64u(nonce), ct: b64u(ct) };
}

/** Open a box sealed to `me`. Throws if it was tampered with, sealed to someone else, or for another purpose. */
export function openSealed(me: KeyPair, box: Sealed, purpose: Purpose): string {
  if (box.v !== PROTOCOL_VERSION) throw new Error(`unsupported box version ${box.v}`);
  const epk = fromB64u(box.epk);
  const nonce = fromB64u(box.nonce);
  if (epk.length !== 32 || nonce.length !== 24) throw new Error("malformed box");
  const shared = x25519.getSharedSecret(me.secret, epk);
  if (allZero(shared)) throw new Error("malformed box");
  const key = boxKey(shared, epk, me.publicKey, purpose);
  return dec.decode(xchacha20poly1305(key, nonce, enc.encode(purpose)).decrypt(fromB64u(box.ct)));
}

export const openJson = <T>(me: KeyPair, box: Sealed, purpose: Purpose): T => JSON.parse(openSealed(me, box, purpose)) as T;
