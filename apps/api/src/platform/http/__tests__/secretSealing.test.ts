/**
 * Secret material (secrets.ts): AES-256-GCM sealing is bound to its record
 * (AAD) and refuses tampering, base62 tokens use only their alphabet, and
 * platform MACs are separated by purpose.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openSecret, platformMac, randomBase62, sealSecret, sealingAvailable } from "../secrets.js";

describe("secret sealing", () => {
  it("opens only for the record it was sealed for", () => {
    assert.equal(sealingAvailable(), true, "the test process has a sealing key");
    const sealed = sealSecret("whsec_example", "webhook:wh_1");
    assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/u);
    assert.equal(openSecret(sealed, "webhook:wh_1"), "whsec_example");
    assert.throws(() => openSecret(sealed, "webhook:wh_2"));
    assert.notEqual(sealSecret("whsec_example", "webhook:wh_1"), sealed, "a fresh IV every time");
  });

  it("refuses tampered ciphertexts, tags and IVs, and other formats", () => {
    const [version, iv, tag, data] = sealSecret("whsec_example", "ctx").split(".") as [string, string, string, string];
    const flip = (part: string) => {
      const bytes = Buffer.from(part, "base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      return bytes.toString("base64url");
    };
    for (const sealed of [
      [version, iv, tag, flip(data)],
      [version, iv, flip(tag), data],
      [version, flip(iv), tag, data],
      ["v2", iv, tag, data],
      [version, iv.slice(2), tag, data],
      [version, iv, tag.slice(2), data],
      [version, iv, tag],
    ]) {
      assert.throws(() => openSecret(sealed.join("."), "ctx"), Error, sealed.join("."));
    }
  });
});

describe("tokens and MACs", () => {
  it("draws base62 tokens of the exact length from the alphabet", () => {
    for (const length of [1, 24, 32, 100]) {
      const token = randomBase62(length);
      assert.equal(token.length, length);
      assert.match(token, /^[0-9A-Za-z]+$/u);
    }
    assert.notEqual(randomBase62(32), randomBase62(32));
  });

  it("separates platform MACs by purpose and message", () => {
    const mac = platformMac("blink-next", "m");
    assert.match(mac ?? "", /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(platformMac("blink-next", "m"), mac);
    assert.notEqual(platformMac("other", "m"), mac);
    assert.notEqual(platformMac("blink-next", "m2"), mac);
  });
});
