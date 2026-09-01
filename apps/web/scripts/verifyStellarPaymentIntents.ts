import assert from "node:assert/strict";
import {
  Account,
  Address,
  MuxedAccount,
  nativeToScVal,
} from "stellar-sdk-16";

import { resolveStellarWorkspaceIntent } from "../src/networks/stellar/runtime/intentWorkspace";

const bankPayout = resolveStellarWorkspaceIntent(
  "Withdraw 100 TRY to my bank account from Stellar USDC",
);
assert.equal(bankPayout.kind, "payout");
assert.equal(bankPayout.amount, "100");
assert.equal(bankPayout.amountMode, "receive_exact");
assert.equal(bankPayout.sourceNetwork, "stellar_testnet");
assert.equal(bankPayout.destinationCountry, "TR");
assert.equal(bankPayout.destinationCurrency, "TRY");
assert.equal(bankPayout.deliveryMethod, "BANK");
assert.equal(bankPayout.readyToPrepare, true);

const multichainPayout = resolveStellarWorkspaceIntent(
  "Use 25 USDC from Arc Testnet to withdraw TRY to my Turkish bank account",
);
assert.equal(multichainPayout.kind, "payout");
assert.equal(multichainPayout.sourceNetwork, "arc_testnet");
assert.equal(multichainPayout.amountMode, "send_exact");
assert.equal(multichainPayout.amount, "25");

const exactWithdrawal = resolveStellarWorkspaceIntent(
  "Withdraw exactly 1000 TRY to my bank using Arc USDC",
);
assert.equal(exactWithdrawal.kind, "payout");
assert.equal(exactWithdrawal.amountMode, "receive_exact");

const thirdPartyPayout = resolveStellarWorkspaceIntent(
  "Recipient gets exactly 1000 TRY through their bank using Arc USDC",
);
assert.equal(thirdPartyPayout.kind, "unknown");
assert.match(thirdPartyPayout.blockingReason || "", /Third-party payout/u);

const unrelatedDefi = resolveStellarWorkspaceIntent(
  "Move 5 USDC from Arc to Arbitrum Sepolia and supply it to Aave",
);
assert.equal(unrelatedDefi.kind, "unknown");
assert.match(unrelatedDefi.blockingReason || "", /source-network DeFi/u);

const privateLab = resolveStellarWorkspaceIntent(
  "Make a private XLM payment on Stellar Testnet",
);
assert.equal(privateLab.kind, "unknown");
assert.match(privateLab.blockingReason || "", /research privacy pool/u);

const nativeSwap = resolveStellarWorkspaceIntent(
  "Swap 5 XLM to USDC on Stellar Testnet",
);
assert.equal(nativeSwap.kind, "swap");
assert.equal(nativeSwap.readyToPrepare, true);

const anchorAccount =
  "GBANAGOAXH5ONSBI2I6I5LHP2TCRHWMZIAMGUQH2TNKQNCOGJ7GC3ZOL";
const muxedAnchor = new MuxedAccount(
  new Account(anchorAccount, "0"),
  "186384",
).accountId();
assert.equal(Address.fromString(muxedAnchor).toString(), muxedAnchor);
assert.equal(
  nativeToScVal(muxedAnchor, { type: "address" }).address().switch().name,
  "scAddressTypeMuxedAccount",
);

console.log("Stellar Payment Center intent routing verified.");
