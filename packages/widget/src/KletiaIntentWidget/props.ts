/**
 * Widget props, default examples and the widget's API client.
 */
import type {
  AccountId,
  IntentGraph,
  KletiaAppearance,
  NetworkKey,
  SessionView,
  SourceNetwork,
} from "@kletia/core";
import {
  KletiaClient,
  type IntentSigners,
  type KletiaClientOptions,
} from "@kletia/sdk";
import type { ClarifyEvent } from "../review.js";
import type { WidgetAction } from "../scope.js";

export const DEFAULT_WIDGET_EXAMPLES: readonly string[] = [
  "swap 1 SOL to USDC",
  "bridge 25 USDC from base to solana",
  "move 0.01 ETH from arbitrum to solana as SOL",
  "stake 1.5 SOL with jito",
];

export interface KletiaIntentWidgetProps {
  /** An existing client, or options to create one (keep `clientOptions` stable, e.g. with useMemo). */
  readonly client?: KletiaClient;
  readonly clientOptions?: KletiaClientOptions;
  /**
   * Your project's publishable key (`kl_pub_…`, safe in browser code): the
   * widget's client sends it as `Authorization: Bearer kl_pub_…`, so intents
   * are owned by your project and your allowed origins and rule book apply.
   * Ignored when `client` is given (that client's key is used). Never pass a
   * secret key here; the SDK refuses anything that is not a publishable key.
   */
  readonly publishableKey?: string;
  /** CAIP-10 accounts the user controls. Required to plan. */
  readonly accounts: readonly AccountId[];
  /** Wallet signers. When omitted, the widget plans and reviews but does not execute. */
  readonly signers?: IntentSigners;
  readonly defaultText?: string;
  readonly examples?: readonly string[];
  /** Colour scheme (default: `appearance.colorScheme`, else `auto`, which follows the visitor's system). */
  readonly theme?: "light" | "dark" | "auto";
  /**
   * Appearance tokens (`kletia.appearance/v1`): colours with contrast floors,
   * radius, border, shadow, font, density and header. Safety surfaces (the
   * fare, contract reviews, policy holds, stamps, the footer) never change.
   */
  readonly appearance?: KletiaAppearance;
  /**
   * Networks this widget works with. A plan that touches any other network
   * (a bridge destination or a recipient included) is refused before Execute.
   */
  readonly networks?: readonly NetworkKey[];
  /** Kinds of action this widget offers (swap, bridge, transfer, stake, deposit, withdraw); other plans are refused before Execute. */
  readonly actions?: readonly WidgetAction[];
  /**
   * Where the money starts: a network key (kept inside `networks`) or
   * `"auto"` (Kletia picks the funded network). Sent as the request's
   * `sourceNetwork`; with preview accounts `"auto"` behaves as absent.
   */
  readonly sourceNetwork?: SourceNetwork;
  readonly maxSlippageBps?: number;
  /** Opaque metadata attached to created intents (e.g. your order id). */
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * Open an intent your backend created with its API key (`int_…`) instead
   * of planning one from text: the widget shows its review and fare, and the
   * user signs it with the wallet the intent was planned for.
   */
  readonly intentId?: string;
  /**
   * Run a session your backend created (`cs_…`): the widget shows who is
   * asking and what, and turns it into an intent for the connected wallet.
   */
  readonly sessionId?: string;
  /**
   * Origin of the page the visitor is on, sent with session intents (it
   * must be in the session's `allowedOrigins`). Defaults to this page's
   * origin; the hosted `/embed` frame passes its proven host origin.
   */
  readonly hostOrigin?: string | null;
  /** Ask for the asset-change preview ("fare breakdown") with every plan (default true). */
  readonly preview?: boolean;
  /**
   * Rebuild approval and receipt links on this origin when the API returns
   * non-https ones (the Kletia web app itself, for local development).
   */
  readonly linkOrigin?: string | null;
  readonly onIntentCreated?: (intent: IntentGraph) => void;
  /** An intent named by `intentId` was loaded (it was created elsewhere, so `onIntentCreated` does not fire). */
  readonly onIntentOpened?: (intent: IntentGraph) => void;
  /** A session named by `sessionId` was loaded (who is asking and what; the `/embed` frame offers only the wallets it needs). */
  readonly onSessionLoaded?: (session: SessionView) => void;
  readonly onUpdate?: (intent: IntentGraph) => void;
  readonly onComplete?: (intent: IntentGraph) => void;
  readonly onError?: (error: unknown) => void;
  /**
   * Kletia asked a clarifying question: how many, why (reason codes), of
   * what kind and whether only the person can answer (`purpose`). Never the
   * values, the options or the sentence.
   */
  readonly onClarify?: (event: ClarifyEvent) => void;
  readonly className?: string;
}

/**
 * The widget's client: `client` when given, else one built from
 * `clientOptions` with the publishable key (sent as `Authorization: Bearer
 * kl_pub_…`). With a key and an explicit `hostOrigin` (the hosted frame's
 * proven host), requests also carry `Kletia-Host-Origin`, which the API
 * checks against the project's allowed origins.
 */
export function createWidgetClient(options: Pick<KletiaIntentWidgetProps, "client" | "clientOptions" | "publishableKey" | "hostOrigin">): KletiaClient {
  if (options.client) return options.client;
  const { clientOptions, publishableKey, hostOrigin } = options;
  if (!publishableKey) return new KletiaClient(clientOptions);
  const headers = typeof hostOrigin === "string" && hostOrigin ? { ...clientOptions?.headers, "kletia-host-origin": hostOrigin } : clientOptions?.headers;
  return new KletiaClient({ ...clientOptions, publishableKey, ...(headers ? { headers } : {}) });
}
