import assert from "node:assert/strict";

import {
  cctpV2AttestedMessageMatchesSourceEvent,
  cctpV2MessageMatchesDomains,
  cctpV2NonceMatches,
} from "../cross-chain/v2/cctpV2MessageBinding.js";

const source = Buffer.alloc(376, 0);
source.writeUInt32BE(1, 0);
source.writeUInt32BE(26, 4);
source.writeUInt32BE(3, 8);
source.fill(0x11, 44, 140);
source.writeUInt32BE(2_000, 140);
source.writeUInt32BE(1, 148);
source.fill(0x22, 152);

const attested = Buffer.from(source);
attested.fill(0x33, 12, 44);
attested.writeUInt32BE(2_000, 144);

const hex = (value: Buffer) => `0x${value.toString("hex")}`;
assert.equal(cctpV2AttestedMessageMatchesSourceEvent(hex(source), hex(attested)), true);
assert.equal(cctpV2NonceMatches(`0x${"33".repeat(32)}`, `0x${"33".repeat(32)}`), true);
assert.equal(
  cctpV2NonceMatches(BigInt(`0x${"33".repeat(32)}`).toString(), `0x${"33".repeat(32)}`),
  true,
);

const changedRecipient = Buffer.from(attested);
changedRecipient[76] ^= 0xff;
assert.equal(cctpV2AttestedMessageMatchesSourceEvent(hex(source), hex(changedRecipient)), false);

const changedAmount = Buffer.from(attested);
changedAmount[216] ^= 0xff;
assert.equal(cctpV2AttestedMessageMatchesSourceEvent(hex(source), hex(changedAmount)), false);

const truncated = attested.subarray(0, 200);
assert.equal(cctpV2AttestedMessageMatchesSourceEvent(hex(source), hex(truncated)), false);
assert.equal(cctpV2NonceMatches("not-a-nonce", `0x${"33".repeat(32)}`), false);
assert.equal(
  cctpV2MessageMatchesDomains(
    { decodedMessage: { sourceDomain: "26", destinationDomain: "3" } },
    26,
    3,
  ),
  true,
);
assert.equal(
  cctpV2MessageMatchesDomains(
    {
      sourceDomain: 26,
      destinationDomain: 3,
      decodedMessage: { sourceDomain: "27", destinationDomain: "3" },
    },
    26,
    3,
  ),
  true,
);
assert.equal(
  cctpV2MessageMatchesDomains(
    { decodedMessage: { sourceDomain: "26", destinationDomain: "27" } },
    26,
    3,
  ),
  false,
);

process.stdout.write("CCTP V2 source-event and Iris attestation binding verified.\n");
