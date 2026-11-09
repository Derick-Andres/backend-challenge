import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config/configuration.js';
import { Migration202611080001 } from '../../src/infrastructure/database/migrations/Migration202611080001.js';
import { ormOptions } from '../../src/infrastructure/database/orm-options.js';
import { grantRuntimeAccess, prepareRuntimeRole } from '../../src/infrastructure/database/runtime-role.js';

export async function disposableDatabase() {
  const config = loadConfig(process.env);
  if (!['127.0.0.1','localhost','::1'].includes(config.PGHOST)) throw new Error('Suíte destrutiva somente em PostgreSQL local');
  const adminConfig = { ...config, PGUSER: config.PG_MIGRATION_USER, PGPASSWORD: config.PG_MIGRATION_PASSWORD };
  const admin = await MikroORM.init(ormOptions(adminConfig));
  const name = `challenge_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.em.fork().execute(`CREATE DATABASE "${name}"`);
  const owner = await MikroORM.init({ ...ormOptions({ ...adminConfig, PGDATABASE: name }), migrations: { migrationsList: [Migration202611080001], snapshot: false } });
  const runtimeUser = 'wagering_app';
  const runtimeConfig = { ...config, PGDATABASE: name, PGUSER: runtimeUser };
  let runtime: MikroORM | undefined;
  const close = async () => {
      await runtime?.close(true);
      await owner.close(true);
      // Nome gerado exclusivamente para esta suíte; nunca limpa o banco configurado pelo usuário.
      await admin.em.fork().execute(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close(true);
  };
  try {
    await prepareRuntimeRole(owner.em.fork(), runtimeUser, config.PGPASSWORD);
    await owner.migrator.up();
    await grantRuntimeAccess(owner.em.fork(), runtimeUser);
    runtime = await MikroORM.init(ormOptions(runtimeConfig));
    return { owner, runtime, config: runtimeConfig, close };
  } catch (error) {
    await close();
    throw error;
  };
}

export async function insertOpening(em: EntityManager, amount = '10000', walletId = crypto.randomUUID()) {
  const transactionId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  await em.execute('insert into wallets values (?,?,?,?,1,now(),now())', [walletId, walletId, 'BRL', amount]);
  if (amount !== '0') {
    await em.execute(`insert into wager_transactions(id,wallet_id,player_id,kind,amount_minor,currency,status,created_at,processed_at,completed_at)
      values(?,?,?,'OPENING',?,'BRL','PROCESSED',now(),now(),now())`, [transactionId, walletId, walletId, amount]);
    await em.execute(`insert into wallet_ledger_entries values(?,?,?,1,'CREDIT',?,'BRL',0,?,now())`, [entryId, walletId, transactionId, amount, amount]);
  }
  return { walletId, transactionId, entryId };
}

export async function insertExternal(em: EntityManager, walletId: string, overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const row = {
    id, provider_id: 'provider', external_transaction_id: id, idempotency_key: id, payload_hash: 'hash',
    wallet_id: walletId, player_id: walletId, round_id: 'round', game_id: 'game', kind: 'BET', amount_minor: '1000', currency: 'BRL',
    status: 'PENDING', created_at: new Date(), ...overrides,
  };
  const columns = Object.keys(row);
  if (columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error('Coluna de fixture inválida');
  await em.execute(`insert into wager_transactions(${columns.join(',')}) values(${columns.map(() => '?').join(',')})`, Object.values(row));
  return row;
}

export async function assertReconciled(em: EntityManager, walletId: string) {
  const [row] = await em.execute<{ balance: string; calculated: string }[]>(`select w.balance_minor::text as balance,
    coalesce(sum(case l.direction when 'CREDIT' then l.amount_minor::numeric else -l.amount_minor::numeric end),0)::text as calculated
    from wallets w left join wallet_ledger_entries l on l.wallet_id=w.id where w.id=? group by w.id`, [walletId]);
  if (!row || BigInt(row.balance) !== BigInt(row.calculated)) throw new Error('Saldo diverge do ledger');
}
