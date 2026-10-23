import { Link } from "../../../routes/Link";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { DataTable } from "../../../site/ui/DataTable";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { PortalPageHeader } from "../shell/PortalPageHeader";

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

interface EndpointRow {
  readonly path: string;
  readonly returns: string;
  readonly access: string;
}

const ENDPOINTS: readonly EndpointRow[] = [
  { path: "GET /v1/data/portfolio?evm=&solana=&lane=", returns: "Holdings, positions, loans and health, totals, allocation, 24 h change and PnL estimates", access: "public · one unit per account" },
  { path: "GET /v1/data/positions?evm=&solana=", returns: "Positions, loans and health (same read as the portfolio)", access: "public · one unit per account" },
  { path: "GET /v1/data/history?limit=", returns: "Your key's intents, receipts and links, newest first", access: "key · one unit" },
  { path: "GET /v1/data/markets/yields?network=&asset=", returns: "Supply APY of every venue, best first, with a deposit sentence", access: "public · one unit" },
  { path: "GET /v1/data/markets/prices?symbols=", returns: "USD prices with source and reading time", access: "public · one unit" },
  { path: "GET /v1/data/markets/status", returns: "Network status and route statistics", access: "public · one unit" },
  { path: "GET /v1/data/export?dataset=&format=", returns: "Holdings, positions or history as CSV or JSON", access: "as the read" },
];

const CURL = `# Everything two wallets hold on every production network
curl "https://api.kletiaai.xyz/v1/data/portfolio?evm=0x4f18…807D&solana=9WzD…AWWM"

# USDC rates, best first
curl "https://api.kletiaai.xyz/v1/data/markets/yields?asset=USDC"

# Holdings as a CSV download
curl -OJ "https://api.kletiaai.xyz/v1/data/export?dataset=holdings&evm=0x4f18…807D"`;

const SDK = `import { KletiaClient } from "@kletia/sdk";

// In a browser: a publishable key from your project (allowed origins only).
const kletia = new KletiaClient({ publishableKey: "kl_pub_…" });

const portfolio = await kletia.data.portfolio({ evm: "0x4f18…807D", solana: "9WzD…AWWM" });
console.log(portfolio.totals.net); // { usd, source, asOf, reason? }

for (const row of portfolio.health) {
  if (row.status === "warning" || row.status === "critical") console.warn(row.market, row.healthFactor);
}

const { yields } = await kletia.data.yields({ asset: "USDC" });
const csv = await kletia.data.exportCsv("positions", { evm: "0x4f18…807D" });`;

const VALUE = `{
  "usd": null,
  "source": "unpriced",
  "asOf": null,
  "reason": "No price source covers this asset."
}`;

/** Data API (`/developers/data`): the read-only dashboard endpoints, their rules and examples. */
export default function DataApiPage() {
  return (
    <>
      <PortalPageHeader
        title="Data API"
        intro="Read-only data for dashboards: what a set of wallets holds on every network, its positions, loans and health, your key's activity, venue rates, prices and network status. Nothing here signs or moves money."
      />
      <section aria-labelledby="data-endpoints" className="flex min-w-0 flex-col gap-3">
        <h2 id="data-endpoints" className="font-display text-display-s font-bold">
          Endpoints
        </h2>
        <DataTable<EndpointRow>
          caption="Data API endpoints"
          columns={[
            { key: "path", header: "Endpoint", phone: "primary", cell: (row) => <code className="break-all font-code text-code font-bold">{row.path}</code> },
            { key: "returns", header: "Returns", cell: (row) => row.returns },
            { key: "access", header: "Access", cell: (row) => <span className={cx(LABEL, "whitespace-nowrap", TEXT_MUTED)}>{row.access}</span> },
          ]}
          rows={ENDPOINTS}
          rowKey={(row) => row.path}
        />
        <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
          Name up to two EVM and two Solana addresses; each is read on every network of the lane. Publishable keys may call every endpoint. The data
          budget is 240 units a minute per key and 60 per address without one.
        </p>
      </section>
      <section aria-labelledby="data-values" className="mt-8 grid min-w-0 gap-6 xl:grid-cols-2">
        <div className={cx("flex flex-col gap-3 p-5 text-sm", INK_BORDER, SURFACE)}>
          <h2 id="data-values" className="font-display text-xl font-bold">
            Unknown is never zero
          </h2>
          <p className={TEXT_MUTED}>
            Every value carries <code className="font-code">source</code> and <code className="font-code">asOf</code>. A value Kletia could not read or
            price is <code className="font-code">null</code> with a reason, and unread accounts or venues are listed in{" "}
            <code className="font-code">failures</code>. Totals then cover the known part and say so.
          </p>
          <p className={TEXT_MUTED}>
            The 24-hour change and the PnL figure compare with this API&apos;s own earlier readings: they are estimates that count deposits and
            withdrawals too, never realised profit.
          </p>
        </div>
        <CodeBlock code={VALUE} language="json" label="An unknown value" filename="value.json" />
      </section>
      <div className="mt-8 grid min-w-0 gap-6 xl:grid-cols-2">
        <CodeBlock code={CURL} language="bash" label="Data API with curl" filename="data.sh" />
        <CodeBlock code={SDK} language="ts" label="Data API with the SDK" filename="dashboard.ts" />
      </div>
      <p className={cx("mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm", TEXT_MUTED)}>
        <Link to="/developers/api" className={LINK}>
          Try it in the API explorer
        </Link>
        <Link to="/app/dashboard" className={LINK}>
          Open your dashboard
        </Link>
      </p>
    </>
  );
}
