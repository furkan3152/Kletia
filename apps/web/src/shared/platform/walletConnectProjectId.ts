/**
 * The WalletConnect (Reown) project id the build was given, or null when it
 * cannot be a real one. A Reown project id is 32 hexadecimal characters;
 * anything else (empty, a template placeholder such as
 * `<REOWN_WALLETCONNECT_PROJECT_ID>` or `your_project_id`, a URL, a quoted
 * value) would make WalletConnect show a button whose connection can never
 * open, so the option is hidden instead. Pure: node --test loads it.
 */
const PROJECT_ID = /^[0-9a-f]{32}$/iu;

export function walletConnectProjectId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return PROJECT_ID.test(value) ? value.toLowerCase() : null;
}

/**
 * The build's warning for a WalletConnect project id that is set but cannot be
 * a real one (vite.config.ts prints it): the site still builds, with
 * WalletConnect hidden, so the mistake would otherwise go unnoticed. Null when
 * the id is valid or not set at all.
 */
export function walletConnectBuildWarning(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "" || walletConnectProjectId(raw)) return null;
  return "VITE_WALLETCONNECT_PROJECT_ID is set but is not a 32-character hexadecimal Reown project id, so WalletConnect is hidden in this build. Set the id from the Reown dashboard, or leave the variable empty.";
}
