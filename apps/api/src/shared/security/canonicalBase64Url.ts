const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

/**
 * Node's base64url decoder accepts multiple textual encodings for the same
 * byte sequence. Security tokens require one canonical representation so a
 * signed token cannot be textually mutated without rejection.
 */
export function decodeCanonicalBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error("Non-canonical base64url input.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new Error("Non-canonical base64url input.");
  }
  return decoded;
}
