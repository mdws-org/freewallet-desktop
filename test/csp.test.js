import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, inlineScripts, hashSource, buildPolicy, currentPolicy, withPolicy, scriptHashes, htmlFiles } from '../tools/csp.mjs';

test('inlineScripts keeps executable inline blocks verbatim and skips the rest', () => {
    const html = [
        '<script>  a(); \n</script>',
        '<script type="text/javascript">b()</script>',
        '<script type="module">c()</script>',
        '<script src="x.js"></script>',
        '<script type="text/javascript" src="y.js"></script>',
        '<script type="text/x-template"><div></div></script>',
        '<script type="application/json">{"k":1}</script>',
        '<script>   </script>',
        '<SCRIPT>d()</SCRIPT >',
        '<script>e()</script\t\n bar>',
        '<script>f("</scripts>")</script/>',
    ].join('\n');
    assert.deepEqual(inlineScripts(html), ['  a(); \n', 'b()', 'c()', 'd()', 'e()', 'f("</scripts>")']);
});

test('hashSource matches the CSP sha256 form', () => {
    assert.equal(hashSource('alert(1)'), "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");
});

test('withPolicy inserts after <meta charset> and replaces an existing tag', () => {
    const fresh = '<head>\n    <meta charset="UTF-8"/>\n    <title>x</title>';
    const once = withPolicy(fresh, "default-src 'self'");
    assert.match(once, /<meta charset="UTF-8"\/>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'">\n    <title>/);
    const twice = withPolicy(once, "default-src 'none'");
    assert.equal((twice.match(/Content-Security-Policy/g) || []).length, 1);
    assert.equal(currentPolicy(twice), "default-src 'none'");
});

test('the policy never allows inline or eval script sources', () => {
    const policy = buildPolicy(ROOT);
    const scriptSrc = policy.split('; ').find(d => d.startsWith('script-src '));
    assert.ok(scriptSrc);
    assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
    assert.doesNotMatch(scriptSrc, /'unsafe-eval'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /base-uri 'none'/);
    assert.match(policy, /frame-src https:\/\/www\.youtube\.com https:\/\/w\.soundcloud\.com/);
    assert.ok(scriptHashes(ROOT).length > 0, 'no inline scripts found under html/');
});

test('no partial evaluates strings as code (script-src has no unsafe-eval)', () => {
    const offenders = [];
    for (const file of htmlFiles(ROOT)) {
        const html = readFileSync(join(ROOT, file), 'utf8');
        if (/[^A-Za-z0-9_.$]eval\s*\(|new\s+Function\s*\(|set(?:Timeout|Interval)\s*\(\s*["']/.test(html))
            offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'these files use eval/new Function/string timers, which the CSP blocks: ' + offenders.join(', '));
});

test('every transaction builder dispatched by name through window[command] is a defined function', () => {
    const app = readFileSync(join(ROOT, 'js', 'freewallet-desktop.js'), 'utf8');
    const names = new Set();
    for (const file of htmlFiles(ROOT)) {
        const html = readFileSync(join(ROOT, file), 'utf8');
        for (const m of html.matchAll(/command\s*=\s*\(broadcast\)\s*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)) { names.add(m[1]); names.add(m[2]); }
        if (/window\[command\]\(/.test(html))
            assert.match(html, /command\s*=\s*\(broadcast\)/, file + ' dispatches window[command] but does not assign command from the (broadcast) pair');
    }
    assert.ok(names.size >= 26, 'expected at least 26 dispatched names, found ' + names.size);
    const missing = [...names].filter(n => !new RegExp('^function ' + n + '\\s*\\(', 'm').test(app));
    assert.deepEqual(missing, [], 'dispatched by name but not defined in js/freewallet-desktop.js: ' + missing.join(', '));
});

test('index.html carries the current policy (otherwise run: node tools/csp.mjs)', () => {
    const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
    assert.equal(currentPolicy(indexHtml), buildPolicy(ROOT),
        'the Content-Security-Policy meta tag in index.html is stale. Run: node tools/csp.mjs');
});
