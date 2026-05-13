async function checkOnChain(
  _txHash: string,
): Promise<{ confirmed: boolean; currentConfirmations: number }> {
  throw new Error('checkOnChain is not implemented yet');
}

export async function pollUntilResolved(
  _txHash: string,
  _pollIntervalMs: number,
  _maxPollWindowMs: number,
): Promise<{ resolved: boolean; state: string }> {
  throw new Error('pollUntilResolved is not implemented yet');
}
