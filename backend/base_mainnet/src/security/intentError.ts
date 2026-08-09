import { IntentParserError } from '../ai/parser.js';
import { ArcAppKitPlanError } from '../intent/arcAppKit.js';
import { ArcPlanError } from '../intent/arcHandlers.js';
import { ArcOfficialPlanError } from '../intent/arcOfficial.js';
import { BaseIntentV2PlanError } from '../intent/baseIntentRouterV2.js';
import { BaseX402IntentError } from '../intent/baseX402.js';
import { IntentResponseError } from '../intent/responseEnvelope.js';
import { EntityResolutionError } from '../assets/resolver.js';
import { BaseTokenLaunchError } from '../config/baseLaunchFactoryV2Environment.js';
import type { NetworkId } from '../config/networks.js';

export interface IntentPublicError {
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
}

interface ControlledErrorDefinition {
  readonly message: string;
  readonly statusCode: number;
}

const CONTROLLED_CODE_ERRORS: Readonly<
  Record<string, ControlledErrorDefinition>
> = {
  ACROSS_CONFIGURATION_REQUIRED: {
    message:
      'Across production API anahtarı ve Kletia integrator kimliği sunucuda yapılandırılmamış; güvenli bridge rotası hazırlanmadı.',
    statusCode: 503,
  },
  ACROSS_CONFIGURATION_INVALID: {
    message: 'Across sunucu yapılandırması geçersiz; bridge rotası hazırlanmadı.',
    statusCode: 503,
  },
  ACROSS_FEE_LIMIT_EXCEEDED: {
    message: 'Across canlı relay ücreti Kletia güvenlik üst sınırını aşıyor.',
    statusCode: 400,
  },
  ACROSS_QUOTE_EXPIRED: {
    message: 'Across teklifi imzalanmadan önce süresi doldu; yeni rota istenmelidir.',
    statusCode: 400,
  },
  AMOUNT_REQUIRED: {
    message:
      'İşlem için pozitif bir miktar veya açıkça MAX belirtilmelidir.',
    statusCode: 400,
  },
  ALLORA_ASSET_UNSUPPORTED: {
    message: 'Allora gözlemleri yalnızca desteklenen varlıklar için kullanılabilir.',
    statusCode: 400,
  },
  ALLORA_UNAVAILABLE: {
    message: 'Canlı tahmin servisi şu anda kullanılamıyor.',
    statusCode: 503,
  },
  ALLORA_PROVIDER_ERROR: {
    message: 'Canlı tahmin verisi geçici olarak kullanılamıyor.',
    statusCode: 502,
  },
  BASE_RPC_CHAIN_MISMATCH: {
    message: 'Base RPC beklenen Base Mainnet zinciriyle eşleşmiyor.',
    statusCode: 503,
  },
  FEE_ROUTER_ROUTE_REQUIRED: {
    message: 'Kletia ücret yönlendiricisi için açık bir yürütme rotası gerekli.',
    statusCode: 400,
  },
  FEE_ROUTER_UNAVAILABLE: {
    message:
      'Hiçbir rota Kletia ücret yönlendiricisi allowlist ve simülasyon denetimini geçemedi.',
    statusCode: 400,
  },
  INSUFFICIENT_FUNDS: {
    message:
      'Bu işlem için kullanılabilir bakiye yetersiz. [SHOW_ONRAMP]',
    statusCode: 400,
  },
  INVALID_BASE_LENDING_ROUTE: {
    message: 'Base lending rotası güvenlik sözleşmesiyle eşleşmiyor.',
    statusCode: 500,
  },
  INVALID_PROTOCOL_RETURN_DATA: {
    message: 'Protokol simülasyonu doğrulanabilir bir dönüş verisi üretmedi.',
    statusCode: 400,
  },
  INVALID_ROUTE_QUOTE: {
    message: 'Rota teklifi güvenli sıralama sözleşmesiyle eşleşmiyor.',
    statusCode: 500,
  },
  INVALID_SLIPPAGE: {
    message: 'Slippage sınırı geçersiz.',
    statusCode: 400,
  },
  INVALID_X402_ASSET: {
    message: 'x402 ödeme varlığı Base USDC politikasıyla eşleşmiyor.',
    statusCode: 400,
  },
  INVALID_X402_GATEWAY: {
    message: 'x402 gateway adresi geçersiz.',
    statusCode: 400,
  },
  INVALID_X402_PRICE: {
    message: 'x402 ödeme fiyatı güvenli sınırlar içinde değil.',
    statusCode: 400,
  },
  LIQUID_STAKING_TOKEN_REQUIRED: {
    message: 'Desteklenen bir liquid staking varlığı belirtilmelidir.',
    statusCode: 400,
  },
  PROTOCOL_RETURN_CODE_NONZERO: {
    message: 'Protokol simülasyonu başarısız bir dönüş kodu üretti.',
    statusCode: 400,
  },
  TOKEN_DEPLOYMENT_SIMULATION_FAILED: {
    message: 'Token oluşturma işlemi canlı Base simülasyonunu geçemedi.',
    statusCode: 400,
  },
  TOKEN_REQUIRED: {
    message: 'İşlem için desteklenen bir token belirtilmelidir.',
    statusCode: 400,
  },
  TOKEN_SECURITY_UNAVAILABLE: {
    message: 'Token güvenlik doğrulaması şu anda kullanılamıyor.',
    statusCode: 503,
  },
  TOKEN_SECURITY_RISK: {
    message: 'Token yüksek risk sinyali nedeniyle güvenli biçimde engellendi.',
    statusCode: 400,
  },
  UNVERIFIED_X402_GATEWAY: {
    message: 'x402 gateway Base Mainnet üzerinde doğrulanamadı.',
    statusCode: 400,
  },
  UNSUPPORTED_ACTION: {
    message: 'Bu işlem seçilen ağda desteklenmiyor.',
    statusCode: 400,
  },
  WETH_SIMULATION_FAILED: {
    message: 'WETH işlemi canlı Base simülasyonunu geçemedi.',
    statusCode: 400,
  },
};

const KEE_ERRORS: Readonly<Record<string, ControlledErrorDefinition>> = {
  RATE_LIMIT: {
    message: 'Geçici RPC istek sınırına ulaşıldı; kısa süre sonra yeniden dene.',
    statusCode: 503,
  },
  SLIPPAGE: {
    message: 'İşlem slippage veya yetersiz likidite nedeniyle simülasyonu geçemedi.',
    statusCode: 400,
  },
  ALLOWANCE: {
    message: 'İşlem için gerekli token izni yetersiz.',
    statusCode: 400,
  },
  WHITELIST: {
    message: 'Hedef protokol Kletia güvenlik allowlist politikasını geçemedi.',
    statusCode: 400,
  },
  INSUFFICIENT_FUNDS: {
    message:
      'Bu işlem için kullanılabilir bakiye yetersiz. [SHOW_ONRAMP]',
    statusCode: 400,
  },
  NETWORK: {
    message: 'Base ağına geçici olarak ulaşılamıyor; lütfen yeniden dene.',
    statusCode: 503,
  },
  INVALID_ADDRESS: {
    message: 'İşlemdeki cüzdan veya kontrat adresi geçersiz.',
    statusCode: 400,
  },
  UNKNOWN_REVERT: {
    message: 'İşlem zincir simülasyonu sırasında güvenli biçimde reddedildi.',
    statusCode: 400,
  },
};

function safeStatusCode(value: unknown, fallback: number): number {
  const statusCode = Number(value);
  return Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
    ? statusCode
    : fallback;
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(value)
    ? value
    : fallback;
}

function controlledMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.slice(0, 500) : fallback;
}

function isTrustedDomainError(error: unknown): error is Error & {
  readonly code: string;
  readonly statusCode: number;
} {
  return (
    error instanceof IntentParserError ||
    error instanceof ArcAppKitPlanError ||
    error instanceof ArcPlanError ||
    error instanceof ArcOfficialPlanError ||
    error instanceof BaseIntentV2PlanError ||
    error instanceof BaseTokenLaunchError ||
    error instanceof BaseX402IntentError ||
    error instanceof IntentResponseError ||
    error instanceof EntityResolutionError
  );
}

function kletiaEngineError(error: unknown): IntentPublicError | null {
  if (!(error instanceof Error)) return null;
  const match = /^KEE_ERROR\|([A-Z_]+)\|/u.exec(error.message);
  if (!match) return null;
  const definition = KEE_ERRORS[match[1]];
  if (!definition) return null;
  return {
    code: match[1],
    message: definition.message,
    statusCode: definition.statusCode,
  };
}

export function resolveIntentPublicError(
  error: unknown,
  network: NetworkId,
): IntentPublicError {
  const fallback: IntentPublicError =
    network === 'arc'
      ? {
          code: 'ARC_ENGINE_ERROR',
          message:
            'Arc işlem planı güvenli biçimde hazırlanamadı.',
          statusCode: 502,
        }
      : {
          code: 'ENGINE_ERROR',
          message:
            'Base işlem planı güvenli biçimde hazırlanamadı.',
          statusCode: 502,
        };

  if (isTrustedDomainError(error)) {
    return {
      code: safeCode(error.code, fallback.code),
      message: controlledMessage(error.message, fallback.message),
      statusCode: safeStatusCode(error.statusCode, fallback.statusCode),
    };
  }

  const engineError = kletiaEngineError(error);
  if (engineError) return engineError;

  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : '';
  const definition = CONTROLLED_CODE_ERRORS[code];
  if (definition) {
    return {
      code,
      message: definition.message,
      statusCode: definition.statusCode,
    };
  }

  return fallback;
}
