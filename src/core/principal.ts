/**
 * The caller. The host decides who is calling and passes a principal; the store
 * never reads a cookie or a header. Three kinds are built in, and a host adds
 * its own through the type parameter, with whatever claims its rules use.
 */

export interface HostPrincipal {
  readonly kind: string;
}

export interface AdminPrincipal {
  readonly kind: 'admin';
  /** The operator's id, for the host's own records; the store gives it no meaning. */
  readonly id?: string;
}

/** Background work, naming its job. */
export interface SystemPrincipal {
  readonly kind: 'system';
  readonly job: string;
}

export interface AnonymousPrincipal {
  readonly kind: 'anonymous';
}

export type Principal<H extends HostPrincipal = never> = AdminPrincipal | SystemPrincipal | AnonymousPrincipal | H;

export const anonymous: AnonymousPrincipal = Object.freeze({ kind: 'anonymous' });

export function admin(id?: string): AdminPrincipal {
  return Object.freeze(id === undefined ? { kind: 'admin' as const } : { kind: 'admin' as const, id });
}

export function system(job: string): SystemPrincipal {
  if (typeof job !== 'string' || job.trim() === '') throw new TypeError('A system principal must name its job.');
  return Object.freeze({ kind: 'system' as const, job });
}

/** Checks the shape of a principal a host built, so a typo is an error and not an anonymous caller. */
export function assertPrincipal(principal: unknown): asserts principal is HostPrincipal {
  if (typeof principal !== 'object' || principal === null || typeof (principal as HostPrincipal).kind !== 'string') {
    throw new TypeError('A principal is an object with a `kind`.');
  }
  const p = principal as { kind: string; job?: unknown };
  if (p.kind === 'system' && (typeof p.job !== 'string' || p.job.trim() === '')) {
    throw new TypeError('A system principal must name its job.');
  }
}
