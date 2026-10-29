/** Human labels for guardian picker chain badges (OpenSea + Robinhood). */
const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  4663: "Robinhood",
  46630: "RH Testnet",
  7777777: "Zora",
  81457: "Blast",
};

export function chainLabel(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function chainBadgeShort(chainId: number): string {
  if (chainId === 4663) return "RH";
  if (chainId === 1) return "ETH";
  if (chainId === 8453) return "Base";
  if (chainId === 137) return "Polygon";
  if (chainId === 42161) return "ARB";
  if (chainId === 10) return "OP";
  return String(chainId);
}
