import type { LoggerService } from '@nestjs/common';
import type { ApplicationObserver, ProcessingContext } from '../../application/observer.js';

const buckets=[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2,5,10,30,Infinity];
export class Telemetry implements ApplicationObserver {
  private readonly counters=new Map<string,number>();
  private readonly timings=buckets.map(() => 0);
  private sum=0;
  constructor() {
    for (const name of ['wager_duplicates_total','wager_db_retries_total','wager_command_retries_total','wager_outbox_retries_total','wager_processing_failures_total','wager_reconciliation_divergences_total']) this.counters.set(name,0);
  }
  increment(name: string): void { this.counters.set(name,(this.counters.get(name) ?? 0)+1); }
  log(level: string,event: string,context: object = {}): void {
    try { console.log(JSON.stringify({ timestamp: new Date().toISOString(),level,event,pid: process.pid,...context })); }
    catch { /* Falha de saída de log não altera resultado financeiro já confirmado. */ }
  }
  private observe(ms: number) {
    const seconds=ms/1000; this.sum+=seconds;
    buckets.forEach((bound,index) => { if (seconds<=bound) this.timings[index]=(this.timings[index] ?? 0)+1; });
  }
  completed(context: ProcessingContext,status: string,replay: boolean,durationMs: number): void {
    this.observe(durationMs); if (replay) this.increment('wager_duplicates_total');
    this.log('info','transaction_result',{ ...context,status,replay,durationMs });
  }
  failed(context: ProcessingContext,code: string,durationMs: number): void {
    this.observe(durationMs); this.increment('wager_processing_failures_total'); this.log('error','transaction_error',{ ...context,code,durationMs });
  }
  reconciled(walletId: string,consistent: boolean,checkedEntries: number): void {
    if (!consistent) this.increment('wager_reconciliation_divergences_total');
    this.log(consistent ? 'info' : 'warn',consistent ? 'reconciliation_ok' : 'reconciliation_divergence',{ walletId,checkedEntries });
  }
  walletOpened(walletId: string,correlationId: string,transactionId?: string): void {
    this.log('info','wallet_opened',{ walletId,correlationId,...(transactionId===undefined ? {} : { transactionId }) });
  }
  render(): string {
    const lines=[...this.counters].flatMap(([name,value]) => [`# TYPE ${name} counter`,`${name} ${value}`]);
    lines.push('# TYPE wager_processing_duration_seconds histogram');
    buckets.forEach((bound,index) => lines.push(`wager_processing_duration_seconds_bucket{le="${bound===Infinity ? '+Inf' : bound}"} ${this.timings[index] ?? 0}`));
    lines.push(`wager_processing_duration_seconds_sum ${this.sum}`,`wager_processing_duration_seconds_count ${this.timings.at(-1) ?? 0}`);
    return `${lines.join('\n')}\n`;
  }
}
export const telemetry=new Telemetry();

export class JsonLogger implements LoggerService {
  constructor(private readonly telemetry: Telemetry) {}
  log(message: unknown): void { this.telemetry.log('info','framework',{ message: typeof message==='string' ? message : 'framework message' }); }
  warn(): void { this.telemetry.log('warn','framework_warning'); }
  error(message: unknown): void {
    const text=message instanceof Error ? message.message : typeof message==='string' ? message : '';
    this.telemetry.log('error','framework_error',{ message: text.startsWith('Configuração inválida:') ? text : 'framework error' });
  }
  fatal(): void { this.telemetry.log('error','framework_fatal'); }
  debug(): void {}
  verbose(): void {}
}
