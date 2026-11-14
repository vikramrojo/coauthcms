import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

function build(...extra: string[]): string {
  const out = mkdtempSync(join(tmpdir(), 'coauthcms-editor-test-'));
  const run = Bun.spawnSync(['bun', 'run', join(root, 'scripts/build-admin-editor.ts'), out, ...extra], { cwd: root });
  if (run.exitCode !== 0) throw new Error(`build failed: ${run.stderr.toString()}`);
  return out;
}

describe('the admin editor build', () => {
  test('without a plugin module the bundle has no host syntax; with one it includes it', () => {
    const plain = build();
    const withPlugin = build('--plugins', join(root, 'test/fixtures/mention-plugin.js'));
    try {
      const a = readFileSync(join(plain, 'admin-editor.js'), 'utf8');
      const b = readFileSync(join(withPlugin, 'admin-editor.js'), 'utf8');
      expect(a).not.toContain('data-mention');
      expect(a).not.toContain('leafDirective');
      expect(b).toContain('data-mention');
      expect(b).toContain('leafDirective');
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(withPlugin, { recursive: true, force: true });
    }
  }, 120_000);

  test('a missing plugin module stops the build', () => {
    const out = mkdtempSync(join(tmpdir(), 'coauthcms-editor-test-'));
    const run = Bun.spawnSync(['bun', 'run', join(root, 'scripts/build-admin-editor.ts'), out, '--plugins', join(out, 'nope.js')], { cwd: root });
    rmSync(out, { recursive: true, force: true });
    expect(run.exitCode).not.toBe(0);
  });
});

describe('no host syntax in the package', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  }
  const names = /\b(bar|staff|excerpt|sinfon|notebook|score)s?\b/i;
  test('src, editor, scripts and the README name none of the host-specific words', () => {
    const paths = [...files(join(root, 'src')), ...files(join(root, 'editor')), ...files(join(root, 'scripts')), join(root, 'README.md')];
    const hits: string[] = [];
    for (const path of paths) {
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (names.test(line) && !/Sinfon.*(first host|origin)/i.test(line)) hits.push(`${path.slice(root.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
