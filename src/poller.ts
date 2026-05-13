export async function checkOnChain(
  _txHash: string,
  _confirmationsRequired: number,
): Promise<{ confirmed: boolean; currentConfirmations: number }> {
  throw new Error('checkOnChain is not implemented yet');
}
