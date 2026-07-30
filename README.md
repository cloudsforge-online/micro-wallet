# micro-wallet

The user-facing money API for CloudsForge.

**It owns no balances — the ledger does. It owns no keys — custody does. It orchestrates.**

That sentence is the whole design, and it is enforced rather than asserted:
`src/migrations.ts` has no balance column and `migrations.test.ts` fails the build if one appears;
there is no code path in this repository that can hold private key material, and `secp256k1.ts`
can only *recover* a public key, never sign with a private one.

Replaces the user surface of `forge-pay` — 03-repository-responsibilities §1.1. That service keeps
running and is the rollback target; nothing in it is modified.

---

## What it owns

| Area | Shape | Reference |
| --- | --- | --- |
| Wallet registry | `wallet` rows with `origin` (`managed`/`external`/`watch`), a lifecycle, and at most one primary per `(user, chain, network)` | 04-domain-model §3.1 |
| External wallets | `external_wallet_link` with signed-challenge verification and a closed, individually revocable authorisation set | §3.2 |
| Deposits | `deposit_address_assignment` per `(user, asset, network)`, registered with the indexer, credited on `indexer.deposit.confirmed` | §3.4 |
| Withdrawals | Request, validate, quote, **reserve through the ledger**, queue for `micro-settlement` | §4.4 |
| Conversions, transfers, spends | Ledger entries, every one requiring an idempotency key | §2.2 |
| Portfolio | Ledger balances composed with indexer-observed chain activity, paged | — |

## The five defects it exists to close

1. **`POST /spend` accepted a missing idempotency key.** forge-pay's own comment says a retry
   without one debits twice, and it proceeds anyway — on the most-retried money route in the
   estate. Here every money route refuses with 400 (`src/idempotency.ts`, `requireIdempotencyKey`).
2. **A deposit address rotation mutated the address row.** The same row carried the observed
   high-water mark, so the new address started below it, every probe reported a regression, and
   crediting froze permanently for that user and coin. Here a rotation is a new assignment row and
   the old address keeps crediting (`src/deposits.ts`).
3. **No reservation existed.** A withdrawal debited the balance outright, so a failure had to be
   repaired by hand and a trial balance could not see money in flight. Here it is a posting pair
   through the ledger, `available → reserved` (`src/withdrawals.ts`).
4. **A cached balance in a product database.** The bug that made Crucible's bot state diverge from
   Pay's. There is no balance column here at all.
5. **The wallet returned the entire unpaginated ledger on every call.** Every unbounded read here
   is keyset-paged on a UUIDv7 id.

## Exactly once, twice over

A redelivered deposit event must credit once, and **two independent mechanisms guarantee it**:

* `withInbox` on `(topic, event_id)` — stops a redelivery of the *same event*.
* `deposit_credits.credit_key`, unique, derived from `(chain, network, txHash, logIndex)` — stops
  *two different events describing one movement*, which is what the indexer produces when a reorg
  drops a transaction and it later returns to depth.

The same `credit_key` is the idempotency key sent to the ledger, so the third mechanism keys on the
same value and the two services cannot disagree.

## Running it

```sh
pnpm install
cp .env.example .env      # then fill in the secrets
pnpm migrate              # the one-shot migrator, never the service
pnpm start
```

```sh
pnpm typecheck
pnpm test                 # database tests skip without WALLET_TEST_DATABASE_URL
WALLET_TEST_DATABASE_URL=postgres://…/wallet_test pnpm test
```

`--test-concurrency=1` is required, not a preference: every database test file truncates this
service's tables between cases and `node:test` runs *files* in parallel by default. A TRUNCATE
takes an AccessExclusiveLock, so one file's reset deadlocks against another file's inserts.

## Cryptography

Two primitives are hand-rolled, both for the reason `forge-pay/src/keccak.ts` already states:

* **Keccak-256** (`src/keccak.ts`). Node has SHA3-256 but not Keccak-256 — same permutation,
  different padding — so `createHash('sha3-256')` produces plausible-looking wrong answers. Tested
  against the published vectors *and* against Node's own SHA3-256 across the 136-byte rate
  boundary, which pins the permutation against an independent implementation.
* **secp256k1 public-key recovery** (`src/secp256k1.ts`). Node can verify an ECDSA signature but
  cannot recover a public key from one, and recovery is what EIP-4361 needs. Tested by signing with
  Node's OpenSSL-backed ECDSA and asserting recovery lands on the address OpenSSL's own key derives
  to.

There is no signing in this service and there never will be.

## What is not here

* **Sending the payment.** That is `micro-settlement`, which does not exist yet.
  `src/settlement.ts` is the interface it will implement, and `wallet.withdrawal.requested` is the
  handover. The outbox makes emitting into the void correct rather than merely tolerable: the relay
  computes its delivery set from the live subscription list on every pass.
* **Watching the chain.** That is the indexer. AD-07, and the reason deposits here carry real
  transaction hashes for the first time in the estate.
* **Holding keys.** That is custody. §3.3.
