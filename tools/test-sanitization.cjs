#!/usr/bin/env node
/*
 * Validator for the CodeQL sanitization fixes. Covers the pure logic that can be
 * exercised without a DOM: the ReDoS fix (linear URL validation), escapeHtml, and
 * the sanitizer's dangerous-scheme normalization. The exact function bodies are
 * mirrored here from js/util.generic.js, js/freewallet-desktop.js and
 * js/sanitizer.js; if those change, update this.
 * Run: node tools/test-sanitization.cjs
 */
const assert = require('assert');
let n = 0;
const ok = (m) => { n++; console.log('  ok', m); };

// --- ReDoS: linear URL validation ------------------------------------------
(function () {
  // The pattern this replaced was an unanchored host regex with nested
  // quantifiers -- (([a-z\d]([a-z\d-]*[a-z\d])*)\.)+ -- which backtracks
  // catastrophically. It is described rather than reproduced here so the
  // vulnerable expression does not live on in the tree.
  function isValidURL(str) {
    try { const u = new URL(String(str)); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (e) { return false; }
  }
  // Correctness
  assert.strictEqual(isValidURL('https://example.com/path?q=1'), true);
  assert.strictEqual(isValidURL('http://1.2.3.4:8332'), true);
  assert.strictEqual(isValidURL('ftp://example.com'), false, 'non-http scheme rejected');
  assert.strictEqual(isValidURL('not a url'), false);
  assert.strictEqual(isValidURL('javascript:alert(1)'), false, 'javascript: rejected');
  ok('URL validation is correct and http/https-only');

  // The malicious input that makes the old pattern backtrack catastrophically.
  const evil = 'a'.repeat(46) + '!';
  const t0 = process.hrtime.bigint();
  const r = isValidURL(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(r, false);
  assert.ok(ms < 50, 'new check returns in <50ms on the ReDoS input (was: hangs)');
  ok(`ReDoS input handled in ${ms.toFixed(2)}ms (linear, no backtracking)`);
})();

// --- escapeHtml ------------------------------------------------------------
(function () {
  function escapeHtml(str){
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  assert.strictEqual(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(escapeHtml('">' ), '&quot;&gt;', 'attribute breakout neutralized');
  assert.strictEqual(escapeHtml("a'b&c"), 'a&#39;b&amp;c', 'all metacharacters, every occurrence');
  ok('escapeHtml neutralizes tag, attribute and entity injection');
})();

// --- sanitizer dangerous-scheme normalization ------------------------------
(function () {
  // Mirror of the check in js/sanitizer.js trimAttributes.
  function isBadScheme(attrValue){
    const normalized = String(attrValue).replace(/[\x00-\x20]+/g, '').toLowerCase();
    return /^(javascript|data|vbscript):/.test(normalized);
  }
  assert.strictEqual(isBadScheme('javascript:alert(1)'), true);
  assert.strictEqual(isBadScheme('JavaScript:alert(1)'), true, 'case variant caught');
  assert.strictEqual(isBadScheme('  javascript:alert(1)'), true, 'leading whitespace caught');
  assert.strictEqual(isBadScheme('java\tscript:alert(1)'), true, 'embedded tab caught');
  assert.strictEqual(isBadScheme('data:text/html,<script>'), true, 'data: caught (was missed)');
  assert.strictEqual(isBadScheme('vbscript:msgbox(1)'), true, 'vbscript: caught (was missed)');
  assert.strictEqual(isBadScheme('https://example.com'), false, 'safe URL allowed');
  assert.strictEqual(isBadScheme('/relative/path'), false, 'relative path allowed');
  ok('dangerous schemes blocked across case/whitespace/data/vbscript; safe values allowed');
})();

console.log(`\n${n} checks passed`);
