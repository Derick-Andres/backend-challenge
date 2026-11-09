import { z } from 'zod';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../domain/integration-events.js';
import { ApplicationError } from './errors.js';
import { FinancialDatabase } from './financial-database.js';
import type { ApplicationObserver } from './observer.js';

export const moneyContract = z.object({ amount: z.string(), currency: z.string() }).strict();
export const identityContract = z.string().refine((value) => value.trim().length>0);
export const openWalletContract = z.object({ playerId: identityContract, initialBalance: moneyContract }).strict();
const cursorContract = z.object({ v: z.literal(1), walletId: z.string(), after: z.number().int().nonnegative().safe(), upper: z.number().int().positive().safe() }).strict();

export function walletView(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

export class WalletService {
  constructor(private readonly database: FinancialDatabase,private readonly observer?: ApplicationObserver) {}

  async open(input: unknown, correlationId: string = crypto.randomUUID()) {
    const command = openWalletContract.parse(input);
    const now = new Date();
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: command.playerId, initialBalance: Money.from(command.initialBalance),
      createdAt: now, opening: { transactionId: crypto.randomUUID(), entryId: crypto.randomUUID() } });
    const result=await this.database.transaction(async (session) => {
      await session.insertWallet(wallet);
      if (wallet.openingTransaction) {
        await session.insertTransaction(wallet.openingTransaction);
        for (const entry of wallet.ledgerEntries) {
          await session.insertLedger(entry);
          await session.enqueue(WalletBalanceChanged.from(wallet,entry,{ eventId: crypto.randomUUID(), correlationId, occurredAt: now }));
        }
        await session.enqueue(WagerTransactionProcessed.from(wallet.openingTransaction,{ eventId: crypto.randomUUID(), correlationId, occurredAt: now }));
      }
      return walletView(wallet);
    });
    this.observer?.walletOpened(wallet.id,correlationId,wallet.openingTransaction?.id);
    return result;
  }

  async reconcile(id: string) {
    const snapshot=await this.database.reconciliationSnapshot(id);
    if (!snapshot) throw new ApplicationError(404,'WALLET_NOT_FOUND');
    const calculated=Money.rehydrate(snapshot.calculatedMinor,snapshot.wallet.currency);
    const difference=snapshot.wallet.balance.subtract(calculated);
    const consistent=difference.isZero();
    this.observer?.reconciled(id,consistent,snapshot.checkedEntries);
    return { walletId: id,storedBalance: snapshot.wallet.balance.toJSON(),calculatedBalance: calculated.toJSON(),difference: difference.toJSON(),consistent,checkedEntries: snapshot.checkedEntries };
  }

  async get(id: string) {
    return this.database.transaction(async (session) => {
      const wallet = await session.findWallet(id);
      if (!wallet) throw new ApplicationError(404,'WALLET_NOT_FOUND');
      return walletView(wallet);
    });
  }

  async ledger(id: string, query: { cursor?: string; limit?: string }) {
    const limit = query.limit === undefined ? 50 : (/^[1-9][0-9]*$/.test(query.limit) ? Number(query.limit) : NaN);
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new ApplicationError(400,'INVALID_PAGINATION');
    return this.database.transaction(async (session) => {
      const wallet = await session.findWallet(id);
      if (!wallet) throw new ApplicationError(404,'WALLET_NOT_FOUND');
      let after = 0;
      let upper = wallet.version;
      if (query.cursor !== undefined) {
        try {
          if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error('Invalid cursor');
          const cursor = cursorContract.parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')));
          if (cursor.walletId!==id || cursor.after>cursor.upper || cursor.upper>wallet.version) throw new Error('Invalid cursor context');
          after = cursor.after; upper = cursor.upper;
        } catch { throw new ApplicationError(400,'INVALID_CURSOR'); }
      }
      const entries = await session.ledgerPage(id,after,upper,limit+1);
      const page = entries.slice(0,limit);
      const last = page.at(-1);
      const nextCursor = entries.length>limit && last
        ? Buffer.from(JSON.stringify({ v: 1, walletId: id, after: last.walletVersion, upper })).toString('base64url') : null;
      return { items: page.map((entry) => ({ id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
        direction: entry.direction, money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion, createdAt: entry.createdAt.toISOString() })), nextCursor };
    });
  }
}
