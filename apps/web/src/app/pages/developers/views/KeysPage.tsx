import { KeysPage as KeysAndUsage } from "../keys/KeysPage";

/**
 * Keys and usage (`/developers/keys`): no key gate around the page, since
 * issuing a first key needs none; the list and usage sit behind KeyGate
 * inside it.
 */
export default function KeysPage() {
  return <KeysAndUsage />;
}
