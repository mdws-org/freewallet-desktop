import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// The js/ files are classic browser scripts with a CommonJS branch, but the
// package is "type": "module", so they are evaluated here as CommonJS by hand.
const require = createRequire(import.meta.url);
function loadUMD(rel, deps = {}) {
    const m = { exports: {} };
    const req = (id) => (id in deps ? deps[id] : require(id));
    new Function('module', 'exports', 'require', readFileSync(new URL(rel, import.meta.url), 'utf8'))(m, m.exports, req);
    return m.exports;
}
const WalletCrypto = loadUMD('../js/wallet-crypto.js');
const WalletBackup = loadUMD('../js/wallet-backup.js', { './wallet-crypto.js': WalletCrypto });

class MemoryStorage {
    constructor(init = {}) { this.m = new Map(Object.entries(init)); }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
    toObject() { return Object.fromEntries(this.m); }
}

// A real v2 vault for a throwaway seed, built the way createWallet/writeVault do.
const SEED_HEX = 'f00dfeedc0ffee0123456789abcdef42';
const WALLET_PASSWORD = 'wallet-password-1';
const BACKUP_PASSWORD = 'backup-password-22';
const mk = WalletCrypto.makeCrypto(WALLET_PASSWORD);
const vault = JSON.stringify({
    v: 2,
    crypto: mk.descriptor,
    wallet: WalletCrypto.encrypt(SEED_HEX, mk.keyset),
    keys: WalletCrypto.encrypt('{}', mk.keyset),
});
const deviceEntries = {
    walletVault: vault,
    walletEncrypted: '1',
    walletFormat: '1',
    walletNetwork: '1',
    walletAddresses: JSON.stringify([{ network: 'mainnet', address: 'bc1qtestaddress', label: 'Savings', type: 1, index: 0 }]),
    walletAddress: 'bc1qtestaddress',
    walletAddressLabel: 'Savings',
    walletAutoLock: '30',
};
const device = new MemoryStorage({
    ...deviceEntries,
    walletBalances: '[{"asset":"BTC"}]',   // cache: not exported
    licenseAgreementAccept: '1',          // not wallet data: not exported
    serverInfo: '{"mainnet":{}}',         // not exported
});
const backupText = WalletBackup.create(WalletBackup.collect(device), BACKUP_PASSWORD, { app: '2.1.3' });

// Seal arbitrary plaintext as a well-formed backup, bypassing create()'s checks.
function seal(plaintext, password = BACKUP_PASSWORD, header = {}) {
    const k = WalletCrypto.makeCrypto(password);
    return JSON.stringify({
        format: 'freewallet-backup', v: 1, created: new Date().toISOString(), app: 'test',
        kdf: k.descriptor, blob: WalletCrypto.encrypt(plaintext, k.keyset), ...header,
    });
}

test('export carries exactly the allowlisted entries and no plaintext secret', () => {
    const file = JSON.parse(backupText);
    assert.equal(file.format, 'freewallet-backup');
    assert.equal(file.v, 1);
    assert.equal(file.app, '2.1.3');
    assert.match(file.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(file.kdf.iter, WalletCrypto.PBKDF2_ITERATIONS);
    assert.equal(file.kdf.iter, 310000);
    assert.deepEqual(Object.keys(file).sort(), ['app', 'blob', 'created', 'format', 'kdf', 'v']);
    assert.ok(!backupText.includes(SEED_HEX), 'seed hex appears in the file');
    assert.ok(!backupText.includes(WALLET_PASSWORD), 'wallet password appears in the file');
    assert.ok(!backupText.includes(BACKUP_PASSWORD), 'backup password appears in the file');
    assert.ok(!backupText.includes('Savings'), 'entries are not encrypted');
});

test('round trip restores the same entries and the wallet unlocks with its own password', () => {
    const res = WalletBackup.open(backupText, BACKUP_PASSWORD);
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.entries, deviceEntries);
    const fresh = new MemoryStorage({ licenseAgreementAccept: '1' });
    WalletBackup.apply(fresh, res.entries);
    assert.deepEqual(fresh.toObject(), { licenseAgreementAccept: '1', ...deviceEntries });
    const restored = JSON.parse(fresh.getItem('walletVault'));
    const keyset = WalletCrypto.verifyPassword(WALLET_PASSWORD, restored.crypto);
    assert.ok(keyset);
    assert.equal(WalletCrypto.decrypt(restored.wallet, keyset), SEED_HEX);
});

test('each export draws a new salt', () => {
    const again = WalletBackup.create(WalletBackup.collect(device), BACKUP_PASSWORD, { app: '2.1.3' });
    assert.notEqual(JSON.parse(again).kdf.salt, JSON.parse(backupText).kdf.salt);
});

test('a wrong backup password is rejected', () => {
    const res = WalletBackup.open(backupText, 'not-the-password-1');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'password');
    assert.equal(res.entries, undefined);
});

test('a tampered blob is rejected by the MAC', () => {
    const file = JSON.parse(backupText);
    const blob = JSON.parse(file.blob);
    const ct = Buffer.from(blob.ct, 'base64');
    ct[ct.length - 1] ^= 0x01;
    blob.ct = ct.toString('base64');
    file.blob = JSON.stringify(blob);
    const res = WalletBackup.open(JSON.stringify(file), BACKUP_PASSWORD);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'tampered');

    // An IV edit decrypts cleanly (CBC: it flips the same bit of the first
    // plaintext block, so padding stays valid). Here it turns '{"walletVault"'
    // into '{"WalletVault"', which still parses; only the MAC stops it.
    const file2 = JSON.parse(backupText);
    const blob2 = JSON.parse(file2.blob);
    const iv = Buffer.from(blob2.iv, 'hex');
    iv[2] ^= 0x20;
    blob2.iv = iv.toString('hex');
    file2.blob = JSON.stringify(blob2);
    const res2 = WalletBackup.open(JSON.stringify(file2), BACKUP_PASSWORD);
    assert.equal(res2.ok, false);
    assert.equal(res2.error, 'tampered');
});

test('a changed salt or iteration count does not open', () => {
    const file = JSON.parse(backupText);
    file.kdf.iter = file.kdf.iter + 1;
    const res = WalletBackup.open(JSON.stringify(file), BACKUP_PASSWORD);
    assert.equal(res.ok, false);
});

test('unknown or extra entries are rejected, even when correctly encrypted', () => {
    const withExtra = seal(JSON.stringify({ ...deviceEntries, donateAddress: 'bc1qattacker' }));
    const res = WalletBackup.open(withExtra, BACKUP_PASSWORD);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'keys');
    assert.match(res.message, /donateAddress/);
    assert.throws(() => WalletBackup.apply(new MemoryStorage(), { ...deviceEntries, serverInfo: '{}' }), /serverInfo/);
});

test('a backup without a valid wallet record is rejected', () => {
    const { walletVault, ...rest } = deviceEntries;
    const res = WalletBackup.open(seal(JSON.stringify(rest)), BACKUP_PASSWORD);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'keys');
    const bad = WalletBackup.validateEntries({ ...deviceEntries, walletVault: '{"v":2,"crypto":{},"wallet":"x"}' });
    assert.match(bad, /not a valid encrypted wallet/);
});

test('a wrong format or version is rejected before any key derivation', () => {
    const file = JSON.parse(backupText);
    for (const [patch, code] of [
        [{ format: 'something-else' }, 'format'],
        [{ v: 2 }, 'version'],
        [{ v: '1' }, 'version'],
        [{ extra: true }, 'format'],
    ]) {
        const res = WalletBackup.open(JSON.stringify({ ...file, ...patch }), BACKUP_PASSWORD);
        assert.equal(res.ok, false, JSON.stringify(patch));
        assert.equal(res.error, code, JSON.stringify(patch));
    }
    assert.equal(WalletBackup.open('not json', BACKUP_PASSWORD).error, 'format');
    assert.equal(WalletBackup.open('[]', BACKUP_PASSWORD).error, 'format');
    const huge = { ...file, kdf: { ...file.kdf, iter: 1e9 } };
    assert.equal(WalletBackup.readHeader(JSON.stringify(huge)).error, 'format');
});

test('import over an existing wallet lists what it replaces and clears the old wallet', () => {
    const existing = new MemoryStorage({
        walletVault: '{"old":true}', wallet: 'legacy', walletBalances: '[]',
        btcpayQueue: '{}', theme: 'theme-blue',
    });
    assert.equal(WalletBackup.hasWallet(existing), true);
    const res = WalletBackup.open(backupText, BACKUP_PASSWORD);
    assert.deepEqual(WalletBackup.replacedKeys(existing, res.entries).sort(),
        ['btcpayQueue', 'wallet', 'walletBalances', 'walletVault']);
    WalletBackup.apply(existing, res.entries);
    assert.deepEqual(existing.toObject(), { theme: 'theme-blue', ...deviceEntries });
});

test('a failed write puts every touched entry back', () => {
    const existing = new MemoryStorage({ walletVault: 'old-vault', walletAddress: 'old-addr', walletHistory: '[]' });
    const before = existing.toObject();
    let writes = 0;
    const orig = existing.setItem.bind(existing);
    existing.setItem = (k, v) => { if (++writes === 3) throw new Error('quota'); orig(k, v); };
    assert.throws(() => WalletBackup.apply(existing, deviceEntries), /quota/);
    existing.setItem = orig;
    assert.deepEqual(existing.toObject(), before);
});
