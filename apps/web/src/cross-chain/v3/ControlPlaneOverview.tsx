import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Coins,
  Database,
  ExternalLink,
  GitBranch,
  Loader2,
  LockKeyhole,
  Network,
  RefreshCw,
  Scale,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { BACKEND_URL } from "../../shared/config/runtime";
import {
  isCapabilitiesV3Response,
  type CapabilitiesV3Response,
  type ChainKeyV3,
  type ProtocolCapabilityV3View,
} from "./types";

const chainLabels: Record<ChainKeyV3, string> = {
  base_mainnet: "Base",
  arbitrum_one: "Arbitrum One",
  arc_testnet: "Arc",
  stellar_testnet: "Stellar",
  arbitrum_sepolia: "Arbitrum Sepolia",
  stellar_mainnet: "Stellar Mainnet",
};

const solverLifecycle = [
  {
    label: "Bond",
    detail: "A solver locks the configured Stellar asset against this exact workflow root.",
  },
  {
    label: "Commit",
    detail: "Route economics are hidden behind a salted commitment while competing bids are collected.",
  },
  {
    label: "Reveal",
    detail: "Route hash, promised output, fee, duration and solver identity become public Stellar state.",
  },
  {
    label: "Select",
    detail: "Expired or unbonded bids are rejected; highest promised net output wins, then shortest duration.",
  },
  {
    label: "Execute",
    detail: "The winning route still needs normal wallet signatures and foreign-chain evidence at each checkpoint.",
  },
  {
    label: "Resolve",
    detail: "Success releases bond, provable solver fault may slash it, and uncertainty stays recoverable without silent retry.",
  },
] as const;

function CapabilityStatus({ capability }: { capability: ProtocolCapabilityV3View }) {
  if (capability.executionEnabled && capability.readiness.includes("verify")) {
    return (
      <span className="stellar-v3-status" data-state="ready">
        <CheckCircle2 aria-hidden="true" /> Execute + verify
      </span>
    );
  }
  if (capability.readiness.includes("read") || capability.readiness.includes("quote")) {
    return (
      <span className="stellar-v3-status" data-state="partial">
        <AlertTriangle aria-hidden="true" /> Read / quote only
      </span>
    );
  }
  return (
    <span className="stellar-v3-status" data-state="blocked">
      <XCircle aria-hidden="true" /> Unavailable
    </span>
  );
}

function LaneMap({
  label,
  chains,
  centered,
}: {
  label: string;
  chains: readonly ChainKeyV3[];
  centered: boolean;
}) {
  return (
    <article className="stellar-v3-lane">
      <div className="stellar-v3-lane-heading">
        <strong>{label}</strong>
        <span>{centered ? "Control plane lane" : "Liquidity lane"}</span>
      </div>
      <div className="stellar-v3-chain-row" aria-label={`${label} network topology`}>
        {chains.filter((chain) => chain !== "stellar_mainnet").map((chain, index, visible) => (
          <React.Fragment key={chain}>
            <span
              className="stellar-v3-chain"
              data-center={chain === "stellar_testnet" ? "true" : "false"}
            >
              {chainLabels[chain]}
            </span>
            {index < visible.length - 1 ? (
              <GitBranch className="stellar-v3-link" aria-hidden="true" />
            ) : null}
          </React.Fragment>
        ))}
      </div>
      <p>
        {centered
          ? "Arc, Stellar and Arbitrum Sepolia share one checkpointed Testnet workflow. The corridor is staged, public and has no global rollback."
          : "Base and Arbitrum One compare reviewed production bridges. Testnet assets are rejected from this lane."}
      </p>
    </article>
  );
}

export function ControlPlaneOverview() {
  const [capabilities, setCapabilities] = React.useState<CapabilitiesV3Response | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/api/capabilities`, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json();
        if (!response.ok || !isCapabilitiesV3Response(body)) {
          throw new Error("The server capability manifest did not pass its schema boundary.");
        }
        setCapabilities(body);
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setCapabilities(null);
        setError(caught instanceof Error ? caught.message : "Capability manifest unavailable.");
      }
    };
    void load();
    return () => controller.abort();
  }, [reloadNonce]);

  const prioritizedProtocols = React.useMemo(() => {
    if (!capabilities) return [];
    const order = [
      "stellar-classic",
      "circle-cctp-v2",
      "aquarius",
      "soroswap",
      "blend-v2",
      "defindex",
      "stellar-mpp",
      "arbitrum-camelot",
      "arbitrum-compound-v3",
    ];
    return [...capabilities.protocols]
      .filter((capability) => order.includes(capability.id))
      .sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
  }, [capabilities]);

  const controlPlaneContracts = React.useMemo(() => {
    if (!capabilities) return [];
    const generated = capabilities.controlPlane.readiness.generatedVerifierExecutable;
    return [
      ...capabilities.controlPlane.readiness.contracts,
      ...(generated ? [{ key: "policyGroth16Verifier", ...generated }] : []),
    ];
  }, [capabilities]);

  return (
    <section className="stellar-panel stellar-v3-overview" aria-labelledby="stellar-v3-title">
      <div className="stellar-panel-header">
        <div>
          <p className="stellar-eyebrow">Unified capability truth</p>
          <h2 id="stellar-v3-title">Stellar Intent Control Plane</h2>
        </div>
        <button
          type="button"
          className="stellar-v3-refresh"
          onClick={() => {
            setCapabilities(null);
            setReloadNonce((current) => current + 1);
          }}
          aria-label="Refresh live control-plane readiness"
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="stellar-v3-error" role="alert">
          <XCircle aria-hidden="true" />
          <div>
            <strong>Capability manifest unavailable</strong>
            <p>{error} Financial controls remain disabled; no fallback data is shown.</p>
          </div>
        </div>
      ) : capabilities === null ? (
        <div className="stellar-v3-loading" role="status">
          <Loader2 className="animate-spin" aria-hidden="true" />
          Reading the server-signed capability boundary…
        </div>
      ) : (
        <>
          <div className="stellar-v3-lanes">
            <LaneMap label="Production" chains={capabilities.lanes.production} centered={false} />
            <LaneMap label="Testnet" chains={capabilities.lanes.testnet} centered />
          </div>

          <div className="stellar-v3-truth-grid">
            <article>
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>Control-plane source</strong>
                <p>
                  {capabilities.controlPlane.sourceReady
                    ? "Contract source and tests are present."
                    : "Source readiness failed."}
                </p>
              </div>
            </article>
            <article>
              <LockKeyhole aria-hidden="true" />
              <div>
                <strong>Onchain activation</strong>
                <p>
                  {capabilities.controlPlane.testnetExecutionEnabled
                    ? "Pinned Stellar Testnet development deployment is live."
                    : "Runtime attestation failed; signing stays closed."}
                </p>
              </div>
            </article>
            <article>
              <Database aria-hidden="true" />
              <div>
                <strong>Workflow recovery</strong>
                <p>
                  {capabilities.workflowStore.status === "ready"
                    ? `Durable ${capabilities.workflowStore.backend ?? "store"} ready.`
                    : "Durable workflow store unavailable."}
                </p>
              </div>
            </article>
            <article>
              <Network aria-hidden="true" />
              <div>
                <strong>Artifact profile</strong>
                <p>
                  {capabilities.controlPlane.readiness.artifactProfile === "testnet_development"
                    ? "Testnet development · never Mainnet"
                    : "Artifact profile unavailable"}
                </p>
              </div>
            </article>
            <article>
              <Scale aria-hidden="true" />
              <div>
                <strong>Solver competition</strong>
                <p>
                  {capabilities.solverMarket.ready
                    ? "Bonded commit–reveal market live on Testnet."
                    : "Source tested; deployment gate remains closed."}
                </p>
              </div>
            </article>
          </div>

          <details className="stellar-v3-deployments">
            <summary>
              <span>Inspect live Testnet contracts</span>
              <small>{controlPlaneContracts.filter((entry) => entry.ready).length}/{controlPlaneContracts.length} runtime checks ready</small>
            </summary>
            <div>
              {controlPlaneContracts.map((entry) => (
                <a
                  key={entry.key}
                  href={entry.contractId
                    ? `https://stellar.expert/explorer/testnet/contract/${entry.contractId}`
                    : undefined}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!entry.contractId}
                >
                  <span>
                    <strong>{entry.key.replace(/([A-Z])/gu, " $1")}</strong>
                    <code>{entry.contractId || "Not configured"}</code>
                  </span>
                  {entry.ready ? <CheckCircle2 aria-label="Ready" /> : <XCircle aria-label="Unavailable" />}
                </a>
              ))}
              <a
                href="https://github.com/furkan3152/Kletia/blob/main/contracts/stellar/deployments/testnet/control-plane.v1.json"
                target="_blank"
                rel="noreferrer"
              >
                <span>
                  <strong>Deployment evidence</strong>
                  <code>{capabilities.controlPlane.readiness.deploymentManifest}</code>
                </span>
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
          </details>

          <details className="stellar-v3-deployments">
            <summary>
              <span>Inspect solver-market release</span>
              <small>{capabilities.solverMarket.contracts.filter((entry) => entry.ready).length}/{capabilities.solverMarket.contracts.length} runtime checks ready</small>
            </summary>
            <div>
              {capabilities.solverMarket.contracts.map((entry) => (
                <a
                  key={entry.key}
                  href={entry.contractId
                    ? `https://stellar.expert/explorer/testnet/contract/${entry.contractId}`
                    : undefined}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!entry.contractId}
                >
                  <span>
                    <strong>{entry.key.replace(/([A-Z])/gu, " $1")}</strong>
                    <code>{entry.contractId || "Not deployed"}</code>
                  </span>
                  {entry.ready ? <CheckCircle2 aria-label="Ready" /> : <XCircle aria-label="Unavailable" />}
                </a>
              ))}
            </div>
          </details>

          <section className="stellar-v3-market" aria-labelledby="stellar-v3-market-title">
            <div className="stellar-v3-market-heading">
              <div>
                <p className="stellar-eyebrow">Cross-chain coordination</p>
                <h3 id="stellar-v3-market-title">Bonded route competition</h3>
              </div>
              <span className="stellar-v3-status" data-state={capabilities.solverMarket.ready ? "ready" : "blocked"}>
                {capabilities.solverMarket.ready ? <CheckCircle2 aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
                {capabilities.solverMarket.ready ? "Testnet ready" : "Deploy last"}
              </span>
            </div>
            <ol className="stellar-v3-market-flow">
              {solverLifecycle.map((step, index) => (
                <li key={step.label}>
                  <span aria-hidden="true">{index + 1}</span>
                  <div>
                    <strong>{step.label}</strong>
                    <p>{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="stellar-v3-market-facts">
              <p>
                <strong>Public after reveal:</strong> solver identity, route hash, promised output,
                fee, duration and ledger timing. Commit–reveal prevents bid copying; it does not
                make the auction private or prove the quote true.
              </p>
              <p>
                <strong>Recovery:</strong>{" "}
                {capabilities.solverMarket.bindings
                  ? `unresolved bonds can be reclaimed after the ${capabilities.solverMarket.bindings.resolutionGraceLedgers}-ledger grace window.`
                  : "the reviewed source includes a bounded post-settlement grace window and solver-controlled reclaim path."}
              </p>
            </div>
          </section>

          <div className="stellar-v3-boundary">
            <Coins aria-hidden="true" />
            <p>
              <strong>Stellar has an economic job:</strong> complex and cross-chain intents can request competing hidden bids backed by a workflow-scoped Stellar asset bond. The auction rejects stale bids and selects promised net output; settlement evidence still decides whether a bond is released or, only for provable solver fault, slashed. Bridge delay and indeterminate results are never automatic fault.
            </p>
          </div>

          <div className="stellar-v3-boundary">
            <LockKeyhole aria-hidden="true" />
            <p>
              <strong>Privacy is field minimization, not anonymity.</strong> Stellar records policy and receipt commitments only for eligible complex workflows. It does not prove a foreign-chain result by itself, hide public CCTP transfers, or prevent replay outside Kletia.
            </p>
          </div>

          <div className="stellar-v3-boundary">
            <GitBranch aria-hidden="true" />
            <p>
              <strong>V3 migration boundary:</strong> the unified compiler can compare and seal plans. Its advance endpoint now performs only the exact live reads listed by the server—Stellar portfolio and Arbitrum Sepolia Aave portfolio/borrow capacity—with explicit provider disclosure. Reviewed Workflow V2 and network-local engines remain the financial execution path; V3 rejects unbound calldata or XDR instead of silently delegating.
            </p>
          </div>

          <div className="stellar-v3-boundary">
            <ShieldCheck aria-hidden="true" />
            <p>
              <strong>Device proof boundary:</strong> policy roots and nullifiers are not generated by the API. The live Testnet development verifier accepts only the pinned nine-input circuit; the raw proof is not persisted. Browser-side source hydrates the exact control-plane and receipt-registry XDR through recording and enforcing simulation. The connected Freighter account—not the deployment account—must still review, sign and submit each call.
            </p>
          </div>

          <div className="stellar-v3-protocols" aria-label="Protocol capability matrix">
            {prioritizedProtocols.map((capability) => (
              <article key={capability.id} className="stellar-v3-protocol">
                <div className="stellar-v3-protocol-heading">
                  <div>
                    <strong>{capability.label}</strong>
                    <small>{capability.chains.map((chain) => chainLabels[chain]).join(" · ")}</small>
                  </div>
                  <CapabilityStatus capability={capability} />
                </div>
                <p>
                  {capability.reason ||
                    `${capability.operations.join(", ")} are bound to ${capability.deploymentBinding.mode.replace("_", " ")} identities.`}
                </p>
                <div className="stellar-v3-protocol-footer">
                  <span>
                    No mock data
                    {capability.executionChains?.length
                      ? ` · execution: ${capability.executionChains.map((chain) => chainLabels[chain]).join(", ")}`
                      : ""}
                  </span>
                  {capability.officialSources[0] ? (
                    <a href={capability.officialSources[0]} target="_blank" rel="noreferrer">
                      Official source <ExternalLink aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
