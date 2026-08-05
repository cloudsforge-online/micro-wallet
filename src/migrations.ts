/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **Expand/contract is not advice.** A rolling deploy always runs two versions of this service
 * against one schema, so every change is four releases: add a column, deploy code that writes
 * both, backfill, deploy code that reads the new one, then drop the old one.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 5" means. The fix for a wrong migration is always a new migration.
 *
 * ## The one thing this schema does not have
 *
 * **There is no balance column anywhere in it.** 04-domain-model §11: "No 'user balance' column
 * anywhere outside the ledger's projection. Every service that wants a balance asks the ledger. A
 * cached balance in a product database is the bug that made Crucible's bot state diverge from
 * Pay's." Every amount stored below is the amount of a *specific movement* — a credit that
 * happened, a withdrawal that was asked for — and never a running total. Adding a total here
 * would make this service a second, unreconcilable source of truth for money.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

/**
 * The chain and network check constraints, written once.
 *
 * `network` is checked in the database and not merely in TypeScript because 04-domain-model §4.1
 * makes it an invariant: "Every record carries `chain` and `network` and no query may span
 * networks." The XRP testnet/mainnet address collision in 00-current-state §3.5 is what happens
 * when that is a convention rather than a constraint.
 */
/*
 * **THIS CONSTANT IS FROZEN AT THE FIVE CHAINS MIGRATION 9 SHIPPED WITH, AND MUST STAY THAT WAY.**
 * `ltc` was added to the service in migration 10 by ALTERing each constraint, not by editing this
 * string: `@cloudsforge/db` checksums every migration's text and refuses a run where an applied
 * one changed, so widening the literal here would make every deployment that has already run
 * migrations 5 to 9 refuse to start. It is the same rule that sent `ledger` to a new migration 14
 * for its `chain_assets` row rather than back to migration 11.
 */
const CHAIN_CK = `check (chain in ('ember','eth','btc','sol','xrp'))`
const NETWORK_CK = `check (network in ('mainnet','testnet'))`

/** The chains after migration 10. Kept beside the above so the pair is read together. */
const CHAIN_CK_V10 = `check (chain in ('ember','eth','btc','sol','xrp','ltc'))`

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs
    // table missing the (kind, key) unique constraint, which silently turns every recurring
    // enqueue into a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      --
      -- This is the FIRST of the two belts under "a redelivered deposit event credits exactly
      -- once". The second is deposit_credits.credit_key below, and both are needed: the inbox
      -- stops a redelivery of the SAME event, the credit key stops two DIFFERENT events that
      -- describe the same on-chain movement — which is precisely what happens when the indexer
      -- re-emits after a reorg puts a transaction back at depth.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'idempotency',
    up: `
      -- The shape is taken from forge-pay's store.ts:153, which is the best code in the existing
      -- estate. See src/idempotency.ts for what each column is load-bearing for.
      create table if not exists idempotency_keys (
        key          text        primary key,
        user_id      uuid        not null,
        route        text        not null,
        request_hash text        not null,
        -- NULL means "claimed but not finished". A reader that finds NULL must answer "in
        -- flight", never "already done": the claiming transaction may still roll back.
        response     jsonb,
        created_at   timestamptz not null default now()
      );

      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },
  {
    version: 5,
    name: 'wallets',
    up: `
      -- 04-domain-model §3.1. One row per wallet a user has, of any origin.
      create table if not exists wallets (
        id              uuid        primary key,
        user_id         uuid        not null,
        origin          text        not null,
        chain           text        not null,
        network         text        not null,
        -- The address as it should be displayed: EIP-55 mixed case for EVM and Ember families.
        address         text        not null,
        -- The address as it should be COMPARED. EVM addresses have three valid spellings of one
        -- account, and forge-pay's withdrawals.ts carries the scar: two "is this our own address"
        -- checks were equality against EIP-55 rows, so a user pasting their own deposit address
        -- in lowercase passed both and was charged a fee to move money in a circle.
        address_key     text        not null,
        label           text,
        is_primary      boolean     not null default false,
        status          text        not null default 'provisioning',
        -- Present only when origin = 'managed'. The constraint below makes that an invariant
        -- rather than a convention: an external wallet with a custody key would claim we hold a
        -- key we do not, and a managed wallet without one is a wallet nothing can ever sign for.
        custody_key_urn text,
        created_at      timestamptz not null default now(),
        updated_at      timestamptz not null default now(),
        verified_at     timestamptz,
        exported_at     timestamptz,
        retired_at      timestamptz,
        constraint wallets_chain_ck ${CHAIN_CK},
        constraint wallets_network_ck ${NETWORK_CK},
        constraint wallets_origin_ck check (origin in ('managed','external','watch')),
        constraint wallets_status_ck
          check (status in ('provisioning','active','frozen','exported','retiring','retired')),
        constraint wallets_custody_urn_ck
          check ((origin = 'managed') = (custody_key_urn is not null)),
        -- One row per address per user per network. Two rows for one address would let a
        -- rotation, a re-import and a watch entry each carry a different lifecycle for the same
        -- funds.
        constraint wallets_address_uniq unique (user_id, chain, network, address_key)
      );

      -- 04-domain-model §3.1: "At most one per (user_id, chain, network) — partial unique index".
      -- Partial rather than a plain unique, because 'is_primary = false' is the common case and a
      -- plain unique on the triple would permit exactly one wallet per chain in total.
      create unique index if not exists wallets_primary_uniq
        on wallets (user_id, chain, network)
        where is_primary;

      create index if not exists wallets_user_idx on wallets (user_id, created_at desc);

      -- Answering "is this address ours" needs a lookup that spans every user: paying a
      -- stranger's deposit address would credit THEM. forge-pay's isPlatformAddress does the same
      -- span for the same reason.
      create index if not exists wallets_address_key_idx on wallets (chain, network, address_key);
    `,
  },
  {
    version: 6,
    name: 'external-wallet-links',
    up: `
      -- 04-domain-model §3.2.
      --
      -- The challenge is a table of its own rather than a column on the link, and that is the
      -- whole of the replay defence. A nonce column on the link can only ever hold the LATEST
      -- challenge, so a signature over a previous one is indistinguishable from a fresh signature
      -- once the column has moved on. A row per challenge, claimed by an UPDATE that requires
      -- consumed_at to be NULL, makes a replayed nonce a refusal that cannot be raced.
      create table if not exists link_challenges (
        nonce        text        primary key,
        wallet_id    uuid        not null references wallets (id) on delete cascade,
        user_id      uuid        not null,
        scheme       text        not null,
        -- The exact bytes the user is asked to sign. Stored rather than rebuilt at verification
        -- time: rebuilding means the verifier and the issuer each have their own opinion of the
        -- message, and any difference between them is a signature that verifies against a
        -- message the user never saw.
        message      text        not null,
        domain       text        not null,
        uri          text        not null,
        issued_at    timestamptz not null default now(),
        expires_at   timestamptz not null,
        consumed_at  timestamptz,
        constraint link_challenges_scheme_ck
          check (scheme in ('eip4361','solana_signmessage','bip322','xrp_signed_memo'))
      );

      create index if not exists link_challenges_wallet_idx on link_challenges (wallet_id);

      create table if not exists external_wallet_links (
        wallet_id       uuid        primary key references wallets (id) on delete cascade,
        user_id         uuid        not null,
        scheme          text        not null,
        challenge_nonce text        references link_challenges (nonce),
        signature       text,
        verified_at     timestamptz,
        revoked_at      timestamptz,
        created_at      timestamptz not null default now(),
        constraint external_wallet_links_scheme_ck
          check (scheme in ('eip4361','solana_signmessage','bip322','xrp_signed_memo'))
      );

      -- authorisations[] from the domain model, as a child table.
      --
      -- The model spells it as an array; it is stored as rows because the requirement is that
      -- each is "granted explicitly and revocable individually". An array can hold the live set
      -- but not WHEN each grant and each revocation happened, and a withdrawal that was permitted
      -- last Tuesday is a question an auditor will ask. The API still presents the live set as an
      -- array, so the contract is the model's.
      create table if not exists external_wallet_authorisations (
        wallet_id     uuid        not null references wallets (id) on delete cascade,
        authorisation text        not null,
        granted_at    timestamptz not null default now(),
        granted_by    text        not null,
        revoked_at    timestamptz,
        revoked_by    text,
        primary key (wallet_id, authorisation),
        constraint external_wallet_authorisations_ck
          check (authorisation in (
            'withdrawal_destination',
            'token_owner',
            'community_membership',
            'governance_vote',
            'market_settlement'
          ))
      );
    `,
  },
  {
    version: 7,
    name: 'deposit-address-assignments',
    up: `
      -- 04-domain-model §3.4. Which wallet is the deposit target for a (user, asset, network),
      -- and since when.
      --
      -- **A rotation is a new row, never an edit.** forge-pay mutates the address on the existing
      -- deposit_addresses row, and because the same row also carries the observed high-water mark
      -- ('last_seen'), the new address starts below the old total: every probe afterwards reads a
      -- balance lower than the mark, reports a 'regression', and refuses to credit — permanently,
      -- for that user and that coin, until an operator reconciles it by hand. Separating the
      -- assignment from the wallet is what makes rotation cheap and reversible, and it is why
      -- 'supersedes_id' exists rather than an UPDATE.
      create table if not exists deposit_address_assignments (
        id              uuid        primary key,
        user_id         uuid        not null,
        asset_code      text        not null,
        chain           text        not null,
        network         text        not null,
        wallet_id       uuid        not null references wallets (id),
        address         text        not null,
        address_key     text        not null,
        custody_key_urn text        not null,
        status          text        not null default 'active',
        assigned_at     timestamptz not null default now(),
        rotated_at      timestamptz,
        -- The assignment this one replaced. A chain of these is the address history for one
        -- (user, asset, network), and it is what lets a deposit to a rotated address still be
        -- credited to the right person years later.
        supersedes_id   uuid        references deposit_address_assignments (id),
        -- Registered with the indexer's watched_addresses. NULL means the registration has not
        -- succeeded yet and the retry job still owns it — a deposit address that is not watched
        -- produces no event, so this is not cosmetic.
        watched_at      timestamptz,
        constraint deposit_address_assignments_chain_ck ${CHAIN_CK},
        constraint deposit_address_assignments_network_ck ${NETWORK_CK},
        constraint deposit_address_assignments_status_ck
          check (status in ('active','rotated','retired'))
      );

      -- At most one ACTIVE assignment per (user, asset, network). Rotated and retired rows stay,
      -- which is the entire point of the table.
      create unique index if not exists deposit_address_assignments_active_uniq
        on deposit_address_assignments (user_id, asset_code, network)
        where status = 'active';

      -- The crediting lookup: an inbound event names (chain, network, address) and nothing else.
      create index if not exists deposit_address_assignments_address_idx
        on deposit_address_assignments (chain, network, address_key);

      create index if not exists deposit_address_assignments_unwatched_idx
        on deposit_address_assignments (assigned_at)
        where watched_at is null;
    `,
  },
  {
    version: 8,
    name: 'deposit-credits',
    up: `
      -- One row per credited on-chain movement. Not a balance: the ledger holds the balance, and
      -- this holds the decision to credit and the evidence behind it.
      create table if not exists deposit_credits (
        id             uuid        primary key,
        user_id        uuid        not null,
        assignment_id  uuid        not null references deposit_address_assignments (id),
        wallet_id      uuid        not null references wallets (id),
        chain          text        not null,
        network        text        not null,
        address_key    text        not null,
        asset_code     text        not null,
        -- numeric(78,0), never text and never a float. 04-domain-model §0: the current estate
        -- stores these as TEXT, which means the database cannot check its own arithmetic.
        amount         numeric(78,0) not null,
        tx_hash        text        not null,
        -- NULL for a native transfer, which has no log. Part of the credit key, so it is
        -- coalesced there rather than left to produce a NULL key.
        log_index      integer,
        block_height   bigint      not null,
        confirmations  integer     not null,
        -- **The second belt.** Derived from (chain, network, txHash, logIndex) and nothing else,
        -- so two events describing one on-chain movement collapse to one row whatever their event
        -- ids are. This is also the ledger idempotency key, so a credit that committed here and
        -- a credit that committed there cannot disagree.
        credit_key     text        not null,
        ledger_entry_id text,
        credited_at    timestamptz not null default now(),
        constraint deposit_credits_chain_ck ${CHAIN_CK},
        constraint deposit_credits_network_ck ${NETWORK_CK},
        constraint deposit_credits_amount_ck check (amount > 0),
        constraint deposit_credits_key_uniq unique (credit_key)
      );

      create index if not exists deposit_credits_user_idx on deposit_credits (user_id, id desc);
    `,
  },
  {
    version: 9,
    name: 'withdrawals',
    up: `
      create table if not exists withdrawals (
        id                    uuid        primary key,
        user_id               uuid        not null,
        chain                 text        not null,
        network               text        not null,
        asset_code            text        not null,
        destination_address   text        not null,
        destination_key       text        not null,
        -- The verified external wallet the destination belongs to, when it is one of the user's.
        -- NULL for an address the user typed that they have not linked. An UNVERIFIED wallet is
        -- never accepted at all — see withdrawals.ts.
        destination_wallet_id uuid        references wallets (id),
        -- What leaves the user's available balance. The fee comes out of THIS rather than on top,
        -- so a user can always withdraw their whole balance — forge-pay gets this right and the
        -- split must preserve it.
        amount                numeric(78,0) not null,
        fee                   numeric(78,0) not null,
        net                   numeric(78,0) not null,
        state                 text        not null default 'requested',
        -- The ledger entry that moved available to reserved. The reservation IS the entry: there
        -- is no reservations table in the ledger to fall out of step with the journal.
        reservation_entry_id  text,
        -- Set when micro-settlement acknowledges. A URN rather than a foreign key: 04-domain-model
        -- §11 forbids cross-service foreign keys.
        settlement_urn        text,
        tx_hash               text,
        failure_reason        text,
        idempotency_key       text        not null,
        requested_at          timestamptz not null default now(),
        updated_at            timestamptz not null default now(),
        reserved_at           timestamptz,
        queued_at             timestamptz,
        settled_at            timestamptz,
        failed_at             timestamptz,
        refunded_at           timestamptz,
        constraint withdrawals_chain_ck ${CHAIN_CK},
        constraint withdrawals_network_ck ${NETWORK_CK},
        constraint withdrawals_amount_ck check (amount > 0),
        constraint withdrawals_fee_ck check (fee >= 0 and fee < amount),
        constraint withdrawals_net_ck check (net = amount - fee),
        constraint withdrawals_state_ck
          check (state in (
            'requested','reserved','queued','settling','settled','stuck','failed','refunded','cancelled'
          )),
        constraint withdrawals_idempotency_uniq unique (idempotency_key)
      );

      create index if not exists withdrawals_user_idx on withdrawals (user_id, id desc);

      -- The stuck sweep's access path, partial on the states that can still go wrong. A full-table
      -- scan here would grow with settled history for ever.
      create index if not exists withdrawals_open_idx
        on withdrawals (updated_at)
        where state in ('reserved','queued','settling');

      -- Addresses this platform owns that are not a user's wallet: treasuries, deployers, sweep
      -- destinations. Paying one of these would debit the user and credit us.
      create table if not exists platform_addresses (
        chain       text        not null,
        network     text        not null,
        address_key text        not null,
        purpose     text        not null,
        note        text,
        added_at    timestamptz not null default now(),
        primary key (chain, network, address_key),
        constraint platform_addresses_chain_ck ${CHAIN_CK},
        constraint platform_addresses_network_ck ${NETWORK_CK},
        constraint platform_addresses_purpose_ck
          check (purpose in ('treasury','deployer','sweep','other'))
      );
    `,
  },
  {
    version: 10,
    name: 'litecoin',
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * Litecoin, in the five places the schema names a chain.
     *
     * A NEW MIGRATION AND NOT AN EDIT OF THE OLD ONES, for the reason the header of this file
     * gives: an applied migration's text is checksummed, so widening `CHAIN_CK` in place would
     * make `@cloudsforge/db` refuse to run against every database that already has migrations 5
     * to 9 — which is every deployment that exists. The fix for a constraint that has to change
     * is always another migration.
     *
     * **DROP THEN ADD, AND THE ADD IS VALIDATING.** Postgres cannot widen a check constraint in
     * place. The add re-scans each table, which is correct rather than merely acceptable here:
     * these tables hold thousands of rows, not billions, and a `not valid` constraint would leave
     * the schema claiming a guarantee it had not checked. If one of these tables is ever large
     * enough for the scan to matter the answer is `not valid` plus a separate `validate
     * constraint`, and it is not that today.
     *
     * `if exists` on each drop so a database provisioned from a future baseline is not broken by
     * a constraint that was never separately created; the adds are unconditional, because a
     * missing constraint here is the thing this migration exists to prevent.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      alter table wallets drop constraint if exists wallets_chain_ck;
      alter table wallets add constraint wallets_chain_ck ${CHAIN_CK_V10};

      alter table deposit_address_assignments
        drop constraint if exists deposit_address_assignments_chain_ck;
      alter table deposit_address_assignments
        add constraint deposit_address_assignments_chain_ck ${CHAIN_CK_V10};

      alter table deposit_credits drop constraint if exists deposit_credits_chain_ck;
      alter table deposit_credits add constraint deposit_credits_chain_ck ${CHAIN_CK_V10};

      alter table withdrawals drop constraint if exists withdrawals_chain_ck;
      alter table withdrawals add constraint withdrawals_chain_ck ${CHAIN_CK_V10};

      alter table platform_addresses drop constraint if exists platform_addresses_chain_ck;
      alter table platform_addresses add constraint platform_addresses_chain_ck ${CHAIN_CK_V10};
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the
 * old schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted.
 *
 * forge-pay creates its tables with inline `CREATE TABLE IF NOT EXISTS` at boot and has no
 * `schema_migrations` table at all. Pointing the migrator at such a database would try to create
 * tables that already exist. Setting this to the migration that describes what is already there
 * records those migrations as applied without running them, and only ever does so on a database
 * with no migration rows — a one-way bridge that cannot fire twice or skip a pending change.
 *
 * **Zero, and it stays zero.** This service does not adopt forge-pay's database: its tables are a
 * different shape, in a different account, and the migration path in 10-migration-strategy is a
 * backfill through the API rather than a schema handover.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test suite's truncate and for the migrator's log. */
export const TABLES: readonly string[] = Object.freeze([
  'deposit_credits',
  'deposit_address_assignments',
  'external_wallet_authorisations',
  'external_wallet_links',
  'link_challenges',
  'withdrawals',
  'platform_addresses',
  'wallets',
  'idempotency_keys',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
  'inbox',
])
