/**
 * cogens/auth: sessions, handoff tokens and the operator's password sign-in.
 * Imports neither `cogens` core nor
 * `cogens/admin`; it gives the host a principal and the store takes it.
 */
export {
  clearSessionCookie,
  createSession,
  endSession,
  purgeExpiredSessions,
  readSession,
  revokeSessions,
  type NewSession,
  type RequestSource,
  type Session,
  type SessionConfig,
  type SessionRead
} from './session.ts';
export { exchangeHandoffToken, mintHandoffToken, purgeExpiredHandoffTokens, sha256Hex } from './handoff.ts';
export {
  ADMIN_KIND,
  PASSWORD_METHOD,
  passwordRoutes,
  requireAdmin,
  resolveAdmin,
  resolveAdminSession,
  type PasswordOptions
} from './password.ts';
export { createPrincipalResolver, type PrincipalOptions, type SessionSource } from './principal.ts';
