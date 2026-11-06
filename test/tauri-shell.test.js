import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, inlineScripts, hashSource } from '../tools/csp.mjs';
import { shellPolicy, servedHtmlFiles, rewriteVendorPaths } from '../src-tauri/scripts/stage.mjs';

function directive(policy, name) {
    const d = policy.split('; ').find(x => x.startsWith(name + ' '));
    assert.ok(d, `no ${name} directive in the shell policy`);
    return d.split(' ').slice(1);
}

test('the Tauri shell policy hashes every inline script of every page it serves, as staged', () => {
    const allowed = new Set(directive(shellPolicy(ROOT), 'script-src'));
    const files = servedHtmlFiles(ROOT);
    assert.ok(files.includes('index.html'));
    assert.ok(files.some(f => f.startsWith('html/')));
    const missing = [];
    let count = 0;
    for (const file of files) {
        const staged = rewriteVendorPaths(readFileSync(join(ROOT, file), 'utf8'));
        for (const body of inlineScripts(staged)) {
            count++;
            if (!allowed.has(hashSource(body))) missing.push(file);
        }
    }
    assert.ok(count > 0, 'no inline scripts found in the served pages');
    assert.deepEqual(missing, [], 'inline scripts the shell CSP blocks: ' + missing.join(', '));
});

test('the Tauri shell policy allows no inline or eval script and no plain-http connection', () => {
    const policy = shellPolicy(ROOT);
    const scriptSrc = directive(policy, 'script-src');
    assert.ok(!scriptSrc.includes("'unsafe-inline'"));
    assert.ok(!scriptSrc.includes("'unsafe-eval'"));
    // http://ipc.localhost is Tauri's IPC channel inside the webview, not the network.
    const plain = directive(policy, 'connect-src').filter(s => /^http:/.test(s) && s !== 'http://ipc.localhost');
    assert.deepEqual(plain, []);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
});
