import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { decodeBase58 } from "@kletia/core";

const PRIVATE_KEY_LIKE =
  /(?:^|[^a-fA-F0-9])(?:0x)?[a-fA-F0-9]{64}(?=$|[^a-fA-F0-9])/u;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const BEARER_CREDENTIAL = /\bbearer\s+["']?[A-Za-z0-9._~+/=-]{8,}/iu;
const LABELED_SINGLE_VALUE =
  /(?:^|[^\p{L}\p{N}_])["']?(?:private[_ -]?key|api[_ -]?key|client[_ -]?secret|access[_ -]?token|authorization)["']?\s*(?::|=|\bis\b)\s*["']?[^\s"',}]{8,}/iu;
const LABELED_MNEMONIC =
  /\b(?:seed(?:\s+phrase)?|mnemonic|recovery\s+phrase)\b["']?\s*(?::|=|\bis\b)\s*["']?(?:[a-z]+\s+){7,29}[a-z]+/iu;
// A Solana keypair (64 bytes: secret seed + public key) as wallets export it in
// base58, or as the Solana CLI's JSON byte array.
const BASE58_TOKEN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/gu;
const SOLANA_KEYPAIR_BYTES = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*,?\s*\]/u;
const BIP39_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

function containsValidEnglishBip39Mnemonic(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/gu) || [];
  for (const count of BIP39_WORD_COUNTS) {
    if (words.length < count) continue;
    for (let start = 0; start <= words.length - count; start += 1) {
      if (
        validateMnemonic(words.slice(start, start + count).join(" "), wordlist)
      ) {
        return true;
      }
    }
  }
  return false;
}

function containsBase58Keypair(text: string): boolean {
  return [...text.matchAll(BASE58_TOKEN)].some((match) => decodeBase58(match[0])?.length === 64);
}

export function containsSensitivePromptMaterial(text: string): boolean {
  return (
    PRIVATE_KEY_LIKE.test(text) ||
    PEM_PRIVATE_KEY.test(text) ||
    containsBase58Keypair(text) ||
    SOLANA_KEYPAIR_BYTES.test(text) ||
    BEARER_CREDENTIAL.test(text) ||
    LABELED_SINGLE_VALUE.test(text) ||
    LABELED_MNEMONIC.test(text) ||
    containsValidEnglishBip39Mnemonic(text)
  );
}
