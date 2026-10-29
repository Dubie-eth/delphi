"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { sortProfileOptions, type ProfileNftOption } from "../lib/nftProfileScan";
import {
  loadCustomCollections,
  saveCustomCollections,
  type CustomCollection,
  type StoredProfilePick,
} from "../lib/nodeProfileStorage";
import { resolveTokenUriMetadata, NFT_PLACEHOLDER_IMAGE } from "../lib/nftMetadataResolve";
import { clientForChain } from "../lib/nftProfileScan";
import { chainBadgeShort, chainLabel } from "../lib/chainLabels";
import { MAINNET, TESTNET } from "../lib/testnet";
import { parseAbi } from "viem";

type Props = {
  open: boolean;
  onClose: () => void;
  wallet: Address;
  bondTokenId: number;
  value: StoredProfilePick | null;
  onSelect: (pick: StoredProfilePick | null) => void;
  preferMainnet?: boolean;
  manualTokenEntry?: boolean;
  showOpenSeaProfile?: boolean;
  onAvatarSuggestion?: (data: import("../lib/guardianAvatarTypes").AvatarSuggestionResponse) => void;
};

type CollectionChip = { key: string; name: string; chainId: number; count: number };

type WalletNftsResponse = {
  items: ProfileNftOption[];
  collections: CollectionChip[];
  hasMore: boolean;
  nextOffset: number | null;
  openseaNext: string | null;
  alchemyNext?: string | null;
  total: number;
  sources?: { opensea: boolean; alchemy: boolean; onchain: boolean };
  error?: string;
};

function toStored(p: ProfileNftOption): StoredProfilePick {
  return {
    chainId: p.chainId,
    contract: p.contract,
    tokenId: p.tokenId,
    collectionName: p.collectionName,
    label: p.label,
    imageUrl: p.imageUrl,
    museId: p.museId,
  };
}

const erc721Mini = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function name() view returns (string)",
]);

function NftThumb({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const show = failed ? NFT_PLACEHOLDER_IMAGE : src;

  return (
    <div className="relative aspect-square rounded-lg overflow-hidden bg-black border border-gold/15">
      {!loaded && !failed ? (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-gold/10 via-black to-gold/5" />
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={show}
        alt={alt}
        className={`w-full h-full object-cover transition-opacity ${loaded || failed ? "opacity-100" : "opacity-0"}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => {
          setFailed(true);
          setLoaded(true);
        }}
      />
    </div>
  );
}

export default function ProfilePicturePicker({
  open,
  onClose,
  wallet,
  bondTokenId,
  value,
  onSelect,
  preferMainnet: _preferMainnet = false, // accepted for callers; not used yet
  manualTokenEntry = false,
  showOpenSeaProfile = false,
  onAvatarSuggestion,
}: Props) {
  /** `0` = all chains (Robinhood scan + OpenSea + Alchemy). */
  const [chainId, setChainId] = useState<number>(0);
  const [search, setSearch] = useState("");
  const [collection, setCollection] = useState("all");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ProfileNftOption[]>([]);
  const [collections, setCollections] = useState<CollectionChip[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [openseaNext, setOpenseaNext] = useState<string | null>(null);
  const [alchemyNext, setAlchemyNext] = useState<string | null>(null);
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomCollection[]>([]);
  const [addAddr, setAddAddr] = useState("");
  const [addChain, setAddChain] = useState<number>(MAINNET.chainId);
  const [manualContract, setManualContract] = useState("");
  const [manualTokenId, setManualTokenId] = useState("");
  const [manualChain, setManualChain] = useState<number>(MAINNET.chainId);
  const [osMsg, setOsMsg] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (append: boolean, nextOffset: number, osNext: string | null, alNext: string | null) => {
      const params = new URLSearchParams({
        wallet,
        chainId: chainId === 0 ? "all" : String(chainId),
        collection,
        limit: "24",
        offset: String(nextOffset),
      });
      if (search.trim()) params.set("q", search.trim());
      if (osNext) params.set("openseaNext", osNext);
      if (alNext) params.set("alchemyNext", alNext);
      const res = await fetch(`/api/wallet-nfts?${params}`);
      const data = (await res.json()) as WalletNftsResponse;
      if (!res.ok) throw new Error(data.error ?? "Could not load NFTs");
      setCollections(data.collections ?? []);
      setHasMore(Boolean(data.hasMore));
      setOpenseaNext(data.openseaNext ?? null);
      setAlchemyNext(data.alchemyNext ?? null);
      const src = data.sources;
      if (src && !src.opensea && chainId === 0) {
        setSourceHint(
          "Cross-chain NFTs need OPENSEA_API_KEY on the server. Robinhood holdings still load on-chain."
        );
      } else setSourceHint(null);
      const nextOff =
        data.nextOffset ??
        (append ? nextOffset + data.items.length : data.items.length);
      setOffset(nextOff);
      setOptions((prev) => (append ? sortProfileOptions([...prev, ...data.items]) : sortProfileOptions(data.items)));
    },
    [wallet, chainId, collection, search]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setOptions([]);
    setOffset(0);
    setOpenseaNext(null);
    setAlchemyNext(null);
    try {
      setCustom(loadCustomCollections(wallet));
      await fetchPage(false, 0, null, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load NFTs");
      setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [wallet, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(true, offset, openseaNext, alchemyNext);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more");
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, fetchPage, offset, openseaNext, alchemyNext]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load, bondTokenId]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [collection, chainId, open, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const hay = `${o.collectionName} ${o.label} ${o.tokenId}`.toLowerCase();
      return hay.includes(q) || String(o.tokenId).includes(q);
    });
  }, [options, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, { title: string; chainId: number; items: ProfileNftOption[] }>();
    for (const o of filtered) {
      const key = `${o.chainId}:${o.contract.toLowerCase()}`;
      const title = o.collectionName;
      const g = map.get(key);
      if (g) g.items.push(o);
      else map.set(key, { title, chainId: o.chainId, items: [o] });
    }
    return [...map.values()].sort((a, b) =>
      `${a.chainId}:${a.title}`.localeCompare(`${b.chainId}:${b.title}`)
    );
  }, [filtered]);

  const useOpenSeaProfile = async () => {
    setOsMsg(null);
    try {
      const res = await fetch(`/api/opensea-profile?wallet=${wallet}`);
      const data = (await res.json()) as import("../lib/guardianAvatarTypes").AvatarSuggestionResponse;
      if (!res.ok) throw new Error(data.message || "OpenSea lookup failed");
      setOsMsg(data.message);
      onAvatarSuggestion?.(data);
      if (data.status === "nft" && data.pick) {
        onSelect({
          chainId: data.pick.chainId,
          contract: data.pick.contract,
          tokenId: data.pick.tokenId,
          collectionName: data.pick.collectionName,
          label: data.pick.label,
          imageUrl: data.pick.imageUrl,
        });
      }
    } catch (e) {
      setOsMsg(e instanceof Error ? e.message : "OpenSea lookup failed");
    }
  };

  const resolveManual = async () => {
    const addr = manualContract.trim();
    const tid = Number(manualTokenId.trim());
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr) || !tid) {
      setError("Enter a valid contract (0x…) and token ID.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const client = clientForChain(manualChain);
      const owner = await client.readContract({
        address: addr as Address,
        abi: erc721Mini,
        functionName: "ownerOf",
        args: [BigInt(tid)],
      });
      if (owner.toLowerCase() !== wallet.toLowerCase()) {
        throw new Error("You do not own this token on-chain.");
      }
      const uri = await client.readContract({
        address: addr as Address,
        abi: erc721Mini,
        functionName: "tokenURI",
        args: [BigInt(tid)],
      });
      let collectionName = "Collection";
      try {
        collectionName = await client.readContract({
          address: addr as Address,
          abi: erc721Mini,
          functionName: "name",
        });
      } catch {
        /* optional */
      }
      const meta = await resolveTokenUriMetadata(uri);
      if (!meta?.image) throw new Error("Could not resolve token image.");
      onSelect({
        chainId: manualChain,
        contract: addr,
        tokenId: tid,
        collectionName,
        label: meta.name,
        imageUrl: meta.image,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Manual lookup failed");
    } finally {
      setLoading(false);
    }
  };

  const addCollection = () => {
    const addr = addAddr.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      setError("Paste a valid ERC-721 contract address (0x…).");
      return;
    }
    const next = [...custom, { chainId: addChain, contract: addr }];
    setCustom(next);
    saveCustomCollections(wallet, next);
    setAddAddr("");
    void load();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/70" aria-label="Close" onClick={onClose} />
      <div
        className="relative z-10 max-h-[90vh] w-full max-w-lg mx-auto rounded-t-2xl border border-gold/30 bg-background shadow-2xl flex flex-col pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div className="px-4 pt-4 pb-2 border-b border-gold/15 flex items-center justify-between gap-2 shrink-0">
          <h2 className="font-serif text-gold text-lg">Choose profile picture</h2>
          <button type="button" className="min-h-[44px] px-3 text-gold" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 overflow-y-auto flex-1 min-h-0">
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setChainId(0)}
              className={`min-h-[40px] px-3 rounded-full text-xs border ${
                chainId === 0 ? "bg-gold text-background border-gold" : "border-gold/30 text-gold"
              }`}
            >
              All chains
            </button>
            <button
              type="button"
              onClick={() => setChainId(MAINNET.chainId)}
              className={`min-h-[40px] px-3 rounded-full text-xs border ${
                chainId === MAINNET.chainId ? "bg-gold text-background border-gold" : "border-gold/30 text-gold"
              }`}
            >
              Robinhood {MAINNET.chainId}
            </button>
            <button
              type="button"
              onClick={() => setChainId(TESTNET.chainId)}
              className={`min-h-[40px] px-3 rounded-full text-xs border ${
                chainId === TESTNET.chainId ? "bg-gold text-background border-gold" : "border-gold/30 text-gold"
              }`}
            >
              Testnet {TESTNET.chainId}
            </button>
          </div>
          {sourceHint ? <p className="text-[11px] text-amber-200/85 leading-relaxed">{sourceHint}</p> : null}

          {showOpenSeaProfile ? (
            <button
              type="button"
              onClick={() => void useOpenSeaProfile()}
              className="w-full min-h-[44px] rounded-xl border border-gold/25 text-sm text-gold/90 hover:bg-gold/5"
            >
              Use my OpenSea profile picture
            </button>
          ) : null}
          {osMsg ? <p className="text-[11px] text-amber-200/90 leading-relaxed">{osMsg}</p> : null}

          <input
            type="search"
            placeholder="Filter by name or #token id"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg bg-black/40 border border-gold/25 text-sm"
          />

          {collections.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
              <CollectionChipButton
                active={collection === "all"}
                label={`All (${options.length || "…"})`}
                onClick={() => setCollection("all")}
              />
              {collections.map((c) => (
                <CollectionChipButton
                  key={c.key}
                  active={collection === c.key}
                  label={`${chainBadgeShort(c.chainId)} · ${c.name} (${c.count})`}
                  onClick={() => setCollection(c.key)}
                />
              ))}
            </div>
          ) : null}

          {loading ? (
            <div className="grid grid-cols-2 gap-3 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-lg animate-pulse bg-gold/10 border border-gold/15" />
              ))}
            </div>
          ) : error ? (
            <div className="space-y-2">
              <p className="text-sm text-red-300">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="w-full min-h-[44px] rounded-lg border border-gold/40 text-gold"
              >
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-text/55 text-center py-4">
              No NFTs found for this wallet
              {chainId === 0 ? "" : ` on ${chainLabel(chainId)}`}. Try all chains or add a collection below.
            </p>
          ) : (
            <div className="space-y-4">
              {grouped.map((section) => (
                <section key={`${section.chainId}:${section.title}`} className="space-y-2">
                  <h3 className="text-[10px] uppercase tracking-wider text-gold/60 px-0.5 flex items-center gap-2">
                    <span className="rounded px-1.5 py-0.5 border border-gold/25 text-[9px] text-gold/80">
                      {chainBadgeShort(section.chainId)}
                    </span>
                    {section.title}
                  </h3>
                  <ul className="grid grid-cols-2 gap-3">
                    {section.items.map((o) => {
                      const active =
                        value?.chainId === o.chainId &&
                        value.contract.toLowerCase() === o.contract.toLowerCase() &&
                        value.tokenId === o.tokenId;
                      return (
                        <li key={`${o.chainId}:${o.contract}:${o.tokenId}`}>
                          <button
                            type="button"
                            onClick={() => {
                              onSelect(toStored(o));
                              onClose();
                            }}
                            className={`w-full text-left rounded-xl border p-2 transition-colors ${
                              active ? "border-gold bg-gold/15" : "border-gold/20 hover:border-gold/45"
                            }`}
                          >
                            <NftThumb src={o.imageUrl} alt={o.label} />
                            <p className="text-xs font-medium text-gold truncate mt-2">{o.label}</p>
                            <p className="text-[10px] text-text/50 truncate">
                              {chainLabel(o.chainId)} · #{o.tokenId}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
              {hasMore ? (
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  className="w-full min-h-[44px] rounded-lg border border-gold/35 text-gold text-sm disabled:opacity-40"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </div>
          )}

          {manualTokenEntry ? (
            <div className="border-t border-gold/15 pt-3 space-y-2">
              <p className="text-xs text-text/55">Manual token (verified with ownerOf)</p>
              <select
                value={manualChain}
                onChange={(e) => setManualChain(Number(e.target.value))}
                className="w-full min-h-[44px] rounded-lg border border-gold/25 bg-black/40 text-sm px-2"
              >
                <option value={MAINNET.chainId}>Mainnet {MAINNET.chainId}</option>
                <option value={TESTNET.chainId}>Testnet {TESTNET.chainId}</option>
              </select>
              <input
                type="text"
                value={manualContract}
                onChange={(e) => setManualContract(e.target.value)}
                placeholder="0x… contract"
                className="w-full min-h-[44px] px-3 rounded-lg border border-gold/25 bg-black/40 text-sm font-mono"
              />
              <input
                type="text"
                inputMode="numeric"
                value={manualTokenId}
                onChange={(e) => setManualTokenId(e.target.value)}
                placeholder="Token ID"
                className="w-full min-h-[44px] px-3 rounded-lg border border-gold/25 bg-black/40 text-sm"
              />
              <button
                type="button"
                onClick={() => void resolveManual()}
                className="w-full min-h-[44px] rounded-lg border border-gold/35 text-gold text-sm"
              >
                Use this token
              </button>
            </div>
          ) : null}

          <div className="border-t border-gold/15 pt-3 space-y-2">
            <p className="text-xs text-text/55">Add collection (on-chain scan)</p>
            <div className="flex gap-2">
              <select
                value={addChain}
                onChange={(e) => setAddChain(Number(e.target.value))}
                className="min-h-[44px] rounded-lg border border-gold/25 bg-black/40 text-sm px-2"
              >
                <option value={MAINNET.chainId}>Mainnet</option>
                <option value={TESTNET.chainId}>Testnet</option>
              </select>
              <input
                type="text"
                value={addAddr}
                onChange={(e) => setAddAddr(e.target.value)}
                placeholder="0x… contract"
                className="flex-1 min-h-[44px] px-3 rounded-lg border border-gold/25 bg-black/40 text-sm font-mono"
              />
            </div>
            <button
              type="button"
              onClick={addCollection}
              className="w-full min-h-[44px] rounded-lg border border-gold/35 text-gold text-sm"
            >
              Add collection
            </button>
          </div>

          {value ? (
            <button
              type="button"
              className="w-full min-h-[44px] text-sm text-text/60 underline"
              onClick={() => {
                onSelect(null);
                onClose();
              }}
            >
              Clear local pick
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CollectionChipButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 min-h-[36px] px-3 rounded-full text-[11px] border transition-colors ${
        active ? "bg-gold/20 border-gold text-gold" : "border-gold/25 text-text/70 hover:border-gold/40"
      }`}
    >
      {label}
    </button>
  );
}
