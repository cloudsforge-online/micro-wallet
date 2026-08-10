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

/**
 * The chains after migration 12, adding `doge` and `etc`.
 *
 * A THIRD CONSTANT RATHER THAN AN EDIT OF THE SECOND, for exactly the reason the second exists:
 * `CHAIN_CK_V10` is interpolated into migration 10's `up`, that text is checksummed, and every
 * database in the estate has already applied it. Changing the string would change migration 10's
 * text and `@cloudsforge/db` would refuse to run at all — not refuse this change, refuse the whole
 * migrator, on every deployment. The list of these constants only ever grows, and each one names
 * the migration it belongs to so a reader can tell which is live without reading the array.
 */
const CHAIN_CK_V12 = `check (chain in ('ember','eth','btc','sol','xrp','ltc','doge','etc'))`

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
  {
    version: 11,
    name: 'outbox_quarantine',
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * A POISON ROW MUST NOT BE ABLE TO STOP THE MONEY PATH.
     *
     * The relay reads `where published_at is null order by occurred_at limit 50`, and a row whose
     * envelope the contract rejects was skipped without being marked — so it stayed at the head of
     * that window for ever. Once the number of unrelayable rows reached the batch size, the window
     * contained nothing else and NO further event could be relayed, whatever its topic.
     *
     * That is not hypothetical. On mainnet it had already happened: 440 unpublished rows, of which
     * the oldest 50 were all `wallet.deposit_address.assigned` — a topic no registry carries — and
     * behind them sat 194 `wallet.wallet.created`, a `wallet.deposit.confirmed`, a
     * `wallet.link.verified` and a `wallet.withdrawal.requested`. That last one is the money path:
     * it is the only topic with a live subscriber, and it was never going to be delivered. The
     * relay re-read the same 50 rows every tick and logged 13,650 errors in five minutes doing it.
     *
     * So the skip becomes a QUARANTINE: the row is set aside, the relay's window moves past it,
     * and everything behind it drains.
     *
     * Set aside, NOT discarded, and not marked published. `published_at` stays null because the
     * fact was never published, and saying otherwise would make the backlog lie about what the
     * estate has seen. `quarantined_at` records that the relay has stopped offering it and
     * `quarantine_reason` records why, so the row is still a visible defect and still replayable:
     * clearing the column returns it to the window, which is what `runbook-dead-letter-drain.md`
     * drains once the producer or the registry is fixed.
     *
     * Validation is deterministic — the same row against the same build fails the same way — so
     * there is no attempt counter here. Retrying an unregistered topic cannot succeed until code
     * changes, and when code changes the drain is the deliberate step that reconsiders it.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      alter table outbox add column if not exists quarantined_at    timestamptz;
      alter table outbox add column if not exists quarantine_reason text;

      -- The relay's access path, narrowed to what the relay can actually offer. Quarantined rows
      -- leave the index for the same reason published ones do: they are no longer candidates, and
      -- an index the size of the backlog is the point of the partial.
      drop index if exists outbox_unpublished_idx;
      create index if not exists outbox_relayable_idx
        on outbox (occurred_at)
        where published_at is null and quarantined_at is null;
    `,
  },
  {
    version: 12,
    name: 'dogecoin_and_ethereum_classic',
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * `doge` and `etc`, in the same five places migration 10 named a chain.
     *
     * Structurally identical to migration 10 and deliberately so — same drop-then-add, same
     * `if exists` on the drop and unconditional add, same validating scan for the same reason
     * (these tables hold thousands of rows, and a `not valid` constraint would leave the schema
     * claiming a guarantee it had not checked). What is worth saying is why it is a separate
     * migration at all rather than a widened `CHAIN_CK_V10`: that constant's text is inside
     * migration 10's checksum, so editing it would make `@cloudsforge/db` refuse to run against
     * every database that has already applied it, which is all of them.
     *
     * **THIS CONSTRAINT IS NOT A FEATURE FLAG, AND WIDENING IT ENABLES NOTHING.** A row reaches
     * these tables only through a request that got past a gate this migration does not touch.
     * Deposits ask `observability.observe`, which asks the indexer, and `INDEXER_CHAINS` follows
     * neither of these two — so it answers `not_followed` and `assignDepositAddress` refuses 422
     * before anything is written. Withdrawals ask `staticFeeQuoter`, which throws for an asset
     * absent from `WALLET_FEE_QUOTES`, and neither is in it — so `requestWithdrawal` answers 503
     * `fee_unavailable`, again before any insert. Both gates are fail-closed by construction and
     * both are operator configuration rather than code.
     *
     * What the constraint decides is what happens on the day somebody DOES point the estate at a
     * Dogecoin or an Ethereum Classic node. Without this, the first legitimate insert fails with a
     * 23514 naming a constraint rather than a chain — after custody has already minted and
     * published a key for an address the row was meant to record. The constraint is here to catch
     * a chain nobody meant to write, and these two are now chains somebody may mean to write.
     *
     * `network` is untouched. Mordor is Ethereum Classic's testnet and Dogecoin's is called
     * testnet3; both are `testnet` here, because this column names the estate's two environments
     * and not the chain's own name for them — the same way `tb`/`tltc` collapse to one value.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      alter table wallets drop constraint if exists wallets_chain_ck;
      alter table wallets add constraint wallets_chain_ck ${CHAIN_CK_V12};

      alter table deposit_address_assignments
        drop constraint if exists deposit_address_assignments_chain_ck;
      alter table deposit_address_assignments
        add constraint deposit_address_assignments_chain_ck ${CHAIN_CK_V12};

      alter table deposit_credits drop constraint if exists deposit_credits_chain_ck;
      alter table deposit_credits add constraint deposit_credits_chain_ck ${CHAIN_CK_V12};

      alter table withdrawals drop constraint if exists withdrawals_chain_ck;
      alter table withdrawals add constraint withdrawals_chain_ck ${CHAIN_CK_V12};

      alter table platform_addresses drop constraint if exists platform_addresses_chain_ck;
      alter table platform_addresses add constraint platform_addresses_chain_ck ${CHAIN_CK_V12};
    `,
  },
  {
    version: 13,
    name: 'wallet_status_attribution',
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * WHO MOVED THIS WALLET'S LIFECYCLE, AND WHY.
     *
     * A wallet could be frozen — or driven to `exported`, which is terminal — with nothing
     * recorded but the new value of `status`. No actor, no reason, no row anywhere saying a
     * decision had been taken. A freeze nobody can attribute cannot be defended, cannot be
     * reviewed and cannot be undone with any confidence that undoing it is right.
     *
     * Two nullable columns rather than a history table. The wallet has one status at a time and
     * these describe the change that produced it; the sequence of changes is the outbox's job, not
     * this table's. Nullable because every row that already exists predates the change and there is
     * no honest value to back-fill — a manufactured actor would be a claim about who did something
     * nobody recorded.
     *
     * NOT added to the wallet's public record, deliberately. `COLUMNS` in `wallets.ts` is the
     * select list the API answers from, and these are not in it: the reason is free text an
     * operator wrote for the estate, and routing operator free text to the account holder is
     * exactly the defect micro-org#314 is about on the withdrawal path. The status itself is what
     * the owner is told.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      alter table wallets add column if not exists status_actor  text;
      alter table wallets add column if not exists status_reason text;
    `,
  },

  {
    version: 14,
    name: 'deposit_credits_unposted_idx',
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THE ACCESS PATH FOR "HOW MUCH MONEY ARRIVED AND WAS NEVER POSTED".
     *
     * `deposit_credits` has three indexes and not one of them serves `ledger_entry_id is null`.
     * That predicate has two readers and both run on a schedule: `pendingCredits`, which is the
     * `deposit.post-credit` retry job's entire input, and `pendingCreditCount`, which micro-org#326
     * makes the sole source of `wallet_deposit_credits_pending` on every scrape on every replica.
     *
     * Without this index the count is a sequential scan of every deposit this service has ever
     * credited, and the HEALTHY estate pays the most for it: with nothing pending there is no
     * matching row to stop early on, so a clean table is scanned in full every time. Measured on
     * postgres 17 on 2026-08-10, 200,000 credited rows and none pending — the shape a working
     * estate has — `select count(*) … where ledger_entry_id is null` touched **2,062 buffers as a
     * sequential scan and 1 buffer as an index-only scan** with this index present, and the retry
     * job's `order by id limit 50` went from a sort over the whole filtered set to the same single
     * buffer.
     *
     * That cost is invisible today: mainnet's `deposit_credits` held 1 row on 2026-08-10, 0 of them
     * unposted. It grows with credited history for ever, which is the shape of a defect only
     * discovered once the table is too big to index quietly. `withdrawals_open_idx` in migration 9
     * is the same decision on the withdrawals table, taken before that table had rows either.
     *
     * Keyed on `id` rather than being a bare predicate index, so it serves `pendingCredits` too:
     * that query is `order by id limit $1`, which reads straight off this index in order instead of
     * walking the primary key and filtering. Partial, so it holds only the backlog — in a healthy
     * service that is an empty index, which costs nothing to maintain and nothing to scan.
     *
     * No `network` predicate, deliberately, because neither reader has one. `pendingCredits` will
     * pick up and try to post a row on any network, so an index that excluded some of them would
     * serve a narrower question than the one being asked.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      create index if not exists deposit_credits_unposted_idx
        on deposit_credits (id)
        where ledger_entry_id is null;
    `,
  },

  {
    version: 15,
    name: 'deposit_token_sightings',
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * A TOKEN TRANSFER THAT ARRIVED AT A DEPOSIT ADDRESS AND WILL NOT BE CREDITED.
     *
     * micro-org#200. An ERC-20 transfer into a custodial deposit address was consumed and
     * discarded — `token_deposit_unsupported`, no row anywhere, no notification, no number. The
     * decision to refuse is right and this migration does not change it. What it changes is that
     * the refusal now leaves EVIDENCE, so a user and an operator can both see money that arrived
     * and is not spendable, instead of neither being able to.
     *
     * ── This is not a step towards crediting, and the shape says so ──────────────────────────
     *
     * There is no `ledger_entry_id`, no `credited_at`, no status column and nothing that could
     * ever be flipped to "credited". Crediting a token needs a decimals value from a registry
     * this service does not read, a `chain_assets` row only `micro-ledger` may write and a
     * withdrawal path that does not exist; a column here that looked like a switch would invite
     * exactly the change the issue exists to prevent. When crediting is built it will write
     * `deposit_credits`, and these rows will stay as the record of the interval.
     *
     * ── Why the amount is stored at all, when nothing may act on it ──────────────────────────
     *
     * `numeric(78,0)`, in the token's own smallest units, and it is NOT a balance: it is one
     * movement, like every other amount in this schema. It carries no decimals, because this
     * service does not know them — `contracts-money.assetDecimals` throws for a `TOKEN:` code
     * rather than guess 18, and a six-decimal stablecoin rendered at eighteen is wrong by 10^12.
     * So the raw integer is stored and the API hands it out unscaled and says so. An unscaled
     * integer a reader must interpret is honest; a formatted number nobody can justify is not.
     *
     * ── `token_asset_code`, not a symbol ─────────────────────────────────────────────────────
     *
     * `TOKEN:<chain>:<network>:<0x contract>`, built by `contracts-money.chainTokenAssetCode`,
     * which throws on a brand name. A symbol read off a contract is mutable, spoofable and
     * off-chain, and `USDT` as a code forces one exponent onto three deployments with two
     * different ones. The contract address is the only name that cannot lie.
     *
     * ── NO `chain_ck` AND NO `network_ck`, AND THAT IS THE STRONGER OPTION, NOT THE LAZIER ONE ─
     *
     * The other five money tables each carry `check (chain in (…))`, and each one is a copy of the
     * same list that a chain widening then has to remember to widen — `migrations.test.ts` asserts
     * a widening touches all five precisely because forgetting one is silent until the first
     * legitimate insert fails with a 23514, after custody has already minted a key.
     *
     * A sighting cannot exist without an assignment: it is written only when one is found for the
     * exact address, and its `chain` and `network` are the values that lookup matched on. So the
     * scope is not an independent fact to re-check — it is the parent's, and a copied CHECK here
     * would be a sixth copy of a list, held in step by a test rather than by the database, that
     * could disagree with the row it was copied from.
     *
     * The composite foreign key below says that instead, and says it in the only place that cannot
     * drift: `(assignment_id, chain, network)` must be a row of `deposit_address_assignments`, so
     * a sighting on a chain the assignment is not on is **unrepresentable** rather than merely
     * checked, and a future chain is admitted here the moment it is admitted there with nothing to
     * remember. It needs `(id, chain, network)` to be unique on the parent, which the ALTER below
     * adds — `id` is already the primary key, so the constraint is free at write time and the index
     * is the size of one row per address ever issued (243 on mainnet, 2026-08-10).
     *
     * `wallet_id` keeps its ordinary FK to `wallets`, as `deposit_credits` does.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      -- The parent key the composite reference below needs. Redundant as a uniqueness claim — id
      -- is already the primary key — and that is the point: it costs nothing to guarantee and it
      -- is what lets the child inherit the scope instead of restating it.
      alter table deposit_address_assignments
        drop constraint if exists deposit_address_assignments_id_scope_uniq;
      alter table deposit_address_assignments
        add constraint deposit_address_assignments_id_scope_uniq unique (id, chain, network);

      create table if not exists deposit_token_sightings (
        id               uuid        primary key,
        user_id          uuid        not null,
        assignment_id    uuid        not null,
        wallet_id        uuid        not null references wallets (id),
        -- Not independently constrained. See the header: the composite FK makes these the
        -- assignment's own chain and network, which is a guarantee rather than a copied list.
        chain            text        not null,
        network          text        not null,
        address_key      text        not null,
        -- The contract the transfer was emitted by, lower-case hex.
        token_address    text        not null,
        -- TOKEN:<chain>:<network>:<contract>. See the header.
        token_asset_code text        not null,
        -- The token's own smallest units. Uninterpretable without decimals this service does not
        -- have, and deliberately never scaled here.
        amount           numeric(78,0) not null,
        tx_hash          text        not null,
        -- Never null: a token transfer is a log, and a movement with no log index is not one.
        log_index        integer     not null,
        block_height     bigint      not null,
        confirmations    integer     not null,
        -- Derived from (chain, network, tx_hash, log_index) exactly as \`credit_key\` is, so a
        -- redelivery, a reorg re-emit and a second event describing one movement collapse to one
        -- row whatever their event ids are.
        sighting_key     text        not null,
        first_seen_at    timestamptz not null default now(),
        constraint deposit_token_sightings_amount_ck check (amount > 0),
        constraint deposit_token_sightings_key_uniq unique (sighting_key),
        constraint deposit_token_sightings_assignment_fk
          foreign key (assignment_id, chain, network)
          references deposit_address_assignments (id, chain, network)
      );

      -- The user's own read, newest first. Same shape as deposit_credits_user_idx because it
      -- serves the same question asked of a different table.
      create index if not exists deposit_token_sightings_user_idx
        on deposit_token_sightings (user_id, id desc);
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
  'deposit_token_sightings',
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
