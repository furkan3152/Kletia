/**
 * Pin drift of a link (intent-links design §3.7 step 4, §9 T7/T8): pinned
 * recipient names are resolved again and pinned registrations are read
 * from the live directory before every visitor intent. A name that now
 * resolves elsewhere, or a registration on another revision (or suspended,
 * gone), means the link no longer is what its visitors are shown: the HTTP
 * layer pauses it (`recipient_changed` / `contract_changed`).
 */
import { parseAccountId, sameAddressAccount, type StoredLinkDefinition } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { contractDirectory, contractsEnabled } from "../contracts/directory.js";
import { resolveRecipientName } from "../names.js";

export interface LinkPinDrift {
  readonly reason: "recipient_changed" | "contract_changed";
  /** Destination action index. */
  readonly action: number;
  readonly detail: string;
}

/**
 * The first pin that drifted, or null. Name resolution failures propagate
 * (a pin that cannot be checked is not used: fail closed).
 */
export async function linkPinDrift(link: StoredLinkDefinition): Promise<LinkPinDrift | null> {
  for (const pin of link.pins.recipients) {
    if (!pin.name) continue;
    const pinned = parseAccountId(pin.account);
    if (!pinned) return { reason: "recipient_changed", action: pin.action, detail: "The pinned recipient is malformed." };
    const resolution = await resolveRecipientName(pin.name, pinned.chain.key);
    if (!sameAddressAccount(`${pinned.chain.id}:${resolution.address}`, pin.account)) {
      return { reason: "recipient_changed", action: pin.action, detail: `${pin.name} now resolves to ${resolution.address.slice(0, 64)}, not the pinned ${pinned.address}.` };
    }
  }
  if (link.pins.contracts.length === 0) return null;
  const directory = contractDirectory();
  if (!contractsEnabled() || !directory) {
    throw new PlatformError("CONTRACTS_DISABLED", "Custom contract and Solana Action steps are disabled on this deployment.", 503);
  }
  for (const pin of link.pins.contracts) {
    const registration = await directory.current(pin.contract);
    if (!registration) return { reason: "contract_changed", action: pin.action, detail: `${pin.contract} no longer exists.` };
    if (registration.status === "suspended") return { reason: "contract_changed", action: pin.action, detail: `${pin.contract} is suspended.` };
    if (registration.activeRevision !== pin.revision || registration.definitionHash !== pin.definitionHash) {
      return { reason: "contract_changed", action: pin.action, detail: `${pin.contract} is on revision ${registration.activeRevision ?? "none"}; the link pinned revision ${pin.revision}.` };
    }
  }
  return null;
}

/** Refuses with the link codes (409); the caller pauses the link with `drift.reason`. */
export function linkPinDriftError(drift: LinkPinDrift): PlatformError {
  const error = drift.reason === "recipient_changed"
    ? new PlatformError("LINK_RECIPIENT_CHANGED", `This link paused itself: ${drift.detail} The publisher must review and resume it.`, 409)
    : new PlatformError("LINK_CONTRACT_CHANGED", `This link paused itself: ${drift.detail} The publisher must review and resume it.`, 409);
  Object.defineProperty(error, "drift", { value: drift, enumerable: false });
  return error;
}
