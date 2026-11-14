import { chainAdapters, contracts } from "chainsig.js";
import type { PublicClient } from "viem";
import { NEAR } from "@backstop/config";

/** chainsig.js handle for the mainnet MPC signer (`v1.signer`). */
export const mpcContract: contracts.ChainSignatureContract = new contracts.ChainSignatureContract({
  networkId: NEAR.networkId,
  contractId: NEAR.mpcContract,
});

/** chainsig.js EVM adapter bound to a Base client and the mainnet MPC contract. */
export function evmAdapter(publicClient: PublicClient): chainAdapters.evm.EVM {
  return new chainAdapters.evm.EVM({ publicClient, contract: mpcContract });
}
