import { useEffect, useState } from "react";

import { parseEmbedManifest, type EmbedManifest } from "./builderModel";

export type ManifestState = { readonly status: "loading" } | { readonly status: "unavailable" } | { readonly status: "ready"; readonly manifest: EmbedManifest };

/**
 * This deployment's `/sdk/embed/manifest.json` (the integrity the HTML
 * snippet pins). Read once per page view, never cached in storage.
 */
export function useEmbedManifest(webOrigin: string): ManifestState {
  const [state, setState] = useState<ManifestState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${webOrigin}/sdk/embed/manifest.json`, { signal: controller.signal, cache: "no-store", headers: { accept: "application/json" } })
      .then(async (response) => {
        const manifest = response.ok ? parseEmbedManifest(await response.json()) : null;
        setState(manifest ? { status: "ready", manifest } : { status: "unavailable" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [webOrigin]);
  return state;
}
