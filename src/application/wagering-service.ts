import { BusinessRuleError, FailureCode } from '../domain/errors.js';
import { Money } from '../domain/money.js';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction.js';
import { LedgerDirection } from '../domain/wallet-ledger-entry.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { Wallet } from '../domain/wallet.js';
import { backoffDelay } from '../domain/backoff.js';
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../domain/integration-events.js';
import { ApplicationError } from './errors.js';
import { FinancialDatabase } from './financial-database.js';
import type { RecordedResult, TransactionRecord, TransactionResult } from './transaction-record.js';
import type { FinancialSession } from './financial-database.js';
import { businessPayloadHash, wagerCommandContract } from './wager-contract.js';
import { identityContract } from './wallet-service.js';
import { defaultReferencePolicy } from './reference-policy.js';
import type { ReferencePolicy, ReferenceSchedule } from './reference-policy.js';
import type { InboxDelivery } from './inbox-delivery.js';
import type { ApplicationObserver, ProcessingContext } from './observer.js';

export class WageringService {
  constructor(private readonly database: FinancialDatabase, private readonly referencePolicy: ReferencePolicy = defaultReferencePolicy,
    private readonly clock: () => Date = () => new Date(), private readonly random: () => number = Math.random,private readonly observer?: ApplicationObserver) {}

  private schedule(now: Date, attempts: number, expiresAt: Date): ReferenceSchedule {
    return { attempts, expiresAt, nextAttemptAt: new Date(now.getTime()+backoffDelay(attempts+1,this.random,this.referencePolicy)) };
  }

  private async evaluate(session: FinancialSession, wallet: Wallet, transaction: WagerTransaction, now: Date, expiresAt?: Date) {
    const reference = transaction.referenceExternalTransactionId===undefined ? undefined
      : (await session.findTransactionByExternal(transaction.providerId!,transaction.referenceExternalTransactionId))?.transaction;
    const reversals = reference ? await session.findProcessedReversals(reference.id) : [];
    let status = 200;
    let entry: WalletLedgerEntry | undefined;
    try {
      wallet.assertTransactionContext(transaction);
      transaction.validateForProcessing(reference,reversals);
      if (transaction.ledgerDirectionFor(reference)===LedgerDirection.Credit && !this.database.isPersistable(wallet.balance.add(transaction.money))) {
        throw new BusinessRuleError(FailureCode.BalanceLimitExceeded);
      }
      entry = wallet.apply(transaction,{ at: now, entryId: crypto.randomUUID(), ...(reference ? { reference } : {}), processedReversals: reversals });
    } catch (error) {
      if (!(error instanceof BusinessRuleError)) throw error;
      const waiting = error.code===FailureCode.ReferenceNotFound || error.code===FailureCode.ReferenceNotReady;
      if (waiting && (expiresAt===undefined || now.getTime()<expiresAt.getTime())) {
        if (transaction.status===WagerTransactionStatus.Pending) transaction.markPendingReference();
        status=202;
      } else { transaction.reject(error.code,now); status=422; }
    }
    const body: TransactionResult = { transactionId: transaction.id, status: transaction.status, balance: wallet.balance.toJSON(), idempotentReplay: false,
      ...(transaction.failureCode===undefined ? {} : { failureCode: transaction.failureCode }) };
    return { result: { status,body }, entry };
  }

  private async effects(session: FinancialSession, wallet: Wallet, transaction: WagerTransaction, entry: WalletLedgerEntry | undefined,
    now: Date, correlationId: string, emitPending: boolean) {
    if (entry) {
      await session.saveWallet(wallet); await session.insertLedger(entry);
      await session.enqueue(WalletBalanceChanged.from(wallet,entry,{ eventId: crypto.randomUUID(), correlationId, occurredAt: now }));
    }
    const ctx = { eventId: crypto.randomUUID(), correlationId, occurredAt: now };
    if (transaction.status===WagerTransactionStatus.PendingReference) {
      if (emitPending) await session.enqueue(WagerTransactionPendingReference.from(transaction,ctx));
    } else if (transaction.status===WagerTransactionStatus.Rejected) await session.enqueue(WagerTransactionRejected.from(transaction,ctx));
    else await session.enqueue(WagerTransactionProcessed.from(transaction,ctx));
  }

  async retryReference(id: string, walletId: string): Promise<RecordedResult | undefined> {
    const started=performance.now();
    const result=await this.database.transaction(async (session) => {
      const wallet = await session.lockWallet(walletId);
      if (!wallet) return undefined;
      // Ordem de locks igual à entrada: wallet antes de transaction.
      const record = await session.lockTransaction(id);
      if (!record || record.transaction.walletId!==walletId || record.transaction.status!==WagerTransactionStatus.PendingReference) return undefined;
      const now = this.clock();
      if (record.nextReferenceAttemptAt && record.nextReferenceAttemptAt.getTime()>now.getTime()) return undefined;
      const expiresAt = record.referenceExpiresAt ?? new Date(record.transaction.createdAt.getTime()+this.referencePolicy.ttlMs);
      const { result,entry } = await this.evaluate(session,wallet,record.transaction,now,expiresAt);
      const attempts = record.referenceAttempts+1;
      const schedule = result.status===202 ? this.schedule(now,attempts,expiresAt) : { attempts,expiresAt,nextAttemptAt: undefined };
      await session.saveTransaction(record.transaction,result.status===202 ? undefined : result,schedule);
      await this.effects(session,wallet,record.transaction,entry,now,record.transaction.id,false);
      return result;
    });
    if (result) this.observer?.completed({ correlationId: id,walletId,transactionId: id,source: 'reference' },result.body.status,false,performance.now()-started);
    return result;
  }

  private async read(find: (session: FinancialSession) => Promise<TransactionRecord | undefined>) {
    return this.database.transaction(async (session) => {
      const record = await find(session);
      if (!record) throw new ApplicationError(404,'TRANSACTION_NOT_FOUND');
      const tx = record.transaction;
      return { transactionId: tx.id, walletId: tx.walletId, playerId: tx.playerId, kind: tx.kind, status: tx.status, money: tx.money.toJSON(),
        ...(tx.providerId===undefined ? {} : { providerId: tx.providerId }), ...(tx.externalTransactionId===undefined ? {} : { externalTransactionId: tx.externalTransactionId }),
        ...(tx.roundId===undefined ? {} : { roundId: tx.roundId }), ...(tx.gameId===undefined ? {} : { gameId: tx.gameId }),
        ...(tx.referenceExternalTransactionId===undefined ? {} : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
        ...(tx.referenceTransactionId===undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }),
        ...(tx.failureCode===undefined ? {} : { failureCode: tx.failureCode }), createdAt: tx.createdAt.toISOString(),
        ...(tx.processedAt===undefined ? {} : { processedAt: tx.processedAt.toISOString() }), ...(tx.completedAt===undefined ? {} : { completedAt: tx.completedAt.toISOString() }),
        acceptanceResult: record.firstResult ? { httpStatus: record.firstResult.status, body: record.firstResult.body } : null,
        terminalResult: record.terminalResult ? { httpStatus: record.terminalResult.status, body: record.terminalResult.body } : null,
      };
    });
  }
  get(id: string) { return this.read((session) => session.findTransactionById(id)); }
  getByExternal(providerId: string, externalId: string) { return this.read((session) => session.findTransactionByExternal(providerId,externalId)); }

  async process(input: unknown, key: unknown, correlationId: string = crypto.randomUUID(), inbox?: InboxDelivery): Promise<RecordedResult> {
    const started=performance.now();
    const context: ProcessingContext={ correlationId,source: inbox ? 'sqs' : 'http',...(inbox ? { messageId: inbox.messageId } : {}) };
    if (input && typeof input==='object') {
      if ('walletId' in input && typeof input.walletId==='string') context.walletId=input.walletId;
      if ('providerId' in input && typeof input.providerId==='string') context.providerId=input.providerId;
    }
    try {
      const result=await this.processCommand(input,key,correlationId,inbox);
      this.observer?.completed({ ...context,transactionId: result.body.transactionId },result.body.status,result.body.idempotentReplay,performance.now()-started);
      return result;
    } catch (error) {
      this.observer?.failed(context,error && typeof error==='object' && 'code' in error ? String(error.code) : 'INVALID_OR_UNEXPECTED',performance.now()-started);
      throw error;
    }
  }

  private async processCommand(input: unknown,key: unknown,correlationId: string,inbox?: InboxDelivery): Promise<RecordedResult> {
    if (!identityContract.safeParse(key).success) throw new ApplicationError(400,'IDEMPOTENCY_KEY_REQUIRED');
    const idempotencyKey = key as string;
    const command = wagerCommandContract.parse(input);
    const money = Money.from(command.money);
    if (!this.database.isPersistable(money)) throw new ApplicationError(400,'AMOUNT_OUT_OF_RANGE');
    const hash = businessPayloadHash(command);
    const replay = (existing: TransactionRecord): RecordedResult => {
      if (existing.transaction.payloadHash!==hash) throw new ApplicationError(409,'IDEMPOTENCY_CONFLICT');
      if (!existing.firstResult) throw new ApplicationError(503,'RESULT_NOT_AVAILABLE');
      return { status: existing.firstResult.status, body: { ...existing.firstResult.body, idempotentReplay: true } };
    };
    try {
      return await this.database.transaction(async (session) => {
        const message = inbox ? await session.claimInbox(inbox) : undefined;
        const finish = async (result: RecordedResult) => {
          if (message && !message.isProcessed()) await session.completeInbox(message,this.clock());
          return result;
        };
        const fastReplay = await session.findTransactionByKey(idempotencyKey);
        if (fastReplay) return finish(replay(fastReplay));
        const wallet = await session.lockWallet(command.walletId);
        if (!wallet) throw new ApplicationError(404,'WALLET_NOT_FOUND');
        const existing = await session.findTransactionByKey(idempotencyKey);
        if (existing) return finish(replay(existing));
        if (await session.findTransactionByExternal(command.providerId,command.externalTransactionId)) {
          // A identidade externa pode ter confirmado em outra wallet desde a consulta da key.
          const concurrentKey = await session.findTransactionByKey(idempotencyKey);
          if (concurrentKey) return finish(replay(concurrentKey));
          throw new ApplicationError(409,'EXTERNAL_TRANSACTION_ID_CONFLICT');
        }
        const now = this.clock();
        const { referenceExternalTransactionId, ...fields } = command;
        const transaction = WagerTransaction.create({ ...fields, id: crypto.randomUUID(), idempotencyKey, payloadHash: hash, money, createdAt: now,
          ...(referenceExternalTransactionId===undefined ? {} : { referenceExternalTransactionId }) });
        const { result,entry } = await this.evaluate(session,wallet,transaction,now);
        const schedule = result.status===202 ? this.schedule(now,0,new Date(now.getTime()+this.referencePolicy.ttlMs)) : undefined;
        await session.insertTransaction(transaction,result,schedule);
        await this.effects(session,wallet,transaction,entry,now,correlationId,true);
        return finish(result);
      });
    } catch (error) {
      if (error && typeof error==='object' && 'code' in error && error.code==='23505') {
        // Unique entre wallets distintas: a transação abortada já terminou; releitura usa outro EM/transação.
        return this.database.transaction(async (session) => {
          const message = inbox ? await session.claimInbox(inbox) : undefined;
          const existing = await session.findTransactionByKey(idempotencyKey);
          if (existing) {
            const result = replay(existing);
            if (message && !message.isProcessed()) await session.completeInbox(message,this.clock());
            return result;
          }
          throw new ApplicationError(409,'EXTERNAL_TRANSACTION_ID_CONFLICT');
        });
      }
      throw error;
    }
  }
}
