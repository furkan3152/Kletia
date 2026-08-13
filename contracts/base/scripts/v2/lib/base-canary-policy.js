"use strict";

const CANONICAL_BASE_WETH =
  "0x4200000000000000000000000000000000000006";
const UNISWAP_V2_ADAPTER_KIND = "uniswap_v2_compatible";
const UNISWAP_V3_ADAPTER_KIND = "uniswap_v3_swaprouter02";
const PROTOCOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const CANARY_KINDS = Object.freeze([
  UNISWAP_V2_ADAPTER_KIND,
  UNISWAP_V3_ADAPTER_KIND,
]);

function canaryPolicyKey(kind, protocolId) {
  if (
    !CANARY_KINDS.includes(kind) ||
    typeof protocolId !== "string" ||
    !PROTOCOL_ID_PATTERN.test(protocolId)
  ) {
    throw new TypeError("invalid Base canary policy identity");
  }
  return `${kind}:${protocolId}`;
}

const OFFICIAL_CANARY_DEPLOYMENTS = Object.freeze({
  uniswap: Object.freeze({
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  }),
});

const OFFICIAL_TYPED_CANARY_DEPLOYMENTS = Object.freeze({
  [canaryPolicyKey(UNISWAP_V2_ADAPTER_KIND, "uniswap")]: Object.freeze({
    kind: UNISWAP_V2_ADAPTER_KIND,
    protocolId: "uniswap",
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  }),
  [canaryPolicyKey(UNISWAP_V3_ADAPTER_KIND, "uniswap")]: Object.freeze({
    kind: UNISWAP_V3_ADAPTER_KIND,
    protocolId: "uniswap",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  }),
});

module.exports = Object.freeze({
  CANARY_KINDS,
  CANONICAL_BASE_WETH,
  OFFICIAL_CANARY_DEPLOYMENTS,
  OFFICIAL_TYPED_CANARY_DEPLOYMENTS,
  UNISWAP_V2_ADAPTER_KIND,
  UNISWAP_V3_ADAPTER_KIND,
  canaryPolicyKey,
});
