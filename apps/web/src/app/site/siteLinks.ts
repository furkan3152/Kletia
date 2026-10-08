/** Public links used across the site. */
export const GITHUB_URL = "https://github.com/furkan3152/Kletia";
export const SECURITY_POLICY_URL = `${GITHUB_URL}/blob/main/SECURITY.md`;
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const CONTRIBUTING_URL = `${GITHUB_URL}/blob/main/CONTRIBUTING.md`;
export const API_DOC_URL = `${GITHUB_URL}/blob/main/docs/platform/api-v1.md`;
export const SOLANA_DOC_URL = `${GITHUB_URL}/blob/main/docs/networks/solana.md`;
export const BASE_MCP_DOC_URL = `${GITHUB_URL}/blob/main/docs/base-mcp/README.md`;
export const CORE_PACKAGE_URL = `${GITHUB_URL}/tree/main/packages/core`;
export const SDK_PACKAGE_URL = `${GITHUB_URL}/tree/main/packages/sdk`;

export interface NavItem {
  readonly label: string;
  readonly to: string;
  readonly external?: boolean;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { label: "Product", to: "/#product" },
  { label: "Developers", to: "/developers" },
  { label: "Networks", to: "/networks" },
  { label: "Studio", to: "/studio" },
  { label: "GitHub", to: GITHUB_URL, external: true },
];
