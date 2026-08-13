import { getAddress, parseAbi, type Hex } from "viem";

export const BASE_LAUNCH_FACTORY_V2_ADDRESS = getAddress(
  "0x1D62Ac5e19af7688EbC57f262bbB9959dd78e043",
);

export const BASE_LAUNCH_OWNER_AUTHORITY_ADDRESS = getAddress(
  "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D",
);

export const BASE_LAUNCH_OWNER_AUTHORITY_KIND = "safe_2_of_2" as const;

export const BASE_LAUNCH_TREASURY_SAFE_ADDRESS = getAddress(
  "0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC",
);

export const BASE_LAUNCH_FACTORY_V2_FEE_CAP = 10_000_000_000_000_000n;
export const BASE_LAUNCH_FACTORY_V2_MAX_SUPPLY = 10n ** 36n;
export const BASE_LAUNCH_FACTORY_V2_RUNTIME_CODEHASH =
  "0xa28d7ef44ecff154d4b24a2f362868bf29e8a9ca7f172d8b0e3cad2b5fc80e81" as Hex;

export const BASE_LAUNCH_FACTORY_V2_ABI = parseAbi([
  "function deployToken(bytes32 userSalt, string name_, string symbol_, uint256 totalSupply_, address recipient_, uint256 maxDeploymentFee) payable returns (address token)",
]);
