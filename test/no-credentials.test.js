import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test('source never touches credentials or the Anthropic API', () => {
  const banned = ['api.anthropic.com', '.credentials.json', 'CLAUDE_CODE_OAUTH_TOKEN', 'keychain'];
  for (const f of [...files(path.join(root, 'src')), ...files(path.join(root, 'bin'))]) {
    const text = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const b of banned) assert.ok(!text.includes(b.toLowerCase()), `${f} contains ${b}`);
  }
});
