import { scryptAsync } from "@noble/hashes/scrypt";

const RECOVERY_SCHEMA = "kletia_workflow_authorization_recovery_v1";
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DK_LEN = 32;
const MAX_BUNDLE_LENGTH = 2_000_000;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface RecoveryEnvelope {
  schemaVersion: typeof RECOVERY_SCHEMA;
  kdf: {
    name: "scrypt";
    n: typeof SCRYPT_N;
    r: typeof SCRYPT_R;
    p: typeof SCRYPT_P;
    dkLen: typeof SCRYPT_DK_LEN;
    salt: string;
  };
  cipher: {
    name: "AES-256-GCM";
    iv: string;
    ciphertext: string;
  };
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z\d+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("The recovery bundle contains invalid base64 data.");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const derived = await scryptAsync(utf8.encode(password), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DK_LEN,
    asyncTick: 10,
  });
  return crypto.subtle.importKey(
    "raw",
    derived,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 256) {
    throw new Error("Use a recovery password between 12 and 256 characters.");
  }
}

export async function encryptWorkflowRecoveryBundle(
  payload: unknown,
  password: string,
): Promise<string> {
  validatePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const plaintext = utf8.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: utf8.encode(RECOVERY_SCHEMA),
    },
    key,
    plaintext,
  );
  const envelope: RecoveryEnvelope = {
    schemaVersion: RECOVERY_SCHEMA,
    kdf: {
      name: "scrypt",
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      dkLen: SCRYPT_DK_LEN,
      salt: bytesToBase64(salt),
    },
    cipher: {
      name: "AES-256-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    },
  };
  return JSON.stringify(envelope);
}

export async function decryptWorkflowRecoveryBundle(
  bundle: string,
  password: string,
): Promise<unknown> {
  validatePassword(password);
  if (!bundle || bundle.length > MAX_BUNDLE_LENGTH) {
    throw new Error("The recovery bundle is empty or too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bundle);
  } catch {
    throw new Error("The recovery bundle is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The recovery bundle envelope is invalid.");
  }
  const envelope = value as Partial<RecoveryEnvelope>;
  if (
    envelope.schemaVersion !== RECOVERY_SCHEMA ||
    envelope.kdf?.name !== "scrypt" ||
    envelope.kdf.n !== SCRYPT_N ||
    envelope.kdf.r !== SCRYPT_R ||
    envelope.kdf.p !== SCRYPT_P ||
    envelope.kdf.dkLen !== SCRYPT_DK_LEN ||
    envelope.cipher?.name !== "AES-256-GCM" ||
    typeof envelope.kdf.salt !== "string" ||
    typeof envelope.cipher.iv !== "string" ||
    typeof envelope.cipher.ciphertext !== "string"
  ) {
    throw new Error("The recovery bundle uses an unsupported security profile.");
  }
  const salt = base64ToBytes(envelope.kdf.salt);
  const iv = base64ToBytes(envelope.cipher.iv);
  const ciphertext = base64ToBytes(envelope.cipher.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) {
    throw new Error("The recovery bundle cryptographic fields are invalid.");
  }
  try {
    const key = await deriveKey(password, salt);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: utf8.encode(RECOVERY_SCHEMA),
      },
      key,
      ciphertext,
    );
    return JSON.parse(utf8Decoder.decode(plaintext));
  } catch {
    throw new Error("The recovery password is wrong or the bundle was modified.");
  }
}
