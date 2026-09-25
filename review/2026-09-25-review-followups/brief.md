# Review: freewallet-desktop, follow-ups to the v2 wallet-encryption change

You are reviewing a patch to a desktop Bitcoin/Counterparty wallet (NW.js, jQuery, BootstrapDialog; one large script file). Real funds sit behind this code. Answer as a forensic reviewer of funds-handling software: mechanisms and line references, no compliments, do not restate the patch back to me. Rank findings by expected impact. Under 900 words.

Read the listed files. Run nothing. Write nothing. Do not edit any files. Answer in your final message.

## Background

A previous change replaced the wallet's at-rest encryption: PBKDF2-derived key, a stored verifier instead of a stored password, a single `walletVault` record in localStorage, a mandatory password (new wallets need 12+ characters including a digit), and a migration that upgrades a legacy wallet on its first unlock. A legacy wallet that already had a password keeps it through migration, even if it is shorter than 12 characters (the legacy minimum was 7).

An independent review of that change confirmed six issues. This patch fixes them:

1. The unlock dialog and the enable-Auto-BTCpay dialog applied the 12-character/digit rule before checking the password against the vault, so a wallet migrated on a 7-11 character password could never be unlocked again.
2. Enabling Auto-BTCpay stashes the wallet seed (`btcpayWallet`) and, since the previous change, the imported private keys (`btcpayKeys`) in sessionStorage so matched orders can be paid while the wallet is locked. `lockWallet()` clears neither. The stash lifecycle is a deliberate product decision (auto-pay after the auto-lock timer fires); the fix is to state it in the enable dialog and keep seed and keys on one lifecycle.
3. `checkBtcpayAuth()` ran during `initWallet()` while the unlock/migrate modal was open, so its own password dialog stacked on top; for an unmigrated legacy wallet its verifier check could not succeed.
4. The change-password dialog (`dialogPassword(true)`) was unreachable: its only entry, the lock icon in index.html, gated on `walletEncrypted != 1`, which every v2 wallet fails.
5. `decryptWallet()` returns a boolean that both unlock paths ignored, so a verified password with an undecryptable vault still showed "Wallet unlocked".
6. The strength check was copy-pasted in four dialogs.

## What the patch does

- Adds `validateNewWalletPassword(password, confirm)` (returns an error string or false) and uses it in the three set-password paths: new wallet, migration from a no-password wallet, password change. Unlock and enable-Auto-BTCpay call only `isValidWalletPassword` (the KDF verifier).
- `dialogPassword` and `dialogEnableBtcpay` check `decryptWallet(key)`; on false they show an error and leave the wallet locked. `dialogPassword` now invokes its `callback` only after a successful unlock or password change (before, it fired after a failed unlock too).
- `initWallet` passes `checkBtcpayAuth` as the success callback of `dialogPassword(false, ...)` and `dialogMigrate(...)` instead of calling it unconditionally. Cancelling the unlock skips the check for that launch.
- index.html: the lock icon locks when `ss.wallet` is set, otherwise opens the unlock dialog if `readVault()` is non-null. html/settings.html: a "Change Wallet Password" button on the Wallet tab, gated by `dialogCheckLocked`, calls `dialogPassword(true)`.
- The Auto-BTCpay enable dialog gains a paragraph stating that the seed and imported keys stay in session memory until logout or app close and that locking does not remove them. `lockWallet` documents the same.
- `tools/test-wallet-wiring.cjs` extracts the storage-level functions from the shipped file and runs them against mock storage; three cases were added (the new function and a migrated 7-character password still unlocking; `decryptWallet` returning false on a damaged blob with no state left behind; the stash surviving `lockWallet`). All 25 checks pass.

Settled and not under review: the KDF, the vault format, the migration algorithm, the 12-character rule itself, and whether Auto-BTCpay should exist.

## Attached

- `diff.patch`: the whole change (`git diff` of four files).
- `context-functions.txt`: every touched function and its direct callers/callees, extracted from the patched `js/freewallet-desktop.js` with line numbers, in file order.
- `tools/test-wallet-wiring.cjs`: the test harness, patched.
- If you can read files by path, the full patched sources are at `/Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js`, `/Users/bemeadows/Projects/freewallet-desktop/index.html`, `/Users/bemeadows/Projects/freewallet-desktop/html/settings.html`.

## Questions

1. **Correctness of each fix.** For each of the six, does the patch close it, and can you construct a state (localStorage/sessionStorage contents plus a sequence of dialogs) in which the original failure still occurs or a new one appears? Give the concrete state.
2. **The callback change.** `dialogPassword`'s callback now fires only on success. `processURIData` (around line 5346 of the full file) passes a retry callback; `initWallet` passes `checkBtcpayAuth`. Does any caller depend on the old behaviour? Does routing `checkBtcpayAuth` through the callbacks change what `processBtcpayQueue`/`autoBtcpay` do on the first `checkUpdateWallet()` tick, which still runs while the unlock dialog is open?
3. **The lock icon.** With `readVault()` as the gate, name any wallet state (v1-only, v2 with v1 backup blobs, no wallet, mid-migration) where the icon does the wrong thing.
4. **Password change without the current password.** The change-password path requires an unlocked wallet but not the current password. The 12-word passphrase is viewable from the same Settings tab while unlocked. Is that gate sufficient, and if not, what exactly does requiring the current password protect against here?
5. **Decrypt-failure handling.** When `isValidWalletPassword` succeeds but `decryptWallet` fails, is "leave locked, tell the user to restore from the passphrase" the right outcome, or is there a state that should be handled differently (e.g. the legacy backup blobs still present beside a damaged v2 vault)?
6. **Tests.** What state or path does the wiring test still not exercise that would have caught a defect in this patch?
