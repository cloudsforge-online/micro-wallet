/**
 * UUIDv7.
 *
 * 04-domain-model.md §0: "All ids are UUIDv7 (time-ordered, so they index well and sort
 * chronologically)". Both halves matter here:
 *
 *   * **They index well.** A v4 primary key is random, so every insert lands in a different B-tree
 *     leaf and the index write set is the whole index. `deposit_credits` and `withdrawals` are
 *     append-mostly and never pruned, so a random key means their indexes never stop fragmenting.
 *   * **They sort chronologically.** `order by id` is `order by time`, which is what makes keyset
 *     pagination a total order with no tie-break ambiguity. The current wallet returns the entire
 *     unpaginated ledger on every call; the replacement pages, and paging needs a stable order.
 *
 * Postgres' `gen_random_uuid()` is v4, which is why ids are generated here and passed in rather
 * than defaulted in the DDL.
 */

import { randomBytes } from 'node:crypto'

let lastMillis = -1
let sequence = 0

/**
 * A UUIDv7: 48 bits of Unix milliseconds, 4 bits of version, 12 bits of sequence, 2 bits of
 * variant, 62 bits of randomness.
 *
 * The 12-bit sequence counter is what makes ids generated inside one millisecond still sort in
 * creation order. Without it two rows written in the same millisecond order randomly, and a page
 * boundary that falls between them would skip one and repeat the other.
 */
export function uuidv7(now: () => number = Date.now): string {
  const millis = now()

  if (millis === lastMillis) {
    sequence += 1
    // 12 bits. Exhausting it inside one millisecond would mean 4096 rows in that millisecond;
    // rolling into the next millisecond keeps the ordering guarantee instead of silently wrapping
    // the counter back behind ids already issued.
    if (sequence > 0xfff) {
      lastMillis = millis + 1
      sequence = 0
    }
  } else {
    // Never go backwards, even if the wall clock does. A clock stepped back by NTP must not
    // produce ids that sort before rows already written.
    lastMillis = millis > lastMillis ? millis : lastMillis + 1
    sequence = 0
  }

  const timestamp = lastMillis
  const bytes = randomBytes(16)

  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff
  bytes[5] = timestamp & 0xff

  // Version 7 in the high nibble of byte 6, sequence in the remaining 12 bits.
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f)
  bytes[7] = sequence & 0xff

  // RFC 4122 variant: the two high bits of byte 8 are '10'.
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Is this a UUID at all?
 *
 * Checked before a value reaches a query. Postgres rejects a malformed uuid with a 22P02 that
 * surfaces as a 500, and a caller that sent a typo deserves a 400 that says so.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
