export type ArcPositionExit =
  | "unstake"
  | "claim_rewards"
  | "claim_unstaked"
  | "lending_repay"
  | "lending_withdraw"
  | "remove_liquidity";

/** These explicit templates preserve the selected deployment through the Arc parser. */
export function arcPositionExitPrompt(
  action: ArcPositionExit,
  legacy: boolean,
  amount = "1",
): string {
  const protocol = legacy ? "Kletia Legacy" : "Kletia";
  switch (action) {
    case "unstake":
      return `Unstake ${amount} native USDC from ${protocol} Staking on Arc Testnet and start the contract-defined cooldown; simulate it before wallet approval`;
    case "claim_rewards":
      return `Claim all available rewards from ${protocol} Staking on Arc Testnet; simulate it before wallet approval`;
    case "claim_unstaked":
      return `Claim my cooled-down unstaked native USDC from ${protocol} Staking on Arc Testnet; simulate it before wallet approval`;
    case "lending_repay":
      return `Repay ${amount} native USDC to ${protocol} Lending on Arc Testnet; prepare the route and simulate it before wallet approval`;
    case "lending_withdraw":
      return `Withdraw ${amount} KLET collateral from ${protocol} Lending on Arc Testnet; prepare the route and simulate it before wallet approval`;
    case "remove_liquidity":
      return `Remove ${amount} LP tokens from ${protocol} Swap on Arc Testnet; simulate it before wallet approval`;
  }
}
