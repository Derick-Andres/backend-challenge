// SQL versionado pela migration. NUMERIC aparece apenas nos intermediários exatos dos CHECKs.
export const financialSchemaSql = `
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE wallets (
  id text PRIMARY KEY, player_id text NOT NULL CHECK (length(player_id)>0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_minor bigint NOT NULL CHECK (balance_minor>=0), version integer NOT NULL CHECK (version>=1),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(player_id,currency)
);
CREATE TABLE wager_transactions (
  id text PRIMARY KEY, provider_id text, external_transaction_id text, idempotency_key text UNIQUE, payload_hash text,
  wallet_id text NOT NULL REFERENCES wallets(id), player_id text NOT NULL,
  round_id text, game_id text, kind text NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount_minor bigint NOT NULL CHECK(amount_minor>=0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  reference_external_transaction_id text, reference_transaction_id text REFERENCES wager_transactions(id),
  status text NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code text, created_at timestamptz NOT NULL, processed_at timestamptz, completed_at timestamptz,
  first_http_status integer CHECK(first_http_status BETWEEN 100 AND 599), first_response jsonb, terminal_response jsonb,
  reference_attempts integer NOT NULL DEFAULT 0 CHECK(reference_attempts>=0), next_reference_attempt_at timestamptz,
  reference_expires_at timestamptz,
  UNIQUE(provider_id,external_transaction_id),
  CHECK ((first_http_status IS NULL) = (first_response IS NULL)),
  CHECK (kind<>'OPENING' OR (provider_id IS NULL AND external_transaction_id IS NULL AND idempotency_key IS NULL
    AND payload_hash IS NULL AND round_id IS NULL AND game_id IS NULL AND reference_external_transaction_id IS NULL)),
  CHECK (kind='OPENING' OR (length(provider_id)>0 AND provider_id IS NOT NULL AND length(external_transaction_id)>0
    AND external_transaction_id IS NOT NULL AND length(idempotency_key)>0 AND idempotency_key IS NOT NULL
    AND length(payload_hash)>0 AND payload_hash IS NOT NULL AND length(round_id)>0 AND round_id IS NOT NULL
    AND length(game_id)>0 AND game_id IS NOT NULL)),
  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR (reference_external_transaction_id IS NOT NULL AND length(reference_external_transaction_id)>0)),
  CHECK (kind NOT IN ('BET','LOSS','OPENING') OR (reference_external_transaction_id IS NULL AND reference_transaction_id IS NULL)),
  CHECK (status<>'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL),
  CHECK ((status='PROCESSED') = (processed_at IS NOT NULL)),
  CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (completed_at IS NOT NULL)),
  CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CHECK (status<>'FAILED' OR failure_code='PERMANENT_PROCESSING_FAILURE'),
  CHECK (status<>'PROCESSED' OR kind='LOSS' OR amount_minor>0),
  CHECK (status<>'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL)
);
CREATE UNIQUE INDEX reversal_once_per_kind ON wager_transactions(reference_transaction_id,kind)
 WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX reference_due ON wager_transactions(next_reference_attempt_at,id) WHERE status='PENDING_REFERENCE';
CREATE INDEX reference_lookup ON wager_transactions(provider_id,reference_external_transaction_id);
CREATE INDEX transaction_wallet ON wager_transactions(wallet_id);
CREATE TABLE wallet_ledger_entries (
  id text PRIMARY KEY, wallet_id text NOT NULL REFERENCES wallets(id), transaction_id text NOT NULL REFERENCES wager_transactions(id),
  wallet_version integer NOT NULL CHECK(wallet_version>=1), direction text NOT NULL CHECK(direction IN ('CREDIT','DEBIT')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  balance_before_minor bigint NOT NULL CHECK(balance_before_minor>=0), balance_after_minor bigint NOT NULL CHECK(balance_after_minor>=0),
  created_at timestamptz NOT NULL, UNIQUE(transaction_id,wallet_id), UNIQUE(wallet_id,wallet_version),
  CHECK (balance_after_minor::numeric = balance_before_minor::numeric + CASE direction WHEN 'CREDIT' THEN amount_minor::numeric ELSE -amount_minor::numeric END)
);
CREATE TABLE inbox_messages (
  consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL,
  received_at timestamptz NOT NULL, processed_at timestamptz, disposition text,
  PRIMARY KEY(consumer_name,message_id), CHECK(length(payload_hash)>0),
  CHECK(disposition IS NULL OR disposition IN ('ACK','DLQ'))
);
CREATE TABLE outbox_messages (
  id text PRIMARY KEY, aggregate_id text NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL, published_at timestamptz,
  CHECK(payload->>'eventId' IS NOT NULL AND payload->>'eventId'=id),
  CHECK(payload->>'eventType' IS NOT NULL AND payload->>'eventType'=event_type),
  CHECK(payload->>'aggregateId' IS NOT NULL AND payload->>'aggregateId'=aggregate_id)
);
CREATE INDEX outbox_due ON outbox_messages(next_attempt_at,occurred_at,id) WHERE published_at IS NULL;

CREATE FUNCTION forbid_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'historical rows are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();

CREATE FUNCTION guard_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.version<>1 THEN RAISE EXCEPTION 'initial version must be 1' USING ERRCODE='23514'; END IF;
 ELSE
   IF (NEW.id,NEW.player_id,NEW.currency,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.player_id,OLD.currency,OLD.created_at)
    OR NEW.version <> OLD.version + (CASE WHEN NEW.balance_minor<>OLD.balance_minor THEN 1 ELSE 0 END)
   THEN RAISE EXCEPTION 'invalid wallet identity or version' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_guard BEFORE INSERT OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION guard_wallet();

CREATE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_amount bigint; entry wallet_ledger_entries; current_wallet wallets;
BEGIN
 SELECT * INTO current_wallet FROM wallets WHERE id=NEW.id;
 IF (current_wallet.version,current_wallet.balance_minor) IS DISTINCT FROM (NEW.version,NEW.balance_minor)
 THEN RAISE EXCEPTION 'only one balance movement per wallet per commit' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN before_amount:=0; ELSE before_amount:=OLD.balance_minor; END IF;
 IF NEW.balance_minor<>before_amount THEN
   SELECT * INTO entry FROM wallet_ledger_entries WHERE wallet_id=NEW.id AND wallet_version=NEW.version;
   IF entry.id IS NULL OR (entry.balance_before_minor,entry.balance_after_minor,entry.currency)
      IS DISTINCT FROM (before_amount,NEW.balance_minor,NEW.currency)
   THEN RAISE EXCEPTION 'balance change requires corresponding ledger' USING ERRCODE='23514'; END IF;
 ELSIF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM wallet_ledger_entries WHERE wallet_id=NEW.id) THEN
   RAISE EXCEPTION 'zero opening cannot have ledger' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_ledger_correspondence AFTER INSERT OR UPDATE ON wallets
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();

CREATE FUNCTION lock_ledger_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM id FROM wallets WHERE id=NEW.wallet_id FOR UPDATE; RETURN NEW; END $$;
CREATE TRIGGER ledger_wallet_lock BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION lock_ledger_wallet();

CREATE FUNCTION check_transaction_finance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t wager_transactions; w wallets; r wager_transactions; e wallet_ledger_entries; entry_count integer; expected_direction text;
BEGIN
 SELECT * INTO t FROM wager_transactions WHERE id=NEW.id;
 SELECT count(*) INTO entry_count FROM wallet_ledger_entries WHERE transaction_id=t.id;
 IF t.status<>'PROCESSED' OR t.kind='LOSS' THEN
   IF entry_count<>0 THEN RAISE EXCEPTION 'nonfinancial state cannot have ledger' USING ERRCODE='23514'; END IF;
 ELSE
   IF entry_count<>1 THEN RAISE EXCEPTION 'processed movement requires one ledger' USING ERRCODE='23514'; END IF;
 END IF;
 IF t.status<>'PROCESSED' THEN RETURN NULL; END IF;
 SELECT * INTO w FROM wallets WHERE id=t.wallet_id;
 IF (w.player_id,w.currency) IS DISTINCT FROM (t.player_id,t.currency)
 THEN RAISE EXCEPTION 'processed transaction wallet context mismatch' USING ERRCODE='23514'; END IF;
 IF t.reference_external_transaction_id IS NOT NULL THEN
   SELECT * INTO r FROM wager_transactions WHERE id=t.reference_transaction_id;
   IF r.id IS NULL OR r.id=t.id OR r.status<>'PROCESSED'
     OR (r.provider_id,r.external_transaction_id,r.player_id,r.wallet_id,r.currency,r.round_id)
       IS DISTINCT FROM (t.provider_id,t.reference_external_transaction_id,t.player_id,t.wallet_id,t.currency,t.round_id)
     OR (t.kind IN ('REFUND','WIN') AND r.kind<>'BET')
     OR (t.kind='ROLLBACK' AND r.kind NOT IN ('BET','WIN','REFUND'))
     OR (t.kind IN ('REFUND','ROLLBACK') AND t.amount_minor<>r.amount_minor)
   THEN RAISE EXCEPTION 'invalid processed reference' USING ERRCODE='23514'; END IF;
 ELSIF t.reference_transaction_id IS NOT NULL THEN
   RAISE EXCEPTION 'undeclared reference' USING ERRCODE='23514';
 END IF;
 IF t.kind='LOSS' THEN RETURN NULL; END IF;
 SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id=t.id;
 expected_direction:=CASE WHEN t.kind='BET' OR (t.kind='ROLLBACK' AND r.kind IN ('WIN','REFUND')) THEN 'DEBIT' ELSE 'CREDIT' END;
 IF (e.wallet_id,e.amount_minor,e.currency,e.direction) IS DISTINCT FROM (t.wallet_id,t.amount_minor,t.currency,expected_direction)
   OR (e.wallet_version=1 AND (t.kind<>'OPENING' OR e.balance_before_minor<>0))
   OR (e.wallet_version<>1 AND t.kind='OPENING')
 THEN RAISE EXCEPTION 'transaction and ledger mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transaction_finance AFTER INSERT OR UPDATE ON wager_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_finance();

CREATE FUNCTION check_ledger_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w wallets; t wager_transactions;
BEGIN
 SELECT * INTO w FROM wallets WHERE id=NEW.wallet_id;
 SELECT * INTO t FROM wager_transactions WHERE id=NEW.transaction_id;
 IF (w.version,w.balance_minor,w.currency) IS DISTINCT FROM (NEW.wallet_version,NEW.balance_after_minor,NEW.currency)
   OR t.status<>'PROCESSED' OR t.kind='LOSS'
 THEN RAISE EXCEPTION 'ledger requires matching wallet movement and processed transaction' USING ERRCODE='23514'; END IF;
 -- The transaction trigger also validates direction/context if the ledger was inserted later.
 IF (t.wallet_id,t.amount_minor,t.currency) IS DISTINCT FROM (NEW.wallet_id,NEW.amount_minor,NEW.currency)
 THEN RAISE EXCEPTION 'ledger transaction mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_wallet_correspondence AFTER INSERT ON wallet_ledger_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_wallet();

CREATE FUNCTION guard_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
   RAISE EXCEPTION 'terminal transaction is immutable' USING ERRCODE='23514';
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','reference_transaction_id','failure_code','processed_at','completed_at','first_http_status','first_response','terminal_response','reference_attempts','next_reference_attempt_at','reference_expires_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','reference_transaction_id','failure_code','processed_at','completed_at','first_http_status','first_response','terminal_response','reference_attempts','next_reference_attempt_at','reference_expires_at'])
   OR (OLD.first_response IS NOT NULL AND (NEW.first_response,NEW.first_http_status) IS DISTINCT FROM (OLD.first_response,OLD.first_http_status))
   OR (OLD.terminal_response IS NOT NULL AND NEW.terminal_response IS DISTINCT FROM OLD.terminal_response)
   OR (OLD.status='PENDING_REFERENCE' AND NEW.status='PENDING')
 THEN RAISE EXCEPTION 'transaction identity/result is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transaction_guard BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION guard_transaction();

CREATE FUNCTION guard_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.consumer_name,NEW.message_id,NEW.payload_hash,NEW.received_at) IS DISTINCT FROM (OLD.consumer_name,OLD.message_id,OLD.payload_hash,OLD.received_at)
   OR OLD.processed_at IS NOT NULL
 THEN RAISE EXCEPTION 'inbox identity/completion is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inbox_guard BEFORE UPDATE ON inbox_messages FOR EACH ROW EXECUTE FUNCTION guard_inbox();
CREATE FUNCTION guard_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.aggregate_id,NEW.event_type,NEW.payload,NEW.occurred_at) IS DISTINCT FROM (OLD.id,OLD.aggregate_id,OLD.event_type,OLD.payload,OLD.occurred_at)
   OR OLD.published_at IS NOT NULL OR NEW.attempts<OLD.attempts
 THEN RAISE EXCEPTION 'outbox envelope/completion is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_guard BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION guard_outbox();
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages'] LOOP
   EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_history_mutation()',tbl);
   IF tbl<>'wallet_ledger_entries' THEN
     EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation()',tbl);
   END IF;
 END LOOP;
END $$;
`;

export const financialSchemaDownSql = `
DROP TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE;
DROP FUNCTION forbid_history_mutation(),guard_wallet(),check_wallet_ledger(),lock_ledger_wallet(),
 check_transaction_finance(),check_ledger_wallet(),guard_transaction(),guard_inbox(),guard_outbox();
`;
