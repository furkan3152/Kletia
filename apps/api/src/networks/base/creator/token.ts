import { encodeFunctionData } from "viem";
import { ROUTERS, KLETIA_TOKEN_FACTORY_ABI } from "../contracts.js";
import { publicClient } from "../../../config/client.js";
import {
  resolveBaseTokenDeploymentConfig,
  type BaseTokenDeploymentConfig,
} from "../config/launchFactoryV2Environment.js";
import {
  buildLaunchFactoryV2TokenPlan,
  parseStrictTokenSupply,
  type LaunchFactoryV2PublicClient,
} from "./launchFactoryV2.js";

interface TokenDeploymentDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly config?: BaseTokenDeploymentConfig;
  readonly client?: LaunchFactoryV2PublicClient;
}

function formatHumanSupply(value: string): string {
  const [integer, fraction] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export async function handleTokenDeployment(
  userAddress: string,
  name: string | undefined,
  symbol: string | undefined,
  supplyStr: string | undefined,
  launchId?: string,
  requestedRecipient?: string,
  dependencies: TokenDeploymentDependencies = {},
) {
  const config =
    dependencies.config ||
    resolveBaseTokenDeploymentConfig(dependencies.environment || process.env);
  if (config.mode === "launch_v2") {
    return buildLaunchFactoryV2TokenPlan({
      config,
      client:
        dependencies.client || (publicClient as LaunchFactoryV2PublicClient),
      userAddress,
      name,
      symbol,
      supply: supplyStr,
      launchId,
      requestedRecipient,
    });
  }

  if (!name || !symbol) {
    throw new Error(
      "Token oluşturmak için bir isim (name) ve sembol (symbol) belirtmelisin. Örn: 'Kletia Coin oluştur sembolü KLT olsun'",
    );
  }

  const totalSupplyBigInt = parseStrictTokenSupply(supplyStr);

  const factoryCalldata = encodeFunctionData({
    abi: KLETIA_TOKEN_FACTORY_ABI,
    functionName: "createToken",
    args: [name, symbol, totalSupplyBigInt],
  });

  return {
    target: ROUTERS.KLETIA_TOKEN_FACTORY,
    calldata: factoryCalldata,
    value: 0n,
    summary: `Kletia Özel Token Fabrikasında '${name}' (${symbol}) adında ${formatHumanSupply(supplyStr!)} arzlı yeni bir token yaratılacak. Arzın %10'u Hazine'ye kesilecektir.`,
  };
}
