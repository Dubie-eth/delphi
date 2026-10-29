import { createPublicClient, http, parseAbi, type Address } from "viem";
import { genesisChain } from "./genesisMarket";
import { TESTNET } from "./testnet";

const publicClient = createPublicClient({
  chain: genesisChain,
  transport: http(TESTNET.rpc),
});

export const guardianRegistryAbi = parseAbi([
  "function setGuardian(uint256 id, uint256 chainId, address collection, uint256 tokenId)",
  "function clearGuardian(uint256 id)",
  "function guardianOf(uint256 id) view returns (bool set, uint256 chainId, address collection, uint256 tokenId, bool verified, string art)",
]);

export type GuardianView = {
  set: boolean;
  chainId: number;
  collection: Address;
  tokenId: number;
  verified: boolean;
  art: string;
};

export async function fetchGuardianView(genesisTokenId: number): Promise<GuardianView> {
  const row = await publicClient.readContract({
    address: TESTNET.guardianRegistry,
    abi: guardianRegistryAbi,
    functionName: "guardianOf",
    args: [BigInt(genesisTokenId)],
  });
  return {
    set: row[0],
    chainId: Number(row[1]),
    collection: row[2],
    tokenId: Number(row[3]),
    verified: row[4],
    art: row[5],
  };
}
