export type GuardianAvatarPick = {
  chainId: number;
  contract: string;
  tokenId: number;
  collectionName: string;
  label: string;
  imageUrl: string;
};

export type AvatarSuggestionResponse = {
  source: "opensea" | "ens";
  status: "nft" | "image_only" | "unavailable";
  message: string;
  ensName?: string | null;
  username?: string | null;
  previewImageUrl?: string | null;
  pick?: GuardianAvatarPick;
};
