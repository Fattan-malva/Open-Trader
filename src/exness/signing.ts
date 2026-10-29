import crypto from "node:crypto";

/**
 * Exness signed-request protocol (EXN-SIGN-VERSION 1).
 *
 * - Ed25519 signature over the exact bytes of the decoded EXN-DATA payload.
 * - EXN-DATA and EXN-SIGN are base64url without `=` padding.
 * - body_hash is SHA-256 of the exact request body, base64url without padding.
 */

/*
  PKCS#8 wrapper prefix for a raw 32-byte Ed25519 seed:

  30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20
*/
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** SHA-256 of the empty string, base64url encoded. */
export const EMPTY_BODY_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

export interface SigningIdentity {
  apiKey: string;
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
  secretFormat: string;
}

export class SigningError extends Error {
  override name = "SigningError";
}

function decodeSecretBytes(raw: string): { bytes: Buffer; encoding: "hex" | "base64" } {
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    return { bytes: Buffer.from(raw, "hex"), encoding: "hex" };
  }
  const cleaned = raw.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) {
    const bytes = Buffer.from(cleaned.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length > 0) return { bytes, encoding: "base64" };
  }
  throw new SigningError(
    "Unsupported private key format. Expected PEM, 64-char hex seed, 128-char hex key pair, or base64.",
  );
}

function publicKeyHexFrom(privateKey: crypto.KeyObject): string {
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("hex");
}

/**
 * Builds a signable identity from the API key and whatever secret format Key Management gave you.
 * Exness `I'll use my own public key` / generated keys arrive as a 64-byte Ed25519 key pair
 * (seed || public key) hex encoded, which is the format this loader treats as canonical.
 */
export function loadIdentity(apiKey: string, secret: string): SigningIdentity {
  const trimmedApiKey = apiKey.trim();
  const raw = secret.trim();
  if (!trimmedApiKey) throw new SigningError("EXNESS_API_KEY is empty");
  if (!raw) throw new SigningError("EXNESS_PRIVATE_KEY is empty");

  let privateKey: crypto.KeyObject;
  let secretFormat: string;
  let expectedPublicKeyHex: string | undefined;

  if (raw.includes("-----BEGIN")) {
    try {
      privateKey = crypto.createPrivateKey({ key: raw });
    } catch (error) {
      throw new SigningError(`Unable to parse the PEM private key: ${(error as Error).message}`);
    }
    secretFormat = "pem";
  } else {
    const { bytes, encoding } = decodeSecretBytes(raw);
    let seed: Buffer;
    if (bytes.length === 64) {
      seed = bytes.subarray(0, 32);
      expectedPublicKeyHex = bytes.subarray(32).toString("hex");
      secretFormat = `${encoding} key pair (seed||public)`;
    } else if (bytes.length === 32) {
      seed = bytes;
      secretFormat = `${encoding} seed`;
    } else {
      throw new SigningError(
        `Private key has ${bytes.length} bytes after ${encoding} decoding. ` +
          "Expected 32 (seed), 64 (seed||public) or a PEM PKCS#8 key.",
      );
    }
    privateKey = crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
  }

  const publicKeyHex = publicKeyHexFrom(privateKey);
  if (expectedPublicKeyHex && expectedPublicKeyHex !== publicKeyHex) {
    throw new SigningError(
      "The public half embedded in EXNESS_PRIVATE_KEY does not match the key derived from its seed. " +
        "Re-copy the private signing key from Key Management.",
    );
  }

  return { apiKey: trimmedApiKey, privateKey, publicKeyHex, secretFormat };
}

export function base64Url(input: Buffer | Uint8Array | string): string {
  return Buffer.from(input as never).toString("base64url");
}

export function hashBody(body?: string | Buffer | null): string {
  const buffer = body === undefined || body === null ? Buffer.alloc(0) : Buffer.from(body as never);
  return crypto.createHash("sha256").update(buffer).digest("base64url");
}

export interface SignedPayload {
  api_key: string;
  idempotency_key: string;
  timestamp: number;
  sign_version: 1;
  method: string;
  path: string;
  body_hash: string;
}

export interface SignRequestOptions {
  identity: SigningIdentity;
  method: string;
  /** Request path including the query string, exactly as it will be sent. */
  pathWithQuery: string;
  body?: string | null;
  /** Must be empty for signed GET requests. */
  idempotencyKey?: string;
  timestamp?: number;
}

export interface SignedRequest {
  headers: Record<string, string>;
  payload: SignedPayload;
}

export function signRequest(options: SignRequestOptions): SignedRequest {
  const method = options.method.toUpperCase();
  const idempotencyKey = options.idempotencyKey ?? "";
  const timestamp = options.timestamp ?? Date.now();
  const body = options.body ?? "";

  if (method === "GET" && idempotencyKey !== "") {
    throw new SigningError("Signed GET requests must use an empty idempotency key");
  }

  // Serialize once: the same bytes are signed and shipped in EXN-DATA.
  const payload: SignedPayload = {
    api_key: options.identity.apiKey,
    idempotency_key: idempotencyKey,
    timestamp,
    sign_version: 1,
    method,
    path: options.pathWithQuery,
    body_hash: method === "GET" && body === "" ? EMPTY_BODY_HASH : hashBody(body),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = crypto.sign(null, payloadBytes, options.identity.privateKey);

  return {
    payload,
    headers: {
      "EXN-API-KEY": options.identity.apiKey,
      "EXN-IDEMPOTENCY-KEY": idempotencyKey,
      "EXN-TIMESTAMP": String(timestamp),
      "EXN-SIGN-VERSION": "1",
      "EXN-DATA": base64Url(payloadBytes),
      "EXN-SIGN": base64Url(signature),
    },
  };
}

/** Builds the signed headers only (used by the WebSocket handshake as well). */
export function buildSignedHeaders(options: SignRequestOptions): Record<string, string> {
  return signRequest(options).headers;
}
