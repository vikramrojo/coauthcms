/** Task 6.1: the nine field renderers, each in its form and its read-only form, with markup in a value escaped. */
import { describe, expect, test } from 'bun:test';
import { field, type FieldBuilder } from '../src/core/index.ts';
import { KIND, RENDERERS, renderField, type Kind, type ResolveRef } from '../src/admin/index.ts';

const refs: ResolveRef = (type, id) => ({ href: `/admin2/t/${type}/${id}`, label: `Name of ${id}` });
const noLink: ResolveRef = (_type, id) => ({ href: null, label: id });
const SCRIPT = '<script>alert("x")</script>';
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

const draw = async (builder: FieldBuilder<any, any>, value: unknown, mode: 'edit' | 'read', resolve = refs) =>
  String(await renderField({ name: 'f', meta: builder.meta, value, refs: resolve }, mode));

test('a markdown field drawn with its type carries data-type and data-field for the editor plugin', async () => {
  const out = String(await renderField({ name: 'body', type: 'note', meta: field.markdown('M').meta, value: 'x', refs: () => ({ href: '', label: '' }) }, 'edit'));
  expect(out).toBe('<textarea id="f-body" name="body" rows="14" data-markdown data-type="note" data-field="body">\nx</textarea>');
});

describe('text', () => {
  test('edit and read', async () => {
    expect(await draw(field.text('T'), 'Hello', 'edit')).toBe('<input id="f-f" type="text" name="f" value="Hello">');
    expect(await draw(field.text('T'), 'Hello', 'read')).toBe('<span>Hello</span>');
  });
  test('markup in the value is escaped in both forms', async () => {
    expect(await draw(field.text('T'), SCRIPT, 'edit')).toBe(`<input id="f-f" type="text" name="f" value="${ESCAPED}">`);
    expect(await draw(field.text('T'), SCRIPT, 'read')).toBe(`<span>${ESCAPED}</span>`);
  });
  test('a value that closes the attribute stays in it', async () => {
    expect(await draw(field.text('T'), '"><img src=x onerror=alert(1)>', 'edit')).toBe(
      '<input id="f-f" type="text" name="f" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">'
    );
  });
  test('long text, email and url keep their kind', async () => {
    expect(await draw(field.longText('T'), 'a\nb', 'edit')).toBe('<textarea id="f-f" name="f" rows="6">\na\nb</textarea>');
    expect(await draw(field.email('E'), 'a@b.test', 'edit')).toBe('<input id="f-f" type="email" name="f" value="a@b.test">');
    expect(await draw(field.url('U'), 'https://a.test/?a=1&b=2', 'edit')).toBe('<input id="f-f" type="url" name="f" value="https://a.test/?a=1&amp;b=2">');
    expect(await draw(field.url('U'), 'https://a.test/?a=1&b=2', 'read')).toBe(
      '<a href="https://a.test/?a=1&amp;b=2">https://a.test/?a=1&amp;b=2</a>'
    );
  });
  test('a url that could run script is shown as text, not a link', async () => {
    expect(await draw(field.url('U'), 'javascript:alert(1)', 'read')).toBe('<span>javascript:alert(1)</span>');
  });
  test('an empty value reads as a dash', async () => {
    expect(await draw(field.text('T'), null, 'read')).toContain('—');
  });
});

describe('number', () => {
  test('edit and read', async () => {
    expect(await draw(field.number('N'), 4.5, 'edit')).toBe('<input id="f-f" type="number" step="any" name="f" value="4.5">');
    expect(await draw(field.number('N'), 4.5, 'read')).toBe('<span>4.5</span>');
    expect(await draw(field.number('N'), 0, 'read')).toBe('<span>0</span>');
  });
});

describe('boolean', () => {
  test('edit is a select, so an unset value can be told from a false one', async () => {
    expect(await draw(field.boolean('B'), true, 'edit')).toBe(
      '<select id="f-f" name="f"><option value="">—</option><option value="true" selected>Yes</option><option value="false">No</option></select>'
    );
    expect(await draw(field.boolean('B').required(), false, 'edit')).toBe(
      '<select id="f-f" name="f"><option value="true">Yes</option><option value="false" selected>No</option></select>'
    );
  });
  test('read', async () => {
    expect(await draw(field.boolean('B'), true, 'read')).toBe('<span>Yes</span>');
    expect(await draw(field.boolean('B'), false, 'read')).toBe('<span>No</span>');
  });
});

describe('date', () => {
  test('edit and read', async () => {
    expect(await draw(field.date('D'), '2026-11-14T09:30:00Z', 'edit')).toBe(
      '<input id="f-f" type="text" name="f" value="2026-11-14T09:30:00Z" placeholder="2026-11-14T09:30:00Z" autocomplete="off">'
    );
    expect(await draw(field.date('D'), '2026-11-14T09:30:00Z', 'read')).toBe(
      '<time datetime="2026-11-14T09:30:00Z">2026-11-14T09:30:00Z</time>'
    );
  });
  test('markup in the value is escaped', async () => {
    expect(await draw(field.date('D'), SCRIPT, 'read')).toBe(`<time datetime="${ESCAPED}">${ESCAPED}</time>`);
  });
});

describe('select', () => {
  const s = field.select('S', { options: ['a', 'b"c'] });
  test('edit lists the options with the value chosen', async () => {
    expect(await draw(s, 'a', 'edit')).toBe(
      '<select id="f-f" name="f"><option value="">—</option><option value="a" selected>a</option><option value="b&quot;c">b&quot;c</option></select>'
    );
  });
  test('read', async () => {
    expect(await draw(s, 'a', 'read')).toBe('<span>a</span>');
  });
});

describe('reference', () => {
  test('one id: a text box, and a link named for the entry', async () => {
    expect(await draw(field.ref('score', 'R'), 'id-1', 'edit')).toBe('<input id="f-f" type="text" name="f" value="id-1">');
    expect(await draw(field.ref('score', 'R'), 'id-1', 'read')).toBe('<a href="/admin2/t/score/id-1">Name of id-1</a>');
  });
  test('an entry the caller cannot open is named but not linked', async () => {
    expect(await draw(field.ref('score', 'R'), 'id-1', 'read', noLink)).toBe('<span>id-1</span>');
  });
  test('a list: one id a line, and a list of links', async () => {
    expect(await draw(field.refs('score', 'R'), ['id-1', 'id-2'], 'edit')).toBe(
      '<textarea id="f-f" name="f" rows="3" placeholder="One id per line">\nid-1\nid-2</textarea>'
    );
    expect(await draw(field.refs('score', 'R'), ['id-1', 'id-2'], 'read')).toBe(
      '<ul class="stack"><li><a href="/admin2/t/score/id-1">Name of id-1</a></li><li><a href="/admin2/t/score/id-2">Name of id-2</a></li></ul>'
    );
  });
  test('a label with markup is escaped', async () => {
    const label: ResolveRef = () => ({ href: '/x', label: SCRIPT });
    expect(await draw(field.ref('score', 'R'), 'id-1', 'read', label)).toBe(`<a href="/x">${ESCAPED}</a>`);
  });
});

describe('markdown', () => {
  test('edit is a text area the editor can take over; read is escaped text, never markup', async () => {
    expect(await draw(field.markdown('M'), `# Hi\n${SCRIPT}`, 'edit')).toBe(`<textarea id="f-f" name="f" rows="14" data-markdown data-field="f">\n# Hi\n${ESCAPED}</textarea>`);
    expect(await draw(field.markdown('M'), `# Hi\n${SCRIPT}`, 'read')).toBe(`<pre>\n# Hi\n${ESCAPED}</pre>`);
  });
  test('a text area closing in the value cannot end the field early', async () => {
    expect(await draw(field.markdown('M'), '</textarea><b>x</b>', 'edit')).toBe(
      '<textarea id="f-f" name="f" rows="14" data-markdown data-field="f">\n&lt;/textarea&gt;&lt;b&gt;x&lt;/b&gt;</textarea>'
    );
  });
});

describe('files', () => {
  const files = [
    { name: 'a<b>.ly', size: 2048, url: '/f/a.ly' },
    { name: 'x', size: 3, url: 'javascript:1' }
  ];
  const expected =
    '<ul class="stack"><li><a href="/f/a.ly" download="a&lt;b&gt;.ly">a&lt;b&gt;.ly</a> <small>2.0 KB</small></li><li>x <small>3 B</small></li></ul>';
  test('a list of links to the stored files, in the one form: they are never edited', async () => {
    expect(await draw(field.files('F'), files, 'read')).toBe(expected);
    expect(await draw(field.files('F'), files, 'edit')).toBe(expected);
  });
  test('none stored', async () => {
    expect(await draw(field.files('F'), [], 'read')).toContain('No files stored.');
  });
});

describe('json', () => {
  test('edit and read show the value as formatted text, escaped', async () => {
    const value = { a: SCRIPT };
    const text = `{\n  &quot;a&quot;: &quot;&lt;script&gt;alert(\\&quot;x\\&quot;)&lt;/script&gt;&quot;\n}`;
    expect(await draw(field.json('J'), value, 'edit')).toBe(`<textarea id="f-f" name="f" rows="8" spellcheck="false">\n${text}</textarea>`);
    expect(await draw(field.json('J'), value, 'read')).toBe(`<pre><code>\n${text}</code></pre>`);
  });
});

describe('the renderer table', () => {
  test('every field type has one of the nine renderers', () => {
    expect(Object.keys(RENDERERS).sort()).toEqual(['boolean', 'date', 'files', 'json', 'markdown', 'number', 'reference', 'select', 'text']);
    for (const kind of Object.values(KIND) as Kind[]) expect(RENDERERS[kind]).toBeDefined();
    expect(Object.keys(KIND).sort()).toEqual(
      ['boolean', 'date', 'email', 'files', 'json', 'longText', 'markdown', 'number', 'reference', 'references', 'select', 'text', 'url']
    );
  });
});
