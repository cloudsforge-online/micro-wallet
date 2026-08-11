-- Retire deposit addresses this deployment can never pay out of.
--
-- micro-org#373 §6.1, second item. The gate in `observability.ts` refuses to ISSUE an address on a
-- chain whose native asset has no `WALLET_FEE_QUOTES` entry. It cannot recall the ones handed out
-- before it existed, and `wallet_deposit_addresses_unretrievable{chain=...}` exists precisely to
-- count them. This is the operator action that clears that gauge.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT DO, AND WHY
--
-- It does not delete the assignment row, the `wallets` row, the custody key, or the indexer's
-- `watched_addresses` entry. An address the estate has published is the estate's forever: somebody
-- may send a coin to it years after it stopped being offered, and the ONLY thing that could ever
-- move that coin is the custody key. Deleting the key to tidy a row would convert "a balance nobody
-- is watching" into "a balance nobody can ever spend", which is the strictly worse outcome this
-- whole issue is about. The watch row is kept for the same reason in reverse: it costs nothing, and
-- it carries `history_from_height`, so if the chain is ever switched on the backfill still knows
-- where to start.
--
-- `retired` is a status the schema has always admitted (`deposit_address_assignments_status_ck`)
-- and that no code path writes — `assign` writes `active`, a rotation writes `rotated`. This script
-- is its only writer, deliberately: retiring is a decision about what this estate will support, and
-- a service that made it automatically from an env var would retire every address in the estate the
-- first time `WALLET_FEE_QUOTES` was mistyped.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- THE RULE, not a list of rows: an assignment stays `active` iff its network is the network this
-- deployment serves AND its chain is one this deployment can pay out of. Everything else is a
-- promise the estate cannot keep. Pass both as psql variables so the script cannot be run against
-- the wrong estate by accident:
--
--   psql -v net=mainnet -v payable="'ember','btc','ltc'" -f retire-unretrievable-assignments.sql
--
-- `payable` must be this deployment's own answer, read from the running service rather than
-- guessed — the wallet logs it at boot as `deposit gate … payableChains`, and
-- `wallet_chain_retrievable{chain=...} 1` is the same fact at scrape time.
--
-- Idempotent: re-running it retires nothing, because the second run's WHERE clause matches no
-- `active` row. Wrapped in a transaction with the before/after counts in the output, so a run that
-- surprises you can be rolled back before it commits.

\set ON_ERROR_STOP on

begin;

\echo '── before ──────────────────────────────────────────────────────────────'
select chain, network, status, count(*) as rows
  from deposit_address_assignments
 group by 1, 2, 3
 order by 1, 2, 3;

\echo '── retiring: not this network, or not a chain this estate can pay out of ─'
update deposit_address_assignments
   set status = 'retired'
 where status = 'active'
   and (network <> :'net' or chain not in (:payable))
returning chain, network, address, assigned_at;

\echo '── after ───────────────────────────────────────────────────────────────'
select chain, network, status, count(*) as rows
  from deposit_address_assignments
 group by 1, 2, 3
 order by 1, 2, 3;

-- The check that matters: nothing on this network is left active on a chain that cannot pay out.
-- If this returns a row, the commit below is wrong and you want `rollback`.
\echo '── must be empty ───────────────────────────────────────────────────────'
select chain, network, count(*)
  from deposit_address_assignments
 where status = 'active' and network = :'net' and chain not in (:payable)
 group by 1, 2;

commit;
