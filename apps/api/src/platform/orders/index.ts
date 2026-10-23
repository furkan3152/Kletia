/**
 * Native protocol orders: the stable module path for other packages
 * (automation rules) and the HTTP layer.
 *
 *   import { nativeOrderProviders, planNativeOrder, type NativeOrderProvider } from "../orders/index.js";
 */
export type {
  Eip712Payload,
  NativeOrder,
  NativeOrderKind,
  NativeOrderMechanism,
  NativeOrderPlan,
  NativeOrderProtocol,
  NativeOrderProvider,
  NativeOrderQuote,
  NativeOrderRef,
  NativeOrderRequest,
  NativeOrderStatus,
  OrderAmount,
  OrderAmountSide,
  OrderNetwork,
  OrderSignRequest,
  OrderSubmission,
  PreparedOrderDraft,
  RelayResult,
} from "./types.js";
export { ORDER_NETWORKS } from "./types.js";
export { ORDER_LIMITS, ORDER_PERIOD_SECONDS, planAmounts, planNativeOrder, type NativeOrderInput, type OrderPeriod } from "./plan.js";
export { configureNativeOrderProviders, formatOrderId, nativeOrderProviders, parseOrderId, providerFor } from "./registry.js";
export { configurePreparationClock, PREPARATION_ID_PATTERN, resetPreparations, type PreparationView } from "./preparations.js";
export {
  cancelNativeOrder,
  listNativeOrders,
  MAX_ORDER_OWNERS,
  orderStatus,
  parseOrderNetwork,
  parseOwners,
  prepareNativeOrder,
  quoteNativeOrder,
  submitNativeOrder,
  type OrderListFailure,
  type SubmittedOrder,
} from "./service.js";
