/**
 * `resolvePrincipal`: the one function a host calls to learn who a request is.
 * An admin session gives `{ kind: 'admin' }`; a session of another kind goes
 * through the host's own mapping; anything else is null (the host then decides
 * anonymous or a 401). The package never learns what an owner is.
 */
import { resolveAdminSession, ADMIN_KIND, type PasswordOptions } from './password.ts';
import { readSession, type RequestSource, type Session, type SessionConfig } from './session.ts';

export interface SessionSource<P extends { kind: string }> {
  /** The cookie and key for this kind of session, from the env; undefined when unconfigured. */
  config(env: Record<string, unknown>): SessionConfig | undefined;
  /** The host's principal for a session of this source, or null to refuse it. */
  principal(session: Session, env: Record<string, unknown>): P | null | Promise<P | null>;
}

export interface PrincipalOptions<P extends { kind: string }> {
  admin?: PasswordOptions;
  sessions?: SessionSource<P>[];
  /** The D1 binding's name (default `DB`). */
  dbName?: string;
}

export function createPrincipalResolver<P extends { kind: string } = never>(options: PrincipalOptions<P> = {}) {
  return async function resolvePrincipal(request: Request, env: Record<string, unknown>): Promise<{ kind: 'admin' } | P | null> {
    const source: RequestSource = { req: { raw: request } };
    const admin = await resolveAdminSession(source, env, options.admin ?? {});
    if (admin.session) return { kind: ADMIN_KIND };
    const db = env[options.dbName ?? options.admin?.envNames?.db ?? 'DB'] as D1Database | undefined;
    for (const candidate of options.sessions ?? []) {
      const config = candidate.config(env);
      if (!config) continue;
      const read = await readSession(source, db, config);
      if (!read.session || read.session.kind === ADMIN_KIND) continue;
      const principal = await candidate.principal(read.session, env);
      if (principal) return principal;
    }
    return null;
  };
}
