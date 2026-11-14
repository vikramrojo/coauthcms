/**
 * Handoff tokens: a session started somewhere else (an app, an email) given to a
 * browser. Only the SHA-256 of a token is stored; an exchange deletes the row
 * with `DELETE ... RETURNING`, so a token starts one session at most, even when
 * two requests arrive together.
 */
import type { Context } from 'hono';
import { clock, createSession, randomToken, type Session, type SessionConfig } from './session.ts';

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Mints a token for an owner. The raw token is returned here and never again. */
export async function mintHandoffToken(
  db: D1Database,
  init: { ownerId: string; lifetimeSeconds: number; now?: () => number }
): Promise<{ token: string; expiresAt: number }> {
  if (!init.ownerId) throw new TypeError('A handoff token is for an owner.');
  if (!(init.lifetimeSeconds > 0)) throw new TypeError('A handoff token needs a positive lifetime.');
  const token = randomToken();
  const expiresAt = clock(init) + init.lifetimeSeconds * 1000;
  await db
    .prepare('INSERT INTO handoff_tokens (token_hash, owner_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), init.ownerId, expiresAt)
    .run();
  return { token, expiresAt };
}

/** Deletes the tokens past their lifetime that were never exchanged. Returns how many. */
export async function purgeExpiredHandoffTokens(db: D1Database, now: number = Date.now()): Promise<number> {
  const result = await db.prepare('DELETE FROM handoff_tokens WHERE expires_at <= ?').bind(now).run();
  return result.meta?.changes ?? 0;
}

/**
 * Exchanges a token for a session of `kind`, method `handoff`. Null when the
 * token is unknown, already used, or past its lifetime (an expired one is
 * consumed too).
 */
export async function exchangeHandoffToken(
  c: Context,
  db: D1Database,
  config: SessionConfig,
  token: string,
  kind: string
): Promise<Session | null> {
  if (typeof token !== 'string' || token === '') return null;
  const row = await db
    .prepare('DELETE FROM handoff_tokens WHERE token_hash = ? RETURNING owner_id, expires_at')
    .bind(await sha256Hex(token))
    .first<{ owner_id: string; expires_at: number }>();
  if (!row || row.expires_at <= clock(config)) return null;
  return createSession(c, db, config, { ownerId: row.owner_id, kind, method: 'handoff' });
}
