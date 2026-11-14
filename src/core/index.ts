/**
 * cogens: the content store. A content type declares who owns it and who may
 * create, read, update, delete and publish it; every read and write names its
 * caller (`cms.content.as(principal)`), and a read the caller may not make
 * answers as a missing row.
 *
 * Imports nothing of the host's, and nothing but `hono`, `@casl/ability` and
 * `@cfworker/json-schema` (test/boundary.test.ts). No export names a
 * type of the decision engine under `can`.
 */

export { contentType, defineConfig, group, RESERVED_FIELD_NAMES } from './config/define.ts';
export type {
  CmsConfig, ContentType, ContentTypeOptions, Fields, GroupConfig, Infer, ServiceAction, ServiceConfig
} from './config/define.ts';
export { field, FieldBuilder } from './config/field.ts';
export type { FieldMeta, FieldType, StoredFile } from './config/field.ts';

export { OPERATIONS } from './access/can.ts';
export type { AccessContext, AccessFn, Can, Grant, GrantOptions } from './access/can.ts';
export { MAX_IN_VALUES } from './access/where.ts';
export type { Scalar, Where } from './access/where.ts';
export { permits } from './access/permits.ts';
export type { PackedRules, PackedTypeRules } from './access/permits.ts';

export { admin, anonymous, system } from './principal.ts';
export type { AdminPrincipal, AnonymousPrincipal, HostPrincipal, Principal, SystemPrincipal } from './principal.ts';

export { createCms } from './store/cms.ts';
export type { Cms, CmsOptions } from './store/cms.ts';
export type {
  AfterWriteContext, Compare, ContentApi, CreateInput, Entry, ListOptions, OrderBy, Status, TypeRef, UpdateEachChange, UpdatePatch, UpdateResult,
  When, WriteContext, WriteOptions
} from './store/types.ts';

export type { Asset, MediaApi, MediaOptions, UploadInput } from './media/index.ts';

export {
  ConditionError, ConfigError, Conflict, Forbidden, TooManyChildren, TooManyEntries, ValidationError, WriteRefused
} from './errors.ts';
export type { Operation } from './errors.ts';

export { policyMatrix, PolicyMismatch } from './testing/index.ts';
export type { PolicyMatrixOptions, Expectation } from './testing/index.ts';
