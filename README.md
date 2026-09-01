# micro-wallet

[![ci](https://github.com/cloudsforge-online/micro-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-wallet/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

<!-- absorbed-banner -->
> ## ⚠️ This code no longer deploys as a service. It runs inside `micro-agora`.
>
> Absorbed in wave **M5d**, release **2026.8.107** (2026-08-31) of the estate's service-merge sequence.
>
> **The canonical source is [`micro-agora`](https://github.com/cloudsforge-online/micro-agora)
> at [`src/wallet/`](https://github.com/cloudsforge-online/micro-agora/tree/main/src/wallet).
> Edit there.** What is in this repository is the copy the merge was made from: it is frozen, no
> image is published from it, `cfctl bump` skips it, and nothing in the estate runs it.
>
> **Why the repository still exists.** Its registry row survives as `absorbed(…)`, which is what
> keeps the Kubernetes `Service` of this name resolving — an `ExternalName` alias to `agora`, so
> every caller that addresses it by service name still reaches the code. `deployableRepos()` keeps
> the row and `releasableRepos()` drops it. The history here is also the history of the module.
>
> **What did not change**, and this is the point of the merge rather than an aside: the database is
> still its own, the routes are unchanged except where a collision forced a remount, the migrations
> still run under this module's name, and the trust boundary is unchanged. A merge moved a process
> boundary, not a responsibility.
>
> Everything below describes the domain, and remains accurate. Read the reasoning — including what
> was refused and why — in
> [`micro-deploy/docs/service-merge-plan.md`](https://github.com/cloudsforge-online/micro-deploy/blob/main/docs/service-merge-plan.md).

The user-facing money API for CloudsForge.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

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
| Withdrawals | Request, validate, quote, **reserve through the ledger**, hand to `micro-settlement`, which builds and broadcasts. LTC and BTC pay today; an MWEB destination is refused (see "What is not here") | §4.4 |
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

### Rotating the outbox secret

| Variable | | |
| --- | --- | --- |
| `OUTBOX_SIGNING_SECRET` | required | The key this service **signs** its own outbox deliveries with. One key, always. |
| `OUTBOX_ACCEPT_SECRETS` | optional | Comma-separated, **newest first**. The keys `POST /events` will **accept**. Defaults to `[OUTBOX_SIGNING_SECRET]`. |

`OUTBOX_SIGNING_SECRET` is one HMAC key shared across the estate, so replacing it is a rolling
change or it is an outage: the instant a producer's relay adopts the new key, a receiver that
accepts only the old one answers 401 to every delivery and the relay retries it for ever — deposit
confirmations and settlement outcomes stop arriving, silently, with a green `/livez`.

`OUTBOX_ACCEPT_SECRETS` is the overlap window. Set it to `new,old`, redeploy the producers, then
drop `old`. Each entry gets the same checks as the signing secret — no placeholders, at least 24
characters, and a repeated entry is refused because it makes "which key verified this" ambiguous,
and that answer is how you know the rotation finished. A delivery that verified under anything but
the first entry logs `event signed with a superseded secret`: when that line stops, the window can
be closed. Leaving the variable unset is exactly today's behaviour.

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

## What a scrape says about deposit addresses

Six series, all labelled by `chain`, all written together at scrape time by
`sampleDepositAddressMetrics` and meant to be read together:

| Series | Means |
| --- | --- |
| `wallet_deposit_addresses_unwatched{chain}` | Addresses the indexer has not been asked to watch. Money sent to one produces no event. |
| `wallet_deposit_addresses_unobservable{chain}` | The part of that backlog on a chain the indexer follows no source for. Not a fault — an owner deciding whether to support the chain. |
| `wallet_deposit_addresses_unretrievable{chain}` | Active addresses already issued on a chain this deployment states no way to pay out of. Promises outstanding against a capability that is gone or never arrived. |
| `wallet_chain_observable{chain}` | 1 if deposits on the chain are issued and credited at all. **An AND of the two conditions below.** |
| `wallet_chain_retrievable{chain}` | 1 if `WALLET_FEE_QUOTES` names the chain's native asset, so a withdrawal can be priced. 0 shuts deposits however well the indexer follows the chain. |
| `wallet_chain_observability_unknown{chain}` | 1 if this replica has *never obtained an answer* and is refusing on that basis. |

`unwatched - unobservable` per chain is the part somebody has to fix, and it is the only honest
alerting expression over these. Every chain gets a **measured** zero on every scrape rather than an
absent series, because absent and healthy are the same shape to an alert, and because a labelled
gauge cannot be removed once set.

**A 0 on `wallet_chain_observable` is three conditions with three different repairs**, which is why
the other two 0/1 series exist rather than being folded into it:

* `wallet_chain_retrievable == 0` — this deployment has stated no withdrawal fee for the chain's
  coin. The repair is a `WALLET_FEE_QUOTES` entry, and nothing about the indexer is wrong.
* `wallet_chain_observability_unknown == 1` — this replica has never obtained an answer. A fault,
  and it is refusing deposits right now.
* both 0 — the indexer follows no source for the chain. An owner's decision, and the steady state
  for most chains.

The second one is the reason a gauge cannot simply say *unknown*; the same reason
`ledger_reconciliation_observed` sits beside `ledger_reconciliation_drift`. The first arrived with
the deposit gate in micro-org#373 §6.1 — **and did not arrive with it.** The write existed from
2.5.18 and the name was never registered, so `Metrics.set` dropped it silently and the series
reached no scrape until 2.5.21. An operator watching `wallet_chain_observable{chain="btc"}` go to 0
had nothing to distinguish a fee table from an outage.

**There is no such thing as a frozen deposit address here, and no metric will ever report one.**
`deposit_address_assignments_status_ck` admits `active`, `rotated` and `retired`. The state a
deployed alert rule spent months looking for is defect 2 above — forge-pay's, where the address row
carried its own high-water mark and a rotation froze crediting until somebody swept by hand. A
rotation is a new row here, so the state cannot arise. See micro-org#310.

## What is not here

* **Sending the payment.** That is `micro-settlement`. `src/settlement.ts` is the interface, and
  `wallet.withdrawal.requested` is the handover; the outbox relay computes its delivery set from
  the live subscription list on every pass.

  **This paragraph used to end "which does not exist yet" and "emitting into the void".** It is not
  true any more, and the difference matters to whoever is on call: `wallet.withdrawal.requested`
  has a live consumer, so **a withdrawal that is not paid is an incident, not the expected state.**
  Settlement builds and broadcasts on the UTXO chains from a wallet-less source — it derives
  spendable outputs itself rather than asking a node's wallet, which the estate's nodes do not run
  — and it sends the HTTP Basic `Authorization` header that `URL.origin` silently discards, which
  was the single line that made every UTXO withdrawal answer 401. LTC and BTC are payable. DOGE is
  not: it is merge-mined against Litecoin under AuxPoW and has no settlement path of its own here.

  **One gap worth naming before a user finds it: `src/addresses.ts` has no MWEB handling.** MWEB is
  live on Litecoin and a `ltcmweb1…` destination is refused by address validation, with no message
  that explains why. That is a refusal rather than a loss — the withdrawal never leaves — but the
  user is told nothing useful.
* **Watching the chain.** That is the indexer. AD-07, and the reason deposits here carry real
  transaction hashes for the first time in the estate.
* **Holding keys.** That is custody. §3.3.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
