/**
 * Cached sign-in for an offline till (client change request, 2026-08-02).
 *
 * A reload during an outage was already survivable — `pt-session` keeps the
 * verified session for the shift. What was not survivable is a *cold* sign-in:
 * the shop opens, the line is down, `login()` posts to `/auth/login`, and the
 * cashier cannot get into the till at all. The offline-first POS was unusable
 * in exactly the situation it exists for.
 *
 * So a successful online sign-in leaves a password *verifier* on the device —
 * PBKDF2-HMAC-SHA256 over the password with a per-device random salt. It is a
 * one-way hash of the same shape the server stores, never the password itself,
 * and it can only ever answer "does this password match the last one that the
 * server accepted here?".
 *
 * The trade-offs, stated plainly because they are real:
 *  - A stolen till gives an attacker an offline-crackable hash. Hence a high
 *    iteration count, a per-record salt, and attempt lockout.
 *  - A password changed (or an account disabled) on the server is not known to
 *    a till that cannot reach the server. The verifier therefore expires after
 *    OFFLINE_TTL_MS and is rewritten on every online sign-in. An offline
 *    session grants local till operation only: nothing it produces reaches the
 *    database until a genuine online session posts it, where the server
 *    re-checks the user, the role and the branch.
 *  - Only the last user to sign in online on this device can sign in offline.
 */
import type { AuthUser } from '@pharmatrack/shared';
import { db } from './offline';

/** OWASP Password Storage (2023) for PBKDF2-HMAC-SHA256. ~0.3–1 s on a till. */
const ITERATIONS = 600_000;
const KEY_BITS = 256;

/** How long a device may keep letting someone in without the server. */
export const OFFLINE_TTL_MS = 7 * 24 * 3600_000;

/** Slow down guessing against a stolen device. */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

export interface OfflineCredential {
  /** Lower-cased username — the primary key. */
  username: string;
  salt: string;
  iterations: number;
  verifier: string;
  user: AuthUser;
  cachedAt: string;
  failures: number;
  lockedUntil: string | null;
}

/**
 * PBKDF2 lives in `crypto.subtle`, which browsers only expose in a secure
 * context. Rather than silently downgrade to a weak hash, offline sign-in is
 * simply unavailable over plain HTTP — the deployed app is HTTPS (ADR-009).
 */
export function offlineLoginSupported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return b64(bits);
}

/** Length-independent, non-short-circuiting compare. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const norm = (username: string) => username.trim().toLowerCase();

/**
 * Record (or refresh) the verifier after the server has accepted this password.
 * Only ever called on a real online sign-in, so the cache cannot drift from
 * what the server believes for longer than the TTL.
 */
export async function rememberCredential(
  username: string,
  password: string,
  user: AuthUser,
): Promise<void> {
  if (!offlineLoginSupported()) return;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const verifier = await derive(password, salt, ITERATIONS);
  // One device, one cached user: a till is a shared machine and stale verifiers
  // for people who no longer work here are exactly what we do not want lying
  // around. The current signer-in replaces whoever was there before.
  await db.offlineAuth.clear();
  await db.offlineAuth.put({
    username: norm(username),
    salt: b64(salt.buffer as ArrayBuffer),
    iterations: ITERATIONS,
    verifier,
    user,
    cachedAt: new Date().toISOString(),
    failures: 0,
    lockedUntil: null,
  });
}

export type OfflineLoginResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'unsupported' | 'none' | 'expired' | 'locked' | 'mismatch'; message: string };

/**
 * Verify a password against the cached verifier. Never consulted while the
 * server is reachable — a live `/auth/login` is always the source of truth.
 */
export async function verifyOffline(username: string, password: string): Promise<OfflineLoginResult> {
  if (!offlineLoginSupported()) {
    return { ok: false, reason: 'unsupported', message: 'Offline sign-in needs a secure (HTTPS) connection' };
  }

  const rec = await db.offlineAuth.get(norm(username));
  if (!rec) {
    return {
      ok: false,
      reason: 'none',
      message: 'No offline sign-in saved for this user on this till — connect to the network once first',
    };
  }

  if (rec.lockedUntil && Date.now() < Date.parse(rec.lockedUntil)) {
    const mins = Math.ceil((Date.parse(rec.lockedUntil) - Date.now()) / 60_000);
    return { ok: false, reason: 'locked', message: `Too many attempts — try again in ${mins} min` };
  }

  if (Date.now() - Date.parse(rec.cachedAt) > OFFLINE_TTL_MS) {
    await db.offlineAuth.delete(rec.username);
    return {
      ok: false,
      reason: 'expired',
      message: 'Offline sign-in for this till has expired — it must be renewed online',
    };
  }

  const attempt = await derive(password, unb64(rec.salt), rec.iterations);
  if (!constantTimeEqual(attempt, rec.verifier)) {
    const failures = rec.failures + 1;
    await db.offlineAuth.update(rec.username, {
      failures,
      lockedUntil:
        failures >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MS).toISOString() : rec.lockedUntil,
    });
    return { ok: false, reason: 'mismatch', message: 'Wrong username or password' };
  }

  await db.offlineAuth.update(rec.username, { failures: 0, lockedUntil: null });
  return { ok: true, user: rec.user };
}

/** Is a cold offline sign-in possible on this device at all? Drives the UI hint. */
export async function hasOfflineCredential(): Promise<boolean> {
  if (!offlineLoginSupported()) return false;
  const rec = await db.offlineAuth.toCollection().first();
  return !!rec && Date.now() - Date.parse(rec.cachedAt) <= OFFLINE_TTL_MS;
}

/** "Forget this till" — an explicit revocation, offered in Settings. */
export async function forgetOfflineCredentials(): Promise<void> {
  await db.offlineAuth.clear();
}
