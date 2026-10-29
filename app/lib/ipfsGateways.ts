/** Public IPFS HTTP gateways (tried in order; first success wins). */
export const IPFS_GATEWAYS = [
  "https://ipfs.filebase.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
] as const;

export function ipfsPathFromUri(uri: string): string | null {
  if (!uri.startsWith("ipfs://")) return null;
  const path = uri.slice(7).replace(/^ipfs\//, "");
  return path || null;
}

export function httpUrlsForIpfsPath(path: string): string[] {
  return IPFS_GATEWAYS.map((g) => `${g}${path}`);
}

export function httpUrlsForIpfsUri(uri: string): string[] {
  const path = ipfsPathFromUri(uri);
  if (!path) return [];
  return httpUrlsForIpfsPath(path);
}
