import { getAddress, parseAbi, type Hex } from 'viem';

export const BASE_LAUNCH_FACTORY_V2_ADDRESS = getAddress(
  '0x90cc932D97966F6Bdd8426184283FF2ff9d3043b',
);

export const BASE_LAUNCH_TIMELOCK_ADDRESS = getAddress(
  '0x1B0D1720a9b67Bac0a72E671A69f2772C0BaA47F',
);

export const BASE_LAUNCH_TREASURY_SAFE_ADDRESS = getAddress(
  '0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC',
);

export const BASE_LAUNCH_FACTORY_V2_FEE_CAP = 10_000_000_000_000_000n;
export const BASE_LAUNCH_FACTORY_V2_MAX_SUPPLY = 10n ** 36n;
export const BASE_LAUNCH_FACTORY_V2_RUNTIME_CODEHASH =
  '0xb65a8f83f65961bdb2980f8530c0566013340f7491226c7a27f27efe60338a52' as Hex;

export const BASE_LAUNCH_FACTORY_V2_ABI = parseAbi([
  'function deployToken(bytes32 userSalt, string name_, string symbol_, uint256 totalSupply_, address recipient_, uint256 maxDeploymentFee) payable returns (address token)',
]);
