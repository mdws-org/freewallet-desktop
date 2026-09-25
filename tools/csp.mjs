#!/usr/bin/env node
// Content-Security-Policy for index.html.
//
// The app is a single NW.js page with Node in the window and no server, so
// the policy is delivered by a <meta http-equiv> tag and script-src carries a
// sha256 hash for every inline <script> block in index.html and the html/
// partials that jQuery .load()s. Nothing else is inline-allowed: an injected
// <script>, an on* handler or a javascript: URL is blocked.
//
//   node tools/csp.mjs          rewrite the meta tag in index.html
//   node tools/csp.mjs --check  exit 1 if the meta tag is stale (npm test runs this)
//
// Run it after editing an inline <script> block in index.html or under html/.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The end tag is matched the way the HTML tokenizer closes script data: "</script"
// followed by whitespace, "/" or ">", then anything up to the next ">".
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script(?:[\s/][^>]*)?>/gi;
const JS_TYPE_RE = /^(text\/javascript|application\/javascript|module)$/i;

// Inline script bodies of one HTML document, verbatim, in document order.
// A block with a src attribute is external; a block whose type is not a
// JavaScript type (templates, JSON) never executes; both are skipped.
export function inlineScripts(html) {
    const out = [];
    for (const m of html.matchAll(SCRIPT_RE)) {
        const attrs = m[1], body = m[2];
        if (/\bsrc\s*=/i.test(attrs)) continue;
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
        if (type && !JS_TYPE_RE.test(type[1])) continue;
        if (!body.trim()) continue;
        out.push(body);
    }
    return out;
}

export function hashSource(body) {
    return "'sha256-" + createHash('sha256').update(body, 'utf8').digest('base64') + "'";
}

// index.html plus every .html file under html/, relative to root.
export function htmlFiles(root = ROOT) {
    const files = ['index.html'];
    const walk = (dir) => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
            const rel = join(dir, entry.name);
            if (entry.isDirectory()) walk(rel);
            else if (entry.name.endsWith('.html')) files.push(rel);
        }
    };
    walk('html');
    return files.sort();
}

export function scriptHashes(root = ROOT) {
    const hashes = new Set();
    for (const file of htmlFiles(root))
        for (const body of inlineScripts(readFileSync(join(root, file), 'utf8')))
            hashes.add(hashSource(body));
    return [...hashes].sort();
}

// connect-src stays wide because asset metadata JSON, images and the SVG
// sniff in showAssetArtwork() fetch from whatever host an issuer chose.
// style-src keeps 'unsafe-inline' for the inline style= attributes in the
// templates; styles are not the attack surface this policy is for.
export function buildPolicy(root = ROOT) {
    return [
        "default-src 'self'",
        `script-src 'self' ${scriptHashes(root).join(' ')}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-src https://www.youtube.com https://w.soundcloud.com",
        "connect-src https: http:",
        "img-src 'self' https: http: data:",
        "media-src https: http: data:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
    ].join('; ');
}

const META_RE = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

export function currentPolicy(indexHtml) {
    const m = META_RE.exec(indexHtml);
    return m ? m[1] : null;
}

// The meta tag sits directly after <meta charset> so it is in force before
// the first <script> tag is parsed.
export function withPolicy(indexHtml, policy) {
    const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
    if (META_RE.test(indexHtml)) return indexHtml.replace(META_RE, tag);
    return indexHtml.replace(/(<meta charset="[^"]*"\s*\/?>)/i, `$1\n    ${tag}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const indexPath = join(ROOT, 'index.html');
    const indexHtml = readFileSync(indexPath, 'utf8');
    const policy = buildPolicy();
    const current = currentPolicy(indexHtml);
    if (process.argv.includes('--check')) {
        if (current === policy) {
            console.log(`csp: index.html is current (${scriptHashes().length} inline script hashes)`);
        } else {
            console.error('csp: the Content-Security-Policy meta tag in index.html is stale. Run: node tools/csp.mjs');
            process.exit(1);
        }
    } else if (current === policy) {
        console.log('csp: index.html already current');
    } else {
        writeFileSync(indexPath, withPolicy(indexHtml, policy));
        console.log(`csp: wrote ${relative(process.cwd(), indexPath)} (${scriptHashes().length} inline script hashes)`);
    }
}
