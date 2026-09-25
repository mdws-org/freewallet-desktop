import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The wallet checks live in tools/*.cjs as standalone scripts (each prints its
// checks and exits non-zero on the first failure). Running them from here puts
// them under `npm test`, which is what CI runs. The wiring script derives many
// PBKDF2 keys at the shipped iteration count, so it takes a few minutes.
const here = dirname(fileURLToPath(import.meta.url));
const scripts = ['test-sanitization.cjs', 'test-wallet-crypto.cjs', 'test-wallet-wiring.cjs'];

for (const script of scripts) {
    test(`tools/${script}`, { timeout: 15 * 60 * 1000 }, () => {
        let out;
        try {
            out = execFileSync(process.execPath, [join(here, '..', 'tools', script)], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 14 * 60 * 1000, // a hung script is killed, not waited on
            });
        } catch (e) {
            // The script's own output is where the failing check is named.
            assert.fail(`${script} exited ${e.status ?? e.signal}\n${e.stdout ?? ''}${e.stderr ?? ''}`);
        }
        const m = out.match(/(\d+) checks passed/);
        assert.ok(m, `${script} did not report its check count:\n${out}`);
        assert.ok(Number(m[1]) > 0, `${script} ran no checks`);
    });
}
