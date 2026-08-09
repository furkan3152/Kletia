import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Route, Zap } from 'lucide-react';
import { useAccount, useChainId } from 'wagmi';
import {
  assertArcAppKitPlan,
  arcAppKitPlanFingerprint,
  getArcAppKitJournalState,
  executeArcAppKitPlan,
  quoteArcAppKitPlan,
  retryArcAppKitBridge,
  type ArcAppKitExecutionResult,
  type ArcAppKitQuote,
} from '../../arc/appKitRuntime';
import { NETWORKS } from '../../config/networks';
import type { ArcAppKitExecutionPlan } from '../../types';

type Props = {
  plan: ArcAppKitExecutionPlan;
  expectedAddress: string;
  expiresAt: number;
  disabled?: boolean;
  executionStatus?: ArcAppKitExecutionResult['state'];
  beforeExecute?: () => Promise<void>;
  onLog: (message: string) => void;
  onComplete: (result: ArcAppKitExecutionResult) => void;
};

const quoteLifetimeMs = 60_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'Circle App Kit isteği tamamlanamadı.';

export function ArcAppKitRouteCard({
  plan,
  expectedAddress,
  expiresAt,
  disabled = false,
  executionStatus,
  beforeExecute,
  onLog,
  onComplete,
}: Props) {
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const [quote, setQuote] = useState<ArcAppKitQuote | null>(null);
  const [quoteObservedAt, setQuoteObservedAt] = useState(0);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fingerprint = arcAppKitPlanFingerprint(plan);
  const [journalOverride, setJournalOverride] = useState<{
    fingerprint: string;
    entry: ReturnType<typeof getArcAppKitJournalState>;
  } | null>(null);
  const journalState =
    journalOverride?.fingerprint === fingerprint
      ? journalOverride.entry
      : getArcAppKitJournalState(plan, expectedAddress);
  const autoQuoteKey = useRef<string | null>(null);
  const effectiveStatus = executionStatus || journalState?.state;
  const statusMessage = journalState?.statusMessage;
  const sessionMatches =
    chainId === NETWORKS.arc.chainId &&
    address?.toLowerCase() === expectedAddress.toLowerCase();

  const refreshQuote = async () => {
    setError(null);
    setQuote(null);
    if (!connector || !address || !sessionMatches) {
      setError('Canlı App Kit tahmini için aynı Arc cüzdan oturumu gerekli.');
      return;
    }
    if (Date.now() >= expiresAt) {
      setError('Niyet planının süresi doldu; cümleyi yeniden gönderin.');
      return;
    }
    setIsQuoting(true);
    try {
      assertArcAppKitPlan(plan);
      onLog('Circle App Kit canlı tahmini isteniyor; işlem imzası istenmedi.');
      const nextQuote = await quoteArcAppKitPlan(
        connector,
        address,
        plan,
      );
      setQuote(nextQuote);
      setQuoteObservedAt(Date.now());
      onLog('Circle App Kit ücret ve çıktı tahmini alındı.');
    } catch (quoteError) {
      const message = errorMessage(quoteError);
      setError(message);
      onLog(`Circle App Kit tahmini alınamadı: ${message}`);
    } finally {
      setIsQuoting(false);
    }
  };

  useEffect(() => {
    const key = `${plan.traceId}:${expectedAddress.toLowerCase()}`;
    if (
      autoQuoteKey.current === key ||
      disabled ||
      effectiveStatus ||
      !connector ||
      !address ||
      !sessionMatches
    ) {
      return;
    }
    autoQuoteKey.current = key;
    void refreshQuote();

  }, [
    address,
    effectiveStatus,
    connector,
    disabled,
    expectedAddress,
    plan.traceId,
    sessionMatches,
  ]);

  const execute = async () => {
    setError(null);
    if (!connector || !address || !sessionMatches) {
      setError('İşlem farklı bir ağ veya cüzdan oturumunda yürütülemez.');
      return;
    }
    const isRecovery =
      effectiveStatus === 'recoverable' && plan.operation === 'bridge';
    if (
      !isRecovery &&
      (!quote || Date.now() - quoteObservedAt > quoteLifetimeMs)
    ) {
      setError('Canlı tahmin eskidi. Önce tahmini yenileyin.');
      return;
    }
    if (
      !isRecovery &&
      quote &&
      (quote.planFingerprint !== fingerprint ||
        quote.expectedAddress.toLowerCase() !== address.toLowerCase())
    ) {
      setError(
        'Canlı tahmin bu niyet/cüzdan oturumuna bağlı değil. Tahmini yenileyin.',
      );
      return;
    }
    if (!isRecovery && Date.now() >= expiresAt) {
      setError('Niyet planının süresi doldu; cümleyi yeniden gönderin.');
      return;
    }
    setIsExecuting(true);
    try {
      if (beforeExecute) {
        onLog(
          'Değişebilir alıcı kimliği App Kit yürütmesinden hemen önce yeniden doğrulanıyor.',
        );
        await beforeExecute();
        onLog('Alıcı kimliği güncel resolver kanıtıyla eşleşiyor.');
      }
      onLog(
        isRecovery
          ? 'Tamamlanan bridge adımları korunarak resmî SDK retry akışı başlatılıyor.'
          : 'Kullanıcı onayı için resmî Circle App Kit yürütmesi başlatılıyor.',
      );
      const result = isRecovery
        ? await retryArcAppKitBridge(connector, address, plan)
        : await executeArcAppKitPlan(connector, address, plan);
      result.steps.forEach((step) => {
        onLog(
          `${step.name}: ${step.state}` +
            `${step.forwarded ? ' / Circle Forwarder' : ''}` +
            `${step.batched ? ' / atomic wallet batch' : ''}`,
        );
      });
      setJournalOverride({
        fingerprint,
        entry: {
          state: result.state,
          statusMessage: result.statusMessage,
          txHash: result.txHash,
        },
      });
      onComplete(result);
    } catch (executionError) {
      const message = errorMessage(executionError);
      setError(message);
      onLog(`Circle App Kit yürütmesi durdu: ${message}`);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="mt-5 flex w-full flex-col gap-4 border-[3px] border-[#1A1A1A] bg-white p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#0F172A] dark:text-white dark:shadow-[4px_4px_0_#475569] sm:w-80 md:w-[450px] md:p-5">
      <div className="flex items-center justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-2 text-xs font-black uppercase tracking-widest dark:border-[#4B5563] md:text-sm">
        <span className="flex items-center gap-2">
          <Route className="h-4 w-4 text-[#8B5CF6] md:h-5 md:w-5" />
          Arc Money Route
        </span>
        <span className="border-[2px] border-[#1A1A1A] bg-[#FACC15] px-2 py-1 text-[10px] text-[#1A1A1A]">
          TESTNET
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs font-bold">
        <div className="border-[2px] border-[#1A1A1A] bg-[#EFEFEF] p-2 text-[#1A1A1A] dark:border-[#4B5563]">
          <span className="block text-[9px] font-black uppercase text-gray-500">
            Provider
          </span>
          Circle App Kit
        </div>
        <div className="border-[2px] border-[#1A1A1A] bg-[#EFEFEF] p-2 text-[#1A1A1A] dark:border-[#4B5563]">
          <span className="block text-[9px] font-black uppercase text-gray-500">
            Operation
          </span>
          {plan.operation.replace('_', ' ')}
        </div>
      </div>

      {isQuoting ? (
        <div className="flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#EDE9FE] p-3 text-sm font-black text-[#1A1A1A]">
          <Loader2 className="h-5 w-5 animate-spin" />
          Resmî SDK tahmini alınıyor…
        </div>
      ) : quote ? (
        <div className="space-y-2 border-[3px] border-[#1A1A1A] bg-[#D1FAE5] p-3 text-sm font-bold text-[#1A1A1A]">
          <div className="font-black">{quote.headline}</div>
          {quote.minimumOutput && (
            <div>Korunan minimum: {quote.minimumOutput}</div>
          )}
          <div className="text-xs">
            {quote.fees.length > 0
              ? quote.fees.map((fee) => (
                  <div key={fee}>Ücret: {fee}</div>
                ))
              : 'SDK sağlayıcı ücret kalemi döndürmedi.'}
          </div>
          <div className="border-t-[2px] border-[#1A1A1A] pt-2 text-[10px] leading-relaxed">
            {quote.feeDisclosure}
          </div>
          <div className="text-[10px] uppercase text-gray-600">
            Tahmin zamanı: {new Date(quote.observedAt).toLocaleTimeString()}
          </div>
        </div>
      ) : null}

      {error && (
        <div className="border-[3px] border-[#1A1A1A] bg-[#FCA5A5] p-3 text-xs font-black text-[#1A1A1A]">
          {error}
        </div>
      )}

      {effectiveStatus && (
        <div
          className={`border-[3px] border-[#1A1A1A] p-3 text-xs font-black text-[#1A1A1A] ${
            effectiveStatus === 'success'
              ? 'bg-[#86EFAC]'
              : effectiveStatus === 'pending'
                ? 'bg-[#FDE68A]'
                : effectiveStatus === 'recoverable'
                  ? 'bg-[#FDBA74]'
                  : 'bg-[#FCA5A5]'
          }`}
        >
          {statusMessage ||
            (effectiveStatus === 'success'
              ? 'Circle App Kit işlemi tamamlandı.'
              : effectiveStatus === 'pending'
                ? 'Kaynak işlem gönderildi; aynı niyeti yeniden göndermeyin.'
                : effectiveStatus === 'recoverable'
                  ? 'Bridge kaldığı yerden güvenli biçimde devam ettirilebilir.'
                  : 'Yeniden gönderim güvenlik için engellendi.')}
        </div>
      )}

      <button
        type="button"
        onClick={() => void refreshQuote()}
        disabled={
          disabled ||
          Boolean(effectiveStatus) ||
          isQuoting ||
          isExecuting ||
          !sessionMatches
        }
        className="flex w-full items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-white py-3 text-xs font-black uppercase tracking-wider text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] transition-all enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#4B5563]"
      >
        <RefreshCw className={`h-4 w-4 ${isQuoting ? 'animate-spin' : ''}`} />
        Tahmini Yenile
      </button>

      <button
        type="button"
        onClick={() => void execute()}
        disabled={
          disabled ||
          (Boolean(effectiveStatus) &&
            effectiveStatus !== 'recoverable') ||
          isQuoting ||
          isExecuting ||
          (!quote && effectiveStatus !== 'recoverable') ||
          !sessionMatches
        }
        className={`flex w-full items-center justify-center gap-2 border-[3px] border-[#1A1A1A] py-3 text-sm font-black uppercase tracking-wide text-white shadow-[3px_3px_0_#1A1A1A] transition-all enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 ${
          effectiveStatus === 'success'
            ? 'bg-[#10B981]'
            : effectiveStatus === 'recoverable'
              ? 'bg-[#EA580C]'
              : effectiveStatus
                ? 'bg-[#64748B]'
                : 'bg-[#8B5CF6]'
        }`}
      >
        {isExecuting ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : effectiveStatus === 'success' ? (
          <CheckCircle2 className="h-5 w-5" />
        ) : (
          <Zap className="h-5 w-5" />
        )}
        {isExecuting
          ? 'App Kit Çalışıyor'
          : effectiveStatus === 'success'
            ? 'Tamamlandı'
            : effectiveStatus === 'pending'
              ? 'Kaynak Gönderildi — Bekleniyor'
              : effectiveStatus === 'recoverable'
                ? 'Kaldığı Yerden Devam Et'
                : effectiveStatus === 'blocked'
                  ? 'Yeniden Gönderme — İncele'
            : 'Tahmini Onayla ve Yürüt'}
      </button>

      <p className="text-[10px] font-bold leading-relaxed text-gray-500">
        Circle App Kit hata telemetrisi kapalıdır. Bu rota Circle SDK tarafından
        hazırlanıp gönderilir; Kletia plan/hesap/ağ/sonuç sınırlarını doğrular
        fakat standart Kletia işlem simülatörünün içinden geçmez. Bridge yalnızca
        Arc Testnet’ten izinli testnet hedeflerine gider; Base Mainnet bu rota
        havuzuna dahil edilmez.
      </p>
    </div>
  );
}
