import { base64Utf8, parseTokenUriJson } from "./genesisMarket";
import { httpUrlsForIpfsUri, httpUrlsForIpfsPath, ipfsPathFromUri } from "./ipfsGateways";

export type NftTileMeta = {
  name: string;
  image: string;
};

export function normalizeImageUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("ipfs://")) {
    const path = ipfsPathFromUri(trimmed);
    if (path) return httpUrlsForIpfsPath(path)[0] ?? trimmed;
  }
  return trimmed;
}

function parseJsonUri(uri: string): NftTileMeta | null {
  if (uri.startsWith("data:application/json")) {
    const meta = parseTokenUriJson(uri);
    if (meta?.image) {
      return { name: meta.name, image: normalizeImageUrl(meta.image) };
    }
    const comma = uri.indexOf(",");
    if (comma === -1) return null;
    try {
      const json = JSON.parse(base64Utf8(uri.slice(comma + 1))) as { name?: string; image?: string };
      if (typeof json.image === "string") {
        return {
          name: typeof json.name === "string" ? json.name : "NFT",
          image: normalizeImageUrl(json.image),
        };
      }
    } catch {
      return null;
    }
  }
  if (uri.startsWith("data:image")) return { name: "NFT", image: uri };
  return null;
}

async function fetchJsonOrImage(url: string): Promise<NftTileMeta | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { accept: "application/json, image/*, */*" },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("image/")) {
      return { name: "NFT", image: url };
    }
    if (type.includes("json") || url.endsWith(".json")) {
      const json = (await res.json()) as { name?: string; image?: string };
      if (typeof json.image !== "string") return null;
      return {
        name: typeof json.name === "string" ? json.name : "NFT",
        image: normalizeImageUrl(json.image),
      };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 4) {
      const b = new Uint8Array(buf.slice(0, 4));
      if (b[0] === 0xff && b[1] === 0xd8) return { name: "NFT", image: url };
      if (b[0] === 0x89 && b[1] === 0x50) return { name: "NFT", image: url };
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve tokenURI to display metadata (server or client). */
export async function resolveTokenUriMetadata(uri: string): Promise<NftTileMeta | null> {
  const inline = parseJsonUri(uri);
  if (inline) return inline;

  const candidates: string[] = [];
  if (uri.startsWith("ipfs://")) {
    candidates.push(...httpUrlsForIpfsUri(uri));
  } else if (uri.startsWith("http")) {
    candidates.push(uri);
  } else {
    return null;
  }

  for (const url of candidates) {
    const meta = await fetchJsonOrImage(url);
    if (meta?.image) return meta;
  }
  return null;
}

export const NFT_PLACEHOLDER_IMAGE = "/delphi-logo.png";
