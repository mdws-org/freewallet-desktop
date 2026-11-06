#!/usr/bin/env node
/*
 * Stage the web app for the Tauri shell and write its Content-Security-Policy.
 *
 *   node src-tauri/scripts/stage.mjs
 *
 * 1. Copies the runtime files of the upstream web app into src-tauri/web/ (the
 *    Tauri frontendDist) and installs its production npm dependencies there,
 *    because index.html loads its libraries from node_modules/ by path.
 * 2. Writes src-tauri/gen/csp.conf.json, a config overlay for
 *    `tauri build --config`, holding the shell's CSP. script-src reuses the
 *    inline-script hashes that tools/csp.mjs computes for the page's own meta
 *    policy; connect-src and img-src are explicit allowlists instead of the meta
 *    policy's `https: http:`. Both policies are enforced, so the effective
 *    policy is the stricter of the two for every directive.
 */
import { cp, rm, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptHashes } from '../../tools/csp.mjs';

const shellDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(shellDir, '..');
const webDir = resolve(shellDir, 'web');
const genDir = resolve(shellDir, 'gen');

// The runtime files of the web app. hardware/ is left out: those pages are
// served from freewallet.io, not from the app. uri-schemes.html (a page of
// sample links for testing URL-scheme handling) is left out until the shell
// registers URL schemes.
export const INCLUDES = ['index.html', 'package.json', 'css', 'html', 'images', 'js'];

// Every .html file the staged app serves, relative to root.
export function servedHtmlFiles(root = repoDir) {
  const out = [];
  const walk = (rel) => {
    if (statSync(join(root, rel)).isDirectory()) {
      for (const name of readdirSync(join(root, rel))) walk(join(rel, name));
    } else if (rel.endsWith('.html')) {
      out.push(rel);
    }
  };
  INCLUDES.forEach(walk);
  return out.sort();
}

// The staged copy serves the npm libraries from vendor/ (see stage()).
export function rewriteVendorPaths(html) {
  return html.replace(/(src|href)="node_modules\//g, '$1="vendor/');
}

// Every remote origin the wallet's own JS fetches from (XHR / $.getJSON).
const API_ORIGINS = [
  'https://cp20-api.tokenscan.io:4001',   // Counterparty API, mainnet (cpRequest)
  'https://cp20-api.tokenscan.io:14001',  // Counterparty API, testnet
  'https://cp20.tokenscan.io',            // explorer API, mainnet (balances, history, markets, relay)
  'https://cp20-testnet.tokenscan.io',    // explorer API, testnet
  'https://api.github.com',               // release check (FW.RELEASES_API)
  'https://reputation.coindaddy.io',      // asset reputation
  'https://api.blockcypher.com',          // BTC balance/history/broadcast fallback
  'https://blockstream.info',             // BTC balance/history fallback
  'https://chain.so',                     // BTC balance/history fallback
  'https://ipfs.io',                      // ipfs: asset descriptions
  'https://inscription-decoder.vercel.app', // ord: asset descriptions
];

// Images the page itself references (asset icons, NFT art served by the explorer).
const IMG_ORIGINS = [
  'https://cp20.tokenscan.io',
  'https://cp20-testnet.tokenscan.io',
  'https://ipfs.io',
  'https://inscription-decoder.vercel.app',
];

export function shellPolicy(root = repoDir) {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes(root).join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src 'self' data: ${IMG_ORIGINS.join(' ')}`,
    "media-src 'self' data: https:",
    `connect-src ipc: http://ipc.localhost ${API_ORIGINS.join(' ')}`,
    'frame-src https://www.youtube.com https://w.soundcloud.com',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

async function stage() {
  await rm(webDir, { recursive: true, force: true });
  await mkdir(webDir, { recursive: true });
  for (const item of INCLUDES)
    await cp(resolve(repoDir, item), resolve(webDir, item), { recursive: true, verbatimSymlinks: true });
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: webDir,
    stdio: 'inherit',
  });
  // The Tauri CLI refuses a frontendDist that contains a node_modules folder, so
  // the staged copy serves the libraries from vendor/ and its two pages that load
  // them by path are rewritten to match. The sources stay as upstream ships them.
  await rename(resolve(webDir, 'node_modules'), resolve(webDir, 'vendor'));
  await rm(resolve(webDir, 'package-lock.json'), { force: true });
  for (const page of servedHtmlFiles(webDir)) {
    const file = resolve(webDir, page);
    await writeFile(file, rewriteVendorPaths(await readFile(file, 'utf8')));
  }
}

async function writeCsp() {
  await mkdir(genDir, { recursive: true });
  const overlay = { app: { security: { csp: shellPolicy() } } };
  await writeFile(resolve(genDir, 'csp.conf.json'), JSON.stringify(overlay, null, 2) + '\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  if (!process.argv.includes('--csp-only')) await stage();
  await writeCsp();
  console.log('staged', webDir, 'and wrote', resolve(genDir, 'csp.conf.json'));
}
