import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { IsolationLevel, LockMode } from '@mikro-orm/core';
import { ApplicationError } from '../../application/errors.js';
import { FinancialDatabase } from '../../application/financial-database.js';
import type { FinancialSession } from '../../application/financial-database.js';
import { OutboxMessage } from '../../domain/outbox-message.js';
import { ledgerFromRow, ledgerToRow, transactionFromRow, transactionToRow, walletFromRow, walletToRow } from './mappers.js';
import { inboxSchema, ledgerSchema, outboxSchema, transactionSchema, walletSchema } from './records.js';
import { moneyToDatabase, MoneyPersistenceError } from './money-converter.js';
import type { Money } from '../../domain/money.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { InboxMessage } from '../../domain/inbox-message.js';
import type { Telemetry } from '../observability/telemetry.js';

export interface DatabaseTestHooks {
  afterWrite?: (step: string, em: EntityManager) => Promise<void>;
  afterWalletLocked?: (id: string, em: EntityManager) => Promise<void>;
  afterTransactionKeyRead?: (key: string, found: boolean) => Promise<void>;
  afterReconciliationWalletRead?: (id: string) => Promise<void>;
}

export class PostgresFinancialDatabase extends FinancialDatabase {
  constructor(private readonly orm: MikroORM, private readonly hooks: DatabaseTestHooks = {}, private readonly telemetry?: Telemetry) { super(); }
  override async reconciliationSnapshot(id: string) {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute('set transaction read only');
      const row=await em.findOne(walletSchema,id);
      if (!row) return undefined;
      await this.hooks.afterReconciliationWalletRead?.(id);
      const [ledger]=await em.execute<{ total: unknown; count: string }[]>(`select coalesce(sum(case direction when 'CREDIT'
        then amount_minor::numeric else -amount_minor::numeric end),0)::text as total,count(*)::text as count from wallet_ledger_entries where wallet_id=?`,[id]);
      if (!ledger || typeof ledger.total!=='string' || !/^-?[0-9]+$/.test(ledger.total)) throw new MoneyPersistenceError('Soma exata do ledger deve ser string inteira');
      return { wallet: walletFromRow(row),calculatedMinor: BigInt(ledger.total),checkedEntries: Number(ledger.count) };
    },{ isolationLevel: IsolationLevel.REPEATABLE_READ });
  }
  override isPersistable(money: Money): boolean {
    try { moneyToDatabase(money); return true; }
    catch (error) { if (error instanceof MoneyPersistenceError) return false; throw error; }
  }
  override async dueReferences(now: Date, limit: number) {
    const rows = await this.orm.em.fork().find(transactionSchema,{ status: WagerTransactionStatus.PendingReference,
      $or: [{ nextReferenceAttemptAt: { $lte: now } },{ nextReferenceAttemptAt: null }],
    },{ orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' }, limit });
    return rows.map((row) => ({ id: row.id, walletId: row.walletId }));
  }

  override async transaction<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    for (let attempt=0; ; attempt++) {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // Flush explícito por escrita: falhas de teste observam pontos reais, mas sempre na mesma transação.
        const written = async (step: string) => { await em.flush(); await this.hooks.afterWrite?.(step,em); };
        const session: FinancialSession = {
          claimInbox: async (delivery) => {
            const incoming = InboxMessage.receive(delivery);
            await em.execute(`insert into inbox_messages(consumer_name,message_id,payload_hash,received_at)
              values(?,?,?,?) on conflict(consumer_name,message_id) do nothing`,[incoming.consumerName,incoming.messageId,incoming.payloadHash,incoming.receivedAt]);
            const row = await em.findOneOrFail(inboxSchema,{ consumerName: incoming.consumerName,messageId: incoming.messageId },{ lockMode: LockMode.PESSIMISTIC_WRITE,refresh: true });
            if (row.payloadHash!==incoming.payloadHash) throw new ApplicationError(409,'INBOX_PAYLOAD_CONFLICT');
            if (row.disposition==='DLQ') throw new ApplicationError(409,'PREVIOUS_PERMANENT_DISPOSITION');
            await this.hooks.afterWrite?.('inbox',em);
            return InboxMessage.rehydrate({ messageId: row.messageId,consumerName: row.consumerName,payloadHash: row.payloadHash,receivedAt: row.receivedAt,
              ...(row.processedAt===null ? {} : { processedAt: row.processedAt }) });
          },
          completeInbox: async (message,at) => {
            message.markProcessed(at);
            const row = await em.findOneOrFail(inboxSchema,{ consumerName: message.consumerName,messageId: message.messageId });
            em.assign(row,{ processedAt: message.processedAt!,disposition: 'ACK' });
            await written('inbox_processed');
          },
          findWallet: async (id) => { const row = await em.findOne(walletSchema,id); return row ? walletFromRow(row) : undefined; },
          lockWallet: async (id) => {
            const row = await em.findOne(walletSchema,id,{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
            if (row) await this.hooks.afterWalletLocked?.(id,em);
            return row ? walletFromRow(row) : undefined;
          },
          insertWallet: async (wallet) => { em.persist(em.create(walletSchema,walletToRow(wallet))); await written('wallet'); },
          saveWallet: async (wallet) => {
            const row = await em.findOneOrFail(walletSchema,wallet.id);
            em.assign(row,walletToRow(wallet)); await written('wallet');
          },
          insertTransaction: async (tx,result,schedule) => {
            const row = transactionToRow(tx);
            if (result) { row.firstHttpStatus=result.status; row.firstResponse=result.body; if (tx.isTerminal()) row.terminalResponse={ status: result.status, body: result.body }; }
            if (schedule) { row.referenceAttempts=schedule.attempts; row.nextReferenceAttemptAt=schedule.nextAttemptAt ?? null; row.referenceExpiresAt=schedule.expiresAt; }
            em.persist(em.create(transactionSchema,row)); await written('transaction');
          },
          saveTransaction: async (tx,result,schedule) => {
            const row = await em.findOneOrFail(transactionSchema,tx.id);
            em.assign(row,{ status: tx.status, referenceTransactionId: tx.referenceTransactionId ?? null, failureCode: tx.failureCode ?? null,
              processedAt: tx.processedAt ?? null, completedAt: tx.completedAt ?? null,
              referenceAttempts: schedule.attempts, nextReferenceAttemptAt: schedule.nextAttemptAt ?? null, referenceExpiresAt: schedule.expiresAt,
              ...(result ? { terminalResponse: { status: result.status, body: result.body } } : {}),
            });
            await written('transaction');
          },
          lockTransaction: async (id) => {
            const row=await em.findOne(transactionSchema,id,{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
            return row ? transactionFromRow(row) : undefined;
          },
          findTransactionByKey: async (key) => {
            const row=await em.findOne(transactionSchema,{ idempotencyKey: key });
            await this.hooks.afterTransactionKeyRead?.(key,row!==null);
            return row ? transactionFromRow(row) : undefined;
          },
          findTransactionById: async (id) => { const row=await em.findOne(transactionSchema,id); return row ? transactionFromRow(row) : undefined; },
          findTransactionByExternal: async (providerId,externalTransactionId) => {
            const row=await em.findOne(transactionSchema,{ providerId,externalTransactionId }); return row ? transactionFromRow(row) : undefined;
          },
          findProcessedReversals: async (referenceTransactionId) => (await em.find(transactionSchema,{ referenceTransactionId,
            status: WagerTransactionStatus.Processed,kind: { $in: [WagerTransactionKind.Refund,WagerTransactionKind.Rollback] } })).map((row) => transactionFromRow(row).transaction),
          insertLedger: async (entry) => { em.persist(em.create(ledgerSchema,ledgerToRow(entry))); await written('ledger'); },
          enqueue: async (event) => {
            const message = OutboxMessage.enqueue(event);
            em.persist(em.create(outboxSchema,{ id: message.id, aggregateId: message.aggregateId, eventType: message.eventType,
              payload: message.payload, occurredAt: message.occurredAt, attempts: 0, nextAttemptAt: message.occurredAt, publishedAt: null }));
            await written('outbox');
          },
          ledgerPage: async (walletId,after,upper,count) => (await em.find(ledgerSchema,{
            walletId, walletVersion: { $gt: after, $lte: upper },
          },{ orderBy: { walletVersion: 'asc' }, limit: count })).map(ledgerFromRow),
        };
        return work(session);
      },{ isolationLevel: IsolationLevel.READ_COMMITTED });
    } catch (error) {
      if (attempt<2 && error && typeof error==='object' && 'code' in error && ['40001','40P01','55P03'].includes(String(error.code))) {
        this.telemetry?.increment('wager_db_retries_total');
        await new Promise((resolve) => setTimeout(resolve,5+Math.floor(Math.random()*20)));
        continue;
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
        && 'constraint' in error && error.constraint === 'wallets_player_id_currency_key') {
        throw new ApplicationError(409,'WALLET_ALREADY_EXISTS');
      }
      throw error;
    }
    }
  }
}
