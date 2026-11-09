import type { FinancialDatabase } from '../../application/financial-database.js';
import type { WageringService } from '../../application/wagering-service.js';

export async function interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); };
    const timer = setTimeout(done,ms);
    signal.addEventListener('abort',done,{ once: true });
  });
}

export async function referenceLoop(database: FinancialDatabase, wagering: WageringService,
  options: { pollMs: number; batchSize: number }, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const candidates = await database.dueReferences(new Date(),options.batchSize);
      for (const candidate of candidates) {
        if (signal.aborted) break;
        try { await wagering.retryReference(candidate.id,candidate.walletId); }
        catch (error) { console.error(JSON.stringify({ level: 'error',event: 'reference_retry_error',correlationId: candidate.id,
          transactionId: candidate.id,walletId: candidate.walletId,pid: process.pid,
          code: error && typeof error==='object' && 'code' in error ? String(error.code) : 'UNEXPECTED' })); }
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'reference_retry_error', code: error && typeof error==='object' && 'code' in error ? String(error.code) : 'UNEXPECTED' }));
    }
    await interruptibleDelay(options.pollMs,signal);
  }
}
