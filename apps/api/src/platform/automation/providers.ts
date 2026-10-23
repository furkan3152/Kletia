/**
 * Native order providers (protocol order types that execute without the
 * owner online). None is registered here: the order-type package registers
 * its providers at boot. A run is offered to the first provider that
 * supports its automation; a declined or failing offer falls back to the
 * owner's signature, never to a guess.
 */
import type { AutomationView, NativeOrderProvider } from "@kletia/core";

let providers: readonly NativeOrderProvider[] = [];

/** Replaces the registered providers (boot, tests). */
export function configureNativeOrderProviders(next: readonly NativeOrderProvider[]): void {
  providers = [...next];
}

/** The provider that executes this automation's runs, if any. */
export function nativeProviderFor(view: AutomationView): NativeOrderProvider | null {
  for (const provider of providers) {
    try {
      if (provider.supports(view)) return provider;
    } catch (error) {
      console.warn(`[platform] native order provider ${provider.id} failed its support check:`, error instanceof Error ? error.message : error);
    }
  }
  return null;
}
