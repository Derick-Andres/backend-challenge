import type { EntityManager } from '@mikro-orm/postgresql';

export async function prepareRuntimeRole(em: EntityManager, user: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) throw new Error('Nome de papel inválido');
  const [exists] = await em.execute<{ exists: boolean }[]>('select exists(select 1 from pg_roles where rolname=?) as exists', [user]);
  if (!exists?.exists) {
    const [statement] = await em.execute<{ sql: string }[]>("select format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE',?,?) as sql", [user, password]);
    if (!statement) throw new Error('Não foi possível preparar o papel');
    await em.execute(statement.sql);
  }
  const [attributes] = await em.execute<{ elevated: boolean }[]>(
    'select rolsuper or rolcreatedb or rolcreaterole as elevated from pg_roles where rolname=?', [user],
  );
  if (attributes?.elevated !== false) throw new Error('O papel runtime não pode ser administrativo');
}

export async function grantRuntimeAccess(em: EntityManager, user: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) throw new Error('Nome de papel inválido');
  // Identificador validado; nenhuma interpolação de entrada HTTP.
  await em.execute(`GRANT USAGE ON SCHEMA public TO "${user}"`);
  await em.execute(`GRANT SELECT,INSERT,UPDATE ON wallets,wager_transactions,inbox_messages,outbox_messages TO "${user}"`);
  await em.execute(`GRANT SELECT,INSERT ON wallet_ledger_entries TO "${user}"`);
}
