import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// js/version.js is a classic browser script; run it in a bare context and read
// the function back out, as index.html's <script> tag exposes it.
const here = dirname(fileURLToPath(import.meta.url));
const context = {};
vm.runInNewContext(readFileSync(join(here, '..', 'js', 'version.js'), 'utf8'), context);
const { isNewerVersion } = context;

test('newer major, minor or patch reads as newer', () => {
    assert.equal(isNewerVersion('3.0.0', '2.1.0'), true);
    assert.equal(isNewerVersion('2.2.0', '2.1.9'), true);
    assert.equal(isNewerVersion('2.1.1', '2.1.0'), true);
    assert.equal(isNewerVersion('2.0.10', '2.0.9'), true);
});

test('equal or older never reads as newer', () => {
    assert.equal(isNewerVersion('2.1.0', '2.1.0'), false);
    assert.equal(isNewerVersion('2.0.4', '2.1.0'), false);
    assert.equal(isNewerVersion('1.9.9', '2.0.0'), false);
    assert.equal(isNewerVersion('2.1', '2.1.0'), false);
    assert.equal(isNewerVersion('2.1.0', '2.1'), false);
});

test('a leading v and surrounding whitespace are ignored', () => {
    assert.equal(isNewerVersion('v2.1.0', '2.0.4'), true);
    assert.equal(isNewerVersion(' 2.1.0 ', 'v2.1.0'), false);
});

test('unparseable input never raises the prompt', () => {
    assert.equal(isNewerVersion('', '2.1.0'), false);
    assert.equal(isNewerVersion('latest', '2.1.0'), false);
    assert.equal(isNewerVersion(undefined, '2.1.0'), false);
    assert.equal(isNewerVersion(null, '2.1.0'), false);
    assert.equal(isNewerVersion('2.x.0', '2.1.0'), false);
});
