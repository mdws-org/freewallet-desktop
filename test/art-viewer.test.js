import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// js/art-viewer.js is a classic browser script; load it the way embed-url.test.js
// loads embed-url.js.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'js', 'art-viewer.js'), 'utf8');

function load(window) {
    const context = { URL, window, atob };
    vm.runInNewContext(source, context);
    return context;
}

const VIEW = 'fwart://localhost/view?src=';
const srcOf = (v) => decodeURIComponent(v.slice(VIEW.length));

test('https artwork URLs map to the viewer, URL-encoded and normalised', () => {
    const { artViewerUrl } = load({});
    const v = artViewerUrl('  https://Example.COM/a b.png?x=1&y=2#f');
    assert.ok(v.startsWith(VIEW));
    assert.equal(v.slice(VIEW.length).indexOf('&'), -1, 'src must be one query parameter');
    assert.equal(srcOf(v), 'https://example.com/a%20b.png?x=1&y=2#f');
});

test('ipfs:// URLs are read through the ipfs.io gateway', () => {
    const { artViewerUrl } = load({});
    assert.equal(srcOf(artViewerUrl('ipfs://bafyabc/art.png')), 'https://ipfs.io/ipfs/bafyabc/art.png');
    assert.equal(srcOf(artViewerUrl('IPFS://ipfs/bafyabc')), 'https://ipfs.io/ipfs/bafyabc');
});

test('anything but an https URL is refused', () => {
    const { artViewerUrl } = load({});
    for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA',
        'file:///etc/passwd', 'fwart://localhost/view?src=x', 'example.com/a.png', '', null, undefined])
        assert.equal(artViewerUrl(bad), false, JSON.stringify(bad));
});

test('artFrameSrc frames only under the Tauri shell', () => {
    assert.equal(load({}).artFrameSrc('https://example.com/a.png'), false);
    assert.ok(load({ __TAURI_INTERNALS__: {} }).artFrameSrc('https://example.com/a.png').startsWith(VIEW));
    assert.equal(load({ __TAURI_INTERNALS__: {} }).artFrameSrc('data:image/png;base64,AAAA'), false);
});

test('withArtData decodes base64 data: URIs without a request', () => {
    let got = null;
    const ctx = load({});
    ctx.$ = { get() { throw new Error('requested a data: URI'); } };
    ctx.withArtData('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'), (t) => { got = t; });
    assert.equal(got, '<svg/>');
    let fetched = null;
    ctx.$ = { get(url) { fetched = url; } };
    ctx.withArtData('https://example.com/a.png', () => {});
    assert.equal(fetched, 'https://example.com/a.png');
});
