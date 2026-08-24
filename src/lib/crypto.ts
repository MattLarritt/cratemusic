import { randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Password hashing and opaque session tokens.
 *
 * argon2id with the same parameters gatekeeper uses, so the two apps on this
 * estate cost an attacker the same per guess and there is one number to revisit
 * rather than two.
 */
const ARGON = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hash(password: string): Promise<string> {
  return argon2.hash(password, ARGON);
}

export async function verify(stored: string, supplied: string): Promise<boolean> {
  try {
    return await argon2.verify(stored, supplied);
  } catch {
    // A malformed hash must read as "wrong password", not throw. Otherwise a
    // corrupt row turns a failed login into a 500 and leaks that the row exists.
    return false;
  }
}

/**
 * A hash of a password nobody has.
 *
 * Verified against when the username does not exist, so a missing account costs
 * the same time as a wrong password and the response cannot be used to enumerate
 * who has an account.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$WlNHNqfDpS8j0Ok8YtWQY0LWWiOZLnAr2y4c0MMMzXo';

/**
 * Session tokens are opaque random strings, looked up server-side.
 *
 * Deliberately not signed self-describing values: a row in the database can be
 * revoked, and the whole table can be emptied to log everyone out, neither of
 * which is possible when the token itself carries the identity.
 */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time compare for tokens, length checked first. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so that has to be checked
  // first — and a length difference is not a secret worth protecting.
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
