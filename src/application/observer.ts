export interface ProcessingContext {
  correlationId: string; walletId?: string; providerId?: string; messageId?: string; transactionId?: string;
  source: 'http' | 'sqs' | 'reference';
}
export interface ApplicationObserver {
  completed(context: ProcessingContext, status: string, replay: boolean, durationMs: number): void;
  failed(context: ProcessingContext, code: string, durationMs: number): void;
  reconciled(walletId: string, consistent: boolean, checkedEntries: number): void;
  walletOpened(walletId: string, correlationId: string, transactionId?: string): void;
}
