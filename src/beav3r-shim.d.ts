declare module '@beav3r/sdk' {
  export class BeaV3rSDK {
    requestAuthorization(params: {
      accountId: string;
      action: {
        type: string;
        payload: Record<string, unknown>;
      };
    }): Promise<Record<string, unknown>>;
  }
}
