/** Tasks 6.2 and 6.4: the admin's pages, as the principal the host resolved, and what protects its writes. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ADMIN_CSS, ADMIN_JS } from '../src/admin/index.ts';
import { system, type World } from './sample.ts';
import { createAdminWorld, ledger, memo, mount, ORIGIN, type Mounted } from './admin-support.ts';

let w: World;
let a: Mounted;
beforeEach(async () => {
  w = await createAdminWorld();
  a = mount(w);
});
afterEach(() => w.dispose());

const as = (principal: Parameters<World['cms']['content']['as']>[0]) => w.cms.content.as(principal);
const operator = () => as({ kind: 'admin' } as never);
const text = async (res: Response) => await res.text();
const newPage = (title = 'Hello', slug = `slug-${Math.random().toString(36).slice(2, 8)}`, body = 'Body') =>
  operator().create('page', { title, slug, body });
const newScore = (owner: string, over: Record<string, unknown> = {}) =>
  as(system('test')).create('score', { owner_id: owner, slug: `s-${Math.random().toString(36).slice(2, 8)}`, title: 'T', visibility: 'link', rights: 'original', retired: 0, ...over });

describe('the type list', () => {
  test('the operator sees every type the rules let them read', async () => {
    const res = await a.get('/');
    expect(res.status).toBe(200);
    const body = await text(res);
    for (const t of ['score', 'page', 'memo', 'ledger']) expect(body).toContain(`href="/admin2/t/${t}"`);
  });

  test('no principal is 401', async () => {
    expect((await a.get('/', null)).status).toBe(401);
    expect((await a.get('/t/page', null)).status).toBe(401);
  });

  // Where a type grants everyone read of what is published, staff and anonymous callers see it too; these two types do not.
  test('a caller who may read nothing sees an empty list', async () => {
    const world = await createAdminWorld([memo, ledger]);
    try {
      expect(await text(await mount(world).get('/', 'anon'))).toContain('nothing here you may read');
    } finally {
      await world.dispose();
    }
  });

  test('staff with narrower rules see only the type they may read', async () => {
    const world = await createAdminWorld([memo, ledger]);
    try {
      const body = await text(await mount(world).get('/', 'staff'));
      expect(body).toContain('href="/admin2/t/memo"');
      expect(body).not.toContain('href="/admin2/t/ledger"');
    } finally {
      await world.dispose();
    }
  });

  test('a type the caller may not read looks like one that does not exist', async () => {
    expect((await a.get('/t/ledger', 'staff')).status).toBe(404);
    expect((await a.get('/t/nothing')).status).toBe(404);
  });
});

describe('the entry list', () => {
  test('lists entries and links each to its page', async () => {
    const one = await newPage('First', 'first');
    await newPage('Second', 'second');
    const body = await text(await a.get('/t/page'));
    expect(body).toContain('First');
    expect(body).toContain('Second');
    expect(body).toContain(`href="/admin2/t/page/${one.id}"`);
  });

  test('searching by slug shows the entry with that slug and no others', async () => {
    await newPage('First', 'first');
    await newPage('Second', 'second');
    const body = await text(await a.get('/t/page?q=second'));
    expect(body).toContain('Second');
    expect(body).not.toContain('First');
  });

  test('filtering by status', async () => {
    const live = await newPage('Live one', 'live');
    await newPage('Waiting one', 'waiting');
    await operator().publish('page', live.id);
    const published = await text(await a.get('/t/page?status=published'));
    expect(published).toContain('Live one');
    expect(published).not.toContain('Waiting one');
    const drafts = await text(await a.get('/t/page?status=draft'));
    expect(drafts).toContain('Waiting one');
    expect(drafts).not.toContain('Live one');
  });

  test("filtering by owner shows that owner's entries and no others", async () => {
    await newScore('A', { title: 'Alpha' });
    await newScore('B', { title: 'Beta' });
    const body = await text(await a.get('/t/score?owner=A'));
    expect(body).toContain('Alpha');
    expect(body).not.toContain('Beta');
    expect(await text(await a.get('/t/score'))).toContain('Beta');
  });

  test('pages of fifty, with Next and Previous', async () => {
    for (let i = 0; i < 51; i++) await operator().create('page', { title: `P${String(i).padStart(2, '0')}`, slug: `p${i}` });
    const first = await text(await a.get('/t/page'));
    expect(first).toContain('offset=50');
    expect(first.match(/<tr>/g)?.length).toBe(51); // the header row and fifty entries
    expect(first).not.toContain('>Previous<');
    const second = await text(await a.get('/t/page?offset=50'));
    expect(second.match(/<tr>/g)?.length).toBe(2); // the header row and the fifty-first
    expect(second).toContain('>Previous<');
    expect(second).not.toContain('>Next<');
  });

  test('a type the caller may only read has no New link', async () => {
    expect(await text(await a.get('/t/ledger'))).not.toContain('/t/ledger/new');
    expect(await text(await a.get('/t/page'))).toContain('/t/page/new');
  });
});

describe('one entry', () => {
  test('shows its fields, and saving a field is a post then a 303', async () => {
    const entry = await newPage('Old', 'old-slug');
    const view = await text(await a.get(`/t/page/${entry.id}`));
    expect(view).toContain('<input id="f-title" type="text" name="title" value="Old">');
    expect(view).toContain('data-markdown');
    const res = await a.post(`/t/page/${entry.id}`, { title: 'New', body: 'Changed' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin2/t/page/${entry.id}?notice=saved`);
    expect((await operator().get('page', entry.id))?.data).toMatchObject({ title: 'New', body: 'Changed' });
    expect(await text(await a.get(`/t/page/${entry.id}?notice=saved`))).toContain('Saved.');
  });

  test('an invalid save shows the problem, keeps what was typed and changes nothing', async () => {
    const entry = await newPage('Keep');
    const res = await a.post(`/t/page/${entry.id}`, { title: '', body: 'typed' });
    expect(res.status).toBe(422);
    const body = await text(res);
    expect(body).toContain('title is required.');
    expect(body).toContain('typed');
    expect((await operator().get('page', entry.id))?.data.title).toBe('Keep');
  });

  test('a missing entry is not found', async () => {
    expect((await a.get('/t/page/nope')).status).toBe(404);
    expect((await a.post('/t/page/nope', { title: 'x' })).status).toBe(404);
  });

  test('a type the operator may only read shows every field as text and no controls', async () => {
    const row = await as(system('t')).create('ledger', { title: 'Q4', amount: 12 }).catch(() => null);
    expect(row).toBeNull(); // nobody here may create a ledger entry: seed it directly
    await w.t.db
      .prepare("INSERT INTO entries (id, content_type, status, data) VALUES ('led-1', 'ledger', 'draft', '{\"title\":\"Q4\",\"amount\":12}')")
      .run();
    const res = await a.get('/t/ledger/led-1');
    expect(res.status).toBe(200);
    const body = await text(res);
    expect(body).toContain('<span>Q4</span>');
    expect(body).toContain('<span>12</span>');
    expect(body).not.toContain('<input');
    expect(body).not.toContain('<textarea');
    expect(body).not.toContain('<form');
    for (const control of ['Save', 'Publish', 'Unpublish', 'Delete']) expect(body).not.toContain(`>${control}<`);
    expect((await a.post('/t/ledger/led-1', { title: 'Changed' })).status).toBe(403);
    expect((await a.post('/t/ledger/led-1/delete')).status).toBe(403);
    expect((await a.post('/t/ledger/led-1/publish')).status).toBe(403);
    expect(JSON.parse((await w.t.db.prepare("SELECT data FROM entries WHERE id = 'led-1'").first<{ data: string }>())!.data).title).toBe('Q4');
  });

  test('staff who may read a type see its entries read-only', async () => {
    const memo = await operator().create('memo', { title: 'Note', slug: 'note' });
    const body = await text(await a.get(`/t/memo/${memo.id}`, 'staff'));
    expect(body).toContain('<span>Note</span>');
    expect(body).not.toContain('<form');
    expect((await a.post(`/t/memo/${memo.id}`, { title: 'Mine' }, 'staff')).status).toBe(403);
    expect((await operator().get('memo', memo.id))?.data.title).toBe('Note');
  });

  test('a field the caller may not write is text, the ones they may are inputs', async () => {
    const mine = await newScore('A', { title: 'Mine' });
    const body = await text(await a.get(`/t/score/${mine.id}`, 'composer:A'));
    expect(body).toContain('<input id="f-title"');
    expect(body).toContain('<input id="f-rights"');
    expect(body).not.toContain('name="currentRevision"');
    expect(body).not.toContain('name="retired"');
    expect(body).not.toContain('name="unpublishedAt"');
    // The slug and owner are columns only a grant naming them may write.
    expect(body).not.toContain('name="slug"');
    expect(body).not.toContain('name="owner_id"');
    // The operator, who may only read a score, sees no inputs at all.
    const other = await text(await a.get(`/t/score/${mine.id}`));
    expect(other).not.toContain('<input');
  });
});

describe('a forged save', () => {
  test('a field the caller may not write is refused and nothing changes', async () => {
    const mine = await newScore('A', { title: 'Mine' });
    await as(system('t')).update('score', mine.id, { currentRevision: 1 });
    const forged = await a.post(`/t/score/${mine.id}`, { title: 'Changed', currentRevision: '9' }, 'composer:A');
    expect(forged.status).toBe(403);
    expect(await text(forged)).toContain('currentRevision');
    const after = await as(system('t')).get('score', mine.id);
    expect(after?.data).toMatchObject({ title: 'Mine', currentRevision: 1 });
    // The same post as the operator, who has no update grant on a score at all.
    expect((await a.post(`/t/score/${mine.id}`, { title: 'Changed' })).status).toBe(403);
    expect((await as(system('t')).get('score', mine.id))?.data.title).toBe('Mine');
  });

  test('so are the columns and the status a form has no input for', async () => {
    const entry = await newPage('Keep');
    for (const forged of [{ status: 'published' }, { owner_id: 'X' }, { created_at: '2020-01-01' }, { nothere: '1' }]) {
      const res = await a.post(`/t/page/${entry.id}`, { title: 'Changed', ...forged });
      expect([403, 422]).toContain(res.status);
    }
    const after = (await operator().get('page', entry.id))!;
    expect(after.status).toBe('draft');
    expect(after.data.title).toBe('Keep');
    expect(after.owner_id).toBeNull();
  });

  test("another owner's entry is not found, not forbidden", async () => {
    const theirs = await newScore('B', { title: 'Theirs' });
    expect((await a.get(`/t/score/${theirs.id}`, 'composer:A')).status).toBe(404);
    expect((await a.post(`/t/score/${theirs.id}`, { title: 'Mine now' }, 'composer:A')).status).toBe(404);
    expect((await as(system('t')).get('score', theirs.id))?.data.title).toBe('Theirs');
  });
});

describe('create', () => {
  test('a form for a new entry, and a post creates it and answers 303', async () => {
    const form = await text(await a.get('/t/page/new'));
    expect(form).toContain('name="title"');
    expect(form).toContain('name="slug"');
    const res = await a.post('/t/page', { title: 'Fresh', slug: 'fresh', body: '' });
    expect(res.status).toBe(303);
    const created = await operator().getBySlug('page', 'fresh').catch(() => null);
    expect(res.headers.get('location')).toMatch(/^\/admin2\/t\/page\/.+\?notice=created$/);
    expect(created === null || created.data.title === 'Fresh').toBe(true);
    const listed = (await operator().list('page')).find(e => e.slug === 'fresh');
    expect(listed?.data.title).toBe('Fresh');
  });

  test('a missing required field is shown as a problem and nothing is created', async () => {
    const res = await a.post('/t/page', { title: '', slug: 'empty' });
    expect(res.status).toBe(422);
    expect(await text(res)).toContain('title is required.');
    expect(await operator().list('page')).toHaveLength(0);
  });

  test('a slug already taken is a conflict', async () => {
    await newPage('One', 'same');
    const res = await a.post('/t/page', { title: 'Two', slug: 'same' });
    expect(res.status).toBe(409);
    expect(await operator().list('page')).toHaveLength(1);
  });

  test('where the caller may not create there is no form and no create', async () => {
    expect((await a.get('/t/ledger/new')).status).toBe(404);
    expect((await a.post('/t/ledger', { title: 'x' })).status).toBe(403);
    expect((await a.get('/t/memo/new', 'staff')).status).toBe(404);
    expect((await a.post('/t/memo', { title: 'x' }, 'staff')).status).toBe(403);
  });
});

describe('publish and unpublish', () => {
  test('are posts that answer 303 and change the status', async () => {
    const entry = await newPage('Pub', 'pub');
    expect(await text(await a.get(`/t/page/${entry.id}`))).toContain('>Publish<');
    const res = await a.post(`/t/page/${entry.id}/publish`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin2/t/page/${entry.id}?notice=published`);
    expect((await operator().get('page', entry.id))?.status).toBe('published');
    expect(await text(await a.get(`/t/page/${entry.id}`))).toContain('>Unpublish<');
    expect((await a.post(`/t/page/${entry.id}/unpublish`)).status).toBe(303);
    expect((await operator().get('page', entry.id))?.status).toBe('draft');
  });

  test('staff who may only read are refused', async () => {
    const memo = await operator().create('memo', { title: 'Note', slug: 'note' });
    expect((await a.post(`/t/memo/${memo.id}/publish`, {}, 'staff')).status).toBe(403);
    expect((await operator().get('memo', memo.id))?.status).toBe('draft');
  });
});

describe('delete', () => {
  test('asks first, and a GET changes nothing', async () => {
    const entry = await newPage('Doomed', 'doomed');
    const res = await a.get(`/t/page/${entry.id}/delete`);
    expect(res.status).toBe(200);
    const body = await text(res);
    expect(body).toContain('Delete “Doomed”?');
    expect(body).toContain(`<form method="post" action="/admin2/t/page/${entry.id}/delete"`);
    expect(await operator().get('page', entry.id)).not.toBeNull();
  });

  test('the post deletes and answers 303 to the list', async () => {
    const entry = await newPage('Doomed', 'doomed');
    const res = await a.post(`/t/page/${entry.id}/delete`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin2/t/page?notice=deleted');
    expect(await operator().get('page', entry.id)).toBeNull();
  });

  test('is not offered, or refused, where the rules give no delete', async () => {
    const memo = await operator().create('memo', { title: 'Note', slug: 'note' });
    expect((await a.get(`/t/memo/${memo.id}/delete`, 'staff')).status).toBe(404);
    expect((await a.post(`/t/memo/${memo.id}/delete`, {}, 'staff')).status).toBe(403);
    const mine = await newScore('A');
    // A composer may delete their own score.
    expect((await a.get(`/t/score/${mine.id}/delete`, 'composer:A')).status).toBe(200);
    expect((await a.post(`/t/score/${mine.id}/delete`, {}, 'composer:B')).status).toBe(404);
    expect(await as(system('t')).get('score', mine.id)).not.toBeNull();
  });
});

describe('writes are protected (task 6.4)', () => {
  test('a post from another site is refused and nothing changes', async () => {
    const entry = await newPage('Safe', 'safe');
    for (const headers of [{ origin: 'https://evil.test' }, { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
      const res = await a.post(`/t/page/${entry.id}/delete`, {}, 'admin', headers);
      expect(res.status).toBe(403);
    }
    expect(await operator().get('page', entry.id)).not.toBeNull();
  });

  test('a form post with no origin at all is refused', async () => {
    const entry = await newPage('Safe', 'safe');
    const res = await a.host.request(`${ORIGIN}/admin2/t/page/${entry.id}/delete`, {
      method: 'POST',
      headers: { 'x-principal': 'admin', 'content-type': 'application/x-www-form-urlencoded' },
      body: ''
    });
    expect(res.status).toBe(403);
    expect(await operator().get('page', entry.id)).not.toBeNull();
  });

  test('a post that is not a form is refused, whoever sends it, so a bare fetch cannot pass for no form', async () => {
    const entry = await newPage('Safe', 'safe');
    for (const headers of [{}, { 'content-type': 'application/json' }, { 'content-type': 'application/json', origin: ORIGIN }]) {
      const res = await a.host.request(`${ORIGIN}/admin2/t/page/${entry.id}/delete`, {
        method: 'POST',
        headers: { 'x-principal': 'admin', ...headers },
        body: '{}'
      });
      expect(res.status).toBe(415);
    }
    expect(await operator().get('page', entry.id)).not.toBeNull();
  });

  test('a same-origin post is accepted, by Origin or by Sec-Fetch-Site', async () => {
    const one = await newPage('One', 'one');
    const two = await newPage('Two', 'two');
    expect((await a.post(`/t/page/${one.id}/delete`)).status).toBe(303);
    expect((await a.post(`/t/page/${two.id}/delete`, {}, 'admin', { origin: '', 'sec-fetch-site': 'same-origin' })).status).toBe(303);
  });

  const everyPage = async () => {
    const entry = await newPage('Page', 'page-1');
    const memo = await operator().create('memo', { title: 'M', slug: 'm' });
    return [
      '/', '/t/page', '/t/page/new', `/t/page/${entry.id}`, `/t/page/${entry.id}/delete`, `/t/memo/${memo.id}`, '/t/nothing', '/x/none',
      `/t/page/${entry.id}?notice=saved`
    ];
  };

  test('every page carries a content security policy naming only the admin script, the editor and the stylesheets', async () => {
    for (const path of await everyPage()) {
      const res = await a.get(path);
      const csp = res.headers.get('content-security-policy');
      expect(csp, path).toBeTruthy();
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).toContain(`script-src ${ORIGIN}/admin2/assets/admin.js ${ORIGIN}/admin-editor.js;`);
      expect(csp, path).toContain(`style-src ${ORIGIN}/largen.css ${ORIGIN}/largen-theme-dark.css ${ORIGIN}/admin2/assets/admin.css`);
      expect(csp, path).not.toContain('unsafe-inline');
      expect(csp, path).not.toContain('unsafe-eval');
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("base-uri 'none'");
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('cache-control'), path).toBe('private, no-store');
    }
  });

  test('so do the refusals', async () => {
    for (const res of [await a.get('/', null), await a.post('/t/page', {}, 'admin', { origin: 'https://evil.test' })]) {
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
  });

  test('a script element in a markdown field is shown as text and runs nothing', async () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const entry = await newPage('T', 'hostile', hostile);
    const edit = await text(await a.get(`/t/page/${entry.id}`));
    expect(edit).not.toContain(hostile);
    expect(edit).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The title and the slug too.
    const titled = await operator().create('page', { title: hostile, slug: 'x2' });
    for (const path of [`/t/page/${titled.id}`, '/t/page']) {
      const body = await text(await a.get(path));
      expect(body).not.toContain('<script>alert');
      expect(body).not.toContain('<img src=x');
    }
    // The read-only form too.
    const memo = await operator().create('memo', { title: 'M', slug: 'mm', body: hostile });
    const readOnly = await text(await a.get(`/t/memo/${memo.id}`, 'staff'));
    expect(readOnly).toContain('<pre>');
    expect(readOnly).not.toContain('<script>alert');
  });

  test('the only script is the admin one, and the editor is named only where there is a markdown field to edit', async () => {
    const entry = await newPage('T', 't1');
    const withEditor = await text(await a.get(`/t/page/${entry.id}`));
    expect(withEditor.match(/<script/g)?.length).toBe(1);
    expect(withEditor).toContain('<script defer src="/admin2/assets/admin.js" data-editor="/admin-editor.js"></script>');
    expect(withEditor).toContain('href="/admin-editor.css"');
    const without = await text(await a.get('/t/page'));
    expect(without.match(/<script/g)?.length).toBe(1);
    expect(without).not.toContain('data-editor');
    expect(without).not.toContain('admin-editor');
    // A page that only reads a markdown field does not load the editor either.
    const memo = await operator().create('memo', { title: 'M', slug: 'm9', body: 'x' });
    expect(await text(await a.get(`/t/memo/${memo.id}`, 'staff'))).not.toContain('data-editor');
    // No inline script or style anywhere.
    for (const html of [withEditor, without]) {
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(html).not.toContain('<style');
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toMatch(/\son[a-z]+=/);
    }
  });
});

describe("the admin's own files", () => {
  test('are served without a sign-in, and the script is under 5 KB', async () => {
    const js = await a.get('/assets/admin.js', null);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await js.text()).toBe(ADMIN_JS);
    const css = await a.get('/assets/admin.css', null);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toBe(ADMIN_CSS);
    expect(new TextEncoder().encode(ADMIN_JS).length).toBeLessThan(5 * 1024);
    console.log(`admin.js is ${new TextEncoder().encode(ADMIN_JS).length} bytes, admin.css ${new TextEncoder().encode(ADMIN_CSS).length}`);
  });

  test('the style is only the form layout, in the components layer', () => {
    expect(ADMIN_CSS.startsWith('@layer largen.components {')).toBe(true);
    expect(ADMIN_CSS).not.toMatch(/\bcolor\s*:|background/);
  });
});
