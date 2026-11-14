/**
 * Type tests (task 2.1), checked by `bun run typecheck:packages`: an assertion that
 * does not hold, or a `@ts-expect-error` line that does not error, fails tsc.
 * types.test.ts loads this file, so the runtime half runs under bun test.
 */
import {
  contentType, field, type AccessContext, type ContentType, type Infer, type Principal
} from '../src/core/index.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => {};

interface Composer {
  kind: 'composer';
  ownerId: string;
}

export const score = contentType({
  id: 'score',
  name: 'Scores',
  displayField: 'title',
  owned: true,
  indexed: ['visibility'],
  fields: {
    title: field.text('Title').required(),
    composer: field.text('Composer'),
    visibility: field.select('Visibility', { options: ['public', 'link'] }).required(),
    currentRevision: field.number('Current revision').system(),
    files: field.files('Files')
  },
  access(principal: Principal<Composer>, { can }: AccessContext) {
    if (principal.kind === 'composer') can('read', { where: { owner_id: principal.ownerId } });
    // @ts-expect-error the admin has no `ownerId`: the kind narrows the principal
    if (principal.kind === 'admin') can('read', { where: { owner_id: principal.ownerId } });
  }
});

export type Score = Infer<typeof score>;

// Required fields are required and the rest optional (and may be null).
assertType<Equals<Score['title'], string>>();
assertType<Equals<Score['visibility'], 'public' | 'link'>>();
assertType<Equals<Score['composer'], string | null | undefined>>();
assertType<Equals<Score['currentRevision'], number | null | undefined>>();

export const required: Score = { title: 'x', visibility: 'link' };
// @ts-expect-error title is required
export const noTitle: Score = { visibility: 'link' };
// @ts-expect-error visibility is one of the options
export const badOption: Score = { title: 'x', visibility: 'secret' };
// @ts-expect-error title is text
export const badTitle: Score = { title: 3, visibility: 'link' };

assertType<Equals<typeof score, ContentType<typeof score.fields>>>();
export const owned: boolean = score.owned;
export const indexed: readonly string[] = score.indexed;

export const badCondition = (context: AccessContext) =>
  // @ts-expect-error the conditions are equals, in, and, or; a comparison is not one
  context.can('read', { where: { owner_id: { lt: 3 } } });
