import type { Address } from "viem";

export type StoredProfilePick = {
  chainId: number;
  contract: string;
  tokenId: number;
  collectionName: string;
  label: string;
  imageUrl: string;
  museId?: number;
};

export type CustomCollection = {
  chainId: number;
  contract: string;
  label?: string;
};

const PFP_PREFIX = "delphi-node-pfp:";
const CUSTOM_PREFIX = "delphi-node-collections:";

export function profileStorageKey(wallet: Address, bondTokenId: number): string {
  return `${PFP_PREFIX}${wallet.toLowerCase()}:${bondTokenId}`;
}

export function loadProfilePick(wallet: Address, bondTokenId: number): StoredProfilePick | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(profileStorageKey(wallet, bondTokenId));
    if (!raw) return null;
    return JSON.parse(raw) as StoredProfilePick;
  } catch {
    return null;
  }
}

export function saveProfilePick(wallet: Address, bondTokenId: number, pick: StoredProfilePick | null): void {
  if (typeof window === "undefined") return;
  const key = profileStorageKey(wallet, bondTokenId);
  if (!pick) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(pick));
}

export function loadCustomCollections(wallet: Address): CustomCollection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${CUSTOM_PREFIX}${wallet.toLowerCase()}`);
    if (!raw) return [];
    const arr = JSON.parse(raw) as CustomCollection[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveCustomCollections(wallet: Address, list: CustomCollection[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(`${CUSTOM_PREFIX}${wallet.toLowerCase()}`, JSON.stringify(list));
}
