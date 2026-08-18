/** EIP-7702 delegation designators are accounts, not analyzable contracts. */
export function isEip7702DelegationDesignator(
  bytecode: string | undefined,
): boolean {
  return /^0xef0100[0-9a-f]{40}$/iu.test(bytecode ?? "");
}
