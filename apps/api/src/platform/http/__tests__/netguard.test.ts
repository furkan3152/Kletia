/**
 * Outbound URL policy (netguard.ts): the edges of every blocked range, the
 * IPv4 forms hidden inside IPv6, the static URL rules for both policies
 * (webhook and action) and the connect-time lookup (DNS rebinding).
 */
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { describe, it } from "node:test";
import { PlatformError } from "../../errors.js";
import { createGuardedLookup, isPublicAddress, parseWebhookUrl, type AddressResolver } from "../netguard.js";

const ipv4 = (value: number): string => [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
const ipv4Number = (address: string): number => address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);

/** Blocked IPv4 ranges (netguard.ts) as [first, last]. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["168.63.129.16", 32],
];

function inBlocked(value: number): boolean {
  return BLOCKED_V4.some(([network, prefix]) => {
    const start = ipv4Number(network);
    return value >= start && value <= start + 2 ** (32 - prefix) - 1;
  });
}

describe("netguard address classes", () => {
  it("refuses the first and last address of every blocked IPv4 range and accepts the public neighbours", () => {
    for (const [network, prefix] of BLOCKED_V4) {
      const first = ipv4Number(network);
      const last = first + 2 ** (32 - prefix) - 1;
      for (const value of [first, last, Math.floor((first + last) / 2)]) assert.equal(isPublicAddress(ipv4(value)), false, `${ipv4(value)} in ${network}/${prefix}`);
      for (const neighbour of [first - 1, last + 1]) {
        if (neighbour < 0 || neighbour > 0xffff_ffff || inBlocked(neighbour)) continue;
        assert.equal(isPublicAddress(ipv4(neighbour)), true, `${ipv4(neighbour)} next to ${network}/${prefix}`);
      }
    }
  });

  it("refuses IPv4 hidden in IPv6 (mapped, compatible, NAT64, 6to4, Teredo) even when the IPv4 is public", () => {
    for (const address of [
      "::ffff:8.8.8.8", "::ffff:127.0.0.1", "::ffff:0808:0808", "::8.8.8.8", "::127.0.0.1",
      "64:ff9b::808:808", "64:ff9b:1::1", "2002:808:808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
  });

  it("refuses special-purpose IPv6 ranges at their edges, zone ids included", () => {
    for (const address of [
      "::", "::1", "100::", "100::ffff:ffff:ffff:ffff", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "3fff::1", "5f00::1",
      "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::1", "fe80::1%eth0", "febf:ffff::1", "fec0::1", "ff02::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ["2001:4860:4860::8888", "2600::1", "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:200::1"]) {
      assert.equal(isPublicAddress(address), true, address);
    }
  });

  it("never classifies names, empty strings or malformed literals as public", () => {
    for (const value of ["", "localhost", "8.8.8", "8.8.8.8.8", "256.1.1.1", "::g", "[::1]", " 8.8.8.8"]) {
      assert.equal(isPublicAddress(value), false, JSON.stringify(value));
    }
  });
});

function refusal(run: () => unknown): PlatformError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

describe("netguard static URL rules", () => {
  it("accepts public HTTPS names and literals on 443 or an unprivileged port", () => {
    assert.equal(parseWebhookUrl(" https://hooks.example.com/kletia ").href, "https://hooks.example.com/kletia");
    assert.equal(parseWebhookUrl("https://hooks.example.com:443/a").port, "");
    assert.equal(parseWebhookUrl("https://hooks.example.com:8443/a").port, "8443");
    assert.equal(parseWebhookUrl("https://8.8.8.8/a").hostname, "8.8.8.8");
    assert.equal(parseWebhookUrl("https://[2001:4860:4860::8888]/a").hostname, "[2001:4860:4860::8888]");
  });

  it("refuses schemes, credentials, fragments, privileged ports, long URLs and non-public hosts", () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [undefined, "INVALID_REQUEST"],
      ["", "INVALID_REQUEST"],
      [`https://example.com/${"a".repeat(2_048)}`, "INVALID_REQUEST"],
      ["not a url", "INVALID_REQUEST"],
      ["http://example.com/hook", "INVALID_REQUEST"],
      ["ftp://example.com/hook", "INVALID_REQUEST"],
      ["https://user:pass@example.com/hook", "INVALID_REQUEST"],
      ["https://example.com/hook#fragment", "INVALID_REQUEST"],
      ["https://example.com:80/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://example.com:1023/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://2130706433/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://0177.0.0.1/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://[::ffff:7f00:1]/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://LOCALHOST./hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://api.localhost/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://printer.local/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://db.internal/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://router.home.arpa/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://kubernetes.default/hook", "WEBHOOK_URL_FORBIDDEN"],
      ["https://intranet/hook", "WEBHOOK_URL_FORBIDDEN"],
    ];
    for (const [url, code] of cases) assert.equal(refusal(() => parseWebhookUrl(url)).code, code, String(url).slice(0, 60));
  });

  it("refuses action URLs with ACTION_URL_FORBIDDEN (422) at the given path, malformed ones included", () => {
    for (const url of ["http://example.com/a", "https://user@example.com/a", "https://10.0.0.1/a", "https://localhost/a", 42]) {
      const error = refusal(() => parseWebhookUrl(url, { kind: "action", path: "actions[0].url" }));
      assert.equal(error.code, "ACTION_URL_FORBIDDEN", String(url));
      assert.equal(error.status, 422);
      assert.equal(error.issues?.[0]?.path, "actions[0].url");
    }
  });
});

describe("netguard connect-time lookup", () => {
  const resolver = (addresses: readonly LookupAddress[], error: NodeJS.ErrnoException | null = null): AddressResolver => (_host, callback) => callback(error, addresses);
  const lookup = (resolve: AddressResolver, options: { family?: number; all?: boolean } = {}) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>((done) => {
      createGuardedLookup(resolve)("hooks.example.com", options as never, ((error: NodeJS.ErrnoException | null, address: unknown, family?: number) => done({ error, address, ...(family === undefined ? {} : { family }) })) as never);
    });

  it("answers the first public address, or every address with all: true", async () => {
    const both = resolver([{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]);
    assert.deepEqual(await lookup(both), { error: null, address: "8.8.8.8", family: 4 });
    assert.deepEqual(await lookup(both, { family: 6 }), { error: null, address: "2001:4860:4860::8888", family: 6 });
    const all = await lookup(both, { all: true });
    assert.equal(all.error, null);
    assert.deepEqual(all.address, [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]);
  });

  it("refuses when any answer is private, also one of another family than requested (rebinding)", async () => {
    const mixed = resolver([{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }]);
    for (const options of [{}, { family: 4 }, { all: true }]) {
      const result = await lookup(mixed, options);
      assert.equal(result.error?.code, "EWEBHOOKFORBIDDEN", JSON.stringify(options));
    }
    assert.equal((await lookup(resolver([{ address: "169.254.169.254", family: 4 }]))).error?.code, "EWEBHOOKFORBIDDEN");
  });

  it("refuses an empty answer or one without the requested family, and passes resolver errors through", async () => {
    assert.equal((await lookup(resolver([]))).error?.code, "EWEBHOOKFORBIDDEN");
    assert.equal((await lookup(resolver([{ address: "8.8.8.8", family: 4 }]), { family: 6 })).error?.code, "EWEBHOOKFORBIDDEN");
    const failure = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    assert.equal((await lookup(resolver([], failure))).error?.code, "ENOTFOUND");
  });
});
