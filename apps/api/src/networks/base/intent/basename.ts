import { parseAbi, encodeFunctionData, type Address, type Hex } from "viem";
import { namehash, normalize } from "viem/ens";
import { ParsedIntent } from "../../../shared/ai/parser.js";
import { basePublicClient } from "../../../shared/config/client.js";
import { BASE_CONTRACTS } from "../../../shared/config/networks.js";

export const BASENAME_REGISTRAR_ABI = parseAbi([
  "function registerPrice(string name, uint256 duration) view returns (uint256)",
  "function rentPrice(string name, uint256 duration) view returns ((uint256 base, uint256 premium) price)",
  "function available(string name) view returns (bool)",
  "function register((string name, address owner, uint256 duration, address resolver, bytes[] data, bool reverseRecord, uint256[] coinTypes, uint256 signatureExpiry, bytes signature) request) payable",
  "function renew(string name, uint256 duration) payable",
]);

export const BASENAME_RESOLVER_ABI = parseAbi([
  "function setAddr(bytes32 node, address a)",
]);

export function encodeBasenameRegistration(
  name: string,
  owner: Address,
  duration: bigint,
): Hex {
  const node = namehash(normalize(`${name}.base.eth`));
  const addressRecord = encodeFunctionData({
    abi: BASENAME_RESOLVER_ABI,
    functionName: "setAddr",
    args: [node, owner],
  });
  return encodeFunctionData({
    abi: BASENAME_REGISTRAR_ABI,
    functionName: "register",
    args: [
      {
        name,
        owner,
        duration,
        resolver: BASE_CONTRACTS.basenameL2Resolver,

        data: [addressRecord],
        reverseRecord: false,
        coinTypes: [],
        signatureExpiry: 0n,
        signature: "0x",
      },
    ],
  });
}

export async function handleBaseName(
  intent: ParsedIntent,
  userAddress: string,
) {
  if (!intent.tokenIn) throw new Error("🚨 Base Name belirtilmedi.");
  const name = intent.tokenIn
    .trim()
    .toLowerCase()
    .replace(/\.base\.eth$/, "");
  const durationDays = intent.durationInDays || 365;
  const durationSeconds = BigInt(durationDays) * 86400n;

  // Confirm live availability before constructing registration calldata.
  const isAvailable = await basePublicClient.readContract({
    address: BASE_CONTRACTS.basenameRegistrarController,
    abi: BASENAME_REGISTRAR_ABI,
    functionName: "available",
    args: [name],
  });

  if (intent.action === "basename_register" && !isAvailable) {
    throw new Error(
      `🚨 Sorry, the name **${name}.base.eth** is already taken by someone else.`,
    );
  }

  if (intent.action === "basename_renew" && isAvailable) {
    throw new Error(
      `🚨 The name **${name}.base.eth** is not yet registered, so I can't extend its duration! You need to purchase it first.`,
    );
  }

  const price =
    intent.action === "basename_register"
      ? await basePublicClient.readContract({
          address: BASE_CONTRACTS.basenameRegistrarController,
          abi: BASENAME_REGISTRAR_ABI,
          functionName: "registerPrice",
          args: [name, durationSeconds],
        })
      : (
          await basePublicClient.readContract({
            address: BASE_CONTRACTS.basenameRegistrarController,
            abi: BASENAME_REGISTRAR_ABI,
            functionName: "rentPrice",
            args: [name, durationSeconds],
          })
        ).base;

  let calldata: `0x${string}`;
  let expectedOutput = "";

  if (intent.action === "basename_register") {
    calldata = encodeBasenameRegistration(
      name,
      userAddress as Address,
      durationSeconds,
    );
    const valInEth = Number(price) / 1e18;
    expectedOutput = `✅ You will purchase the ${name}.base.eth name for ${durationDays} days by paying ${valInEth.toFixed(4)} ETH.`;
  } else {
    calldata = encodeFunctionData({
      abi: BASENAME_REGISTRAR_ABI,
      functionName: "renew",
      args: [name, durationSeconds],
    });
    const valInEth = Number(price) / 1e18;
    expectedOutput = `⏳ You will extend the ${name}.base.eth name for ${durationDays} days by paying ${valInEth.toFixed(4)} ETH.`;
  }

  return {
    status: "success",
    winner: "Base Name Registrar",
    expectedOutput,
    routePath: [
      intent.action === "basename_register"
        ? "Register Base Name"
        : "Renew Base Name",
    ],
    targetContract: BASE_CONTRACTS.basenameRegistrarController,
    calldata,
    tokenInAddress: "Native ETH",
    amountInWei: price.toString(),
    isNativeIn: true,
    value: price.toString(),
    allRoutes: [
      {
        protocol: "Base Name Registrar",
        router: BASE_CONTRACTS.basenameRegistrarController,
        calldata: calldata,
      },
    ],
    winnerMessage: `🏆 **Kletia BNS Module Ready!**
✨ **Result:** ${expectedOutput}

> I have prepared the transaction for you; you can sign it from the console below.`,
  };
}
