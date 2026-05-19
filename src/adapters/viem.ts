import type { PublicClient } from 'viem';
import type { ReceiptProvider, SettlementReceipt } from '../types';

export function createViemReceiptProvider(client: PublicClient): ReceiptProvider {
  return {
    async getTransactionReceipt(input: {
      txHash: `0x${string}`;
    }): Promise<SettlementReceipt | null> {
      const receipt = await client.getTransactionReceipt({
        hash: input.txHash,
      });

      if (!receipt) {
        return null;
      }

      let status: SettlementReceipt['status'] = 'unknown';
      if (receipt.status === 'success') {
        status = 'success';
      } else if (receipt.status === 'reverted') {
        status = 'reverted';
      }

      let confirmations: number | undefined;
      if (receipt.blockNumber != null) {
        try {
          const currentBlockNumber = await client.getBlockNumber();
          confirmations = Number(currentBlockNumber - receipt.blockNumber) + 1;
        } catch {
          // cannot compute confirmations — leave undefined
        }
      }

      return {
        status,
        blockNumber: receipt.blockNumber,
        confirmations,
      };
    },
  };
}
