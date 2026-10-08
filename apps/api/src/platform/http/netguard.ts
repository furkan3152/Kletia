/**
 * Outbound URL policy for webhooks (SSRF guard).
 *
 * A webhook URL must be HTTPS, carry no credentials and resolve only to
 * public unicast addresses: loopback, private, CGNAT, link-local (including
 * cloud metadata at 169.254.169.254), multicast, documentation, benchmarking,
 * NAT64/6to4/Teredo and other special-purpose ranges are refused. The check
 * runs when the webhook is registered and again inside every delivery's
 * socket lookup, so a DNS answer that changes later (rebinding) is refused at
 * connect time too.
 */
import dns, { type LookupAddress } from "node:dns";
import { lookup as lookupAsync } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { PlatformError } from "../errors.js";
import { invalidRequest } from "./context.js";

// Separate lists: Node's BlockList matches IPv4 rules against IPv4-mapped IPv6
// addresses and vice versa, so one shared list would let ::ffff:0:0/96 block
// every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();

const BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments (Oracle metadata 192.0.0.192)
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
  ["168.63.129.16", 32], // Azure host/metadata endpoint (public address, internal service)
];

const BLOCKED_IPV6: readonly (readonly [string, number])[] = [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
  ["5f00::", 16], // SRv6 SIDs
  ["fc00::", 7], // unique local (AWS IMDS fd00:ec2::254)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

for (const [network, prefix] of BLOCKED_IPV4) BLOCKED_V4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of BLOCKED_IPV6) BLOCKED_V6.addSubnet(network, prefix, "ipv6");

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes", "kubernetes.default"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp", ".private"];

/** True only for public unicast IPv4/IPv6 addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, "ipv4");
  if (family === 6) {
    // IPv4-mapped/compatible forms are refused outright by the ::/96 and ::ffff:0:0/96 rules.
    const bare = address.split("%")[0] ?? address;
    return !BLOCKED_V6.check(bare, "ipv6") && !BLOCKED_V4.check(bare, "ipv6");
  }
  return false;
}

function bareHostname(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function forbidden(message: string): PlatformError {
  return new PlatformError("WEBHOOK_URL_FORBIDDEN", message, 422, [{ path: "url", message }]);
}

const MAX_URL_LENGTH = 2_048;
const DNS_TIMEOUT_MS = 3_000;

/** Static checks (no DNS): scheme, credentials, port, host shape. Returns the normalised URL. */
export function parseWebhookUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL_LENGTH) {
    throw invalidRequest(`url must be an absolute HTTPS URL of at most ${MAX_URL_LENGTH} characters.`, [
      { path: "url", message: "Required HTTPS URL." },
    ]);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidRequest("url is not a valid absolute URL.", [{ path: "url", message: "Invalid URL." }]);
  }
  if (url.protocol !== "https:") {
    throw invalidRequest("Webhook URLs must use HTTPS.", [{ path: "url", message: "Only https:// URLs are accepted." }]);
  }
  if (url.username || url.password) {
    throw invalidRequest("Webhook URLs must not contain credentials.", [{ path: "url", message: "Remove user:password@." }]);
  }
  if (url.hash) {
    throw invalidRequest("Webhook URLs must not contain a fragment.", [{ path: "url", message: "Remove the #fragment." }]);
  }
  if (url.port && url.port !== "443" && Number(url.port) < 1024) {
    throw forbidden("Webhook URLs may use port 443 or a port from 1024 to 65535.");
  }
  const host = bareHostname(url);
  if (!host) throw invalidRequest("url has no host.", [{ path: "url", message: "Missing host." }]);
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw forbidden("Webhook URLs must point to a public internet address.");
    return url;
  }
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)) || !host.includes(".")) {
    throw forbidden("Webhook URLs must use a public DNS name.");
  }
  return url;
}

/** Full registration check: static rules plus DNS resolution of every address. */
export async function assertPublicWebhookUrl(raw: unknown): Promise<URL> {
  const url = parseWebhookUrl(raw);
  const host = bareHostname(url);
  if (isIP(host)) return url;
  let addresses: LookupAddress[];
  let timer: NodeJS.Timeout | undefined;
  try {
    addresses = await Promise.race([
      lookupAsync(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new PlatformError("WEBHOOK_URL_UNRESOLVABLE", `The webhook host ${host.slice(0, 120)} could not be resolved.`, 422, [
      { path: "url", message: "Host does not resolve." },
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw forbidden("The webhook host resolves to a private, loopback, link-local or otherwise non-public address.");
  }
  return url;
}

/**
 * `lookup` for outbound sockets: resolves normally, then refuses the
 * connection unless every resolved address is public.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    const first = list[0];
    if (!first || list.some((entry) => !isPublicAddress(entry.address))) {
      const refused: NodeJS.ErrnoException = Object.assign(new Error("Webhook host resolves to a non-public address."), {
        code: "EWEBHOOKFORBIDDEN",
      });
      callback(refused, "", 0);
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, first.address, first.family);
  });
};
