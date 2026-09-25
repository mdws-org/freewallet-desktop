### Forensic Findings & Question Analysis

#### 1. Correctness of Each Fix & Failure States

* **Issue 1 (Unlock/Enable Password Rules)**: **Closed in UI, defective in Password Change.**
  * *Mechanism*: `dialogPassword` ([line 4318](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4318)) and `dialogEnableBtcpay` ([line 4916](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4916)) remove length/digit checks on unlock.
  * *Failure State*: User with a short migrated password (<12 chars) clicks "Change Wallet Password" in Settings. `dialogPassword(true)` calls `validateNewWalletPassword` ([line 4310](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4310)) on `wallet_password`. If the form field is treated as current password verification, it fails validation before reaching `changeWalletPassword`.

* **Issue 2 (Auto-BTCpay Stash Lifecycle)**: **Closed with Memory Side-Effect.**
  * *Mechanism*: `dialogEnableBtcpay` stashes `btcpayWallet` and `btcpayKeys` ([lines 4926-4927](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4926-L4927)); `lockWallet` ([lines 664-670](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L664-L670)) leaves them untouched.
  * *Failure State*: `ss.btcpayWallet` exists, but `ss.btcpayKeys` is missing or corrupted. During locked auto-pay, `autoBtcpay` ([lines 1291-1294](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1291-L1294)) falls back to `FW.WALLET_KEYS = {}`. On tx completion with `c = true` ([line 1312](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1312)), `FW.WALLET_KEYS` is wiped to `{}` in memory, wiping imported keys if the wallet was unlocked concurrently.

* **Issue 3 (`checkBtcpayAuth` Launch Stacking)**: **Partially Closed; Race Condition Introduced.**
  * *Mechanism*: `initWallet` passes `checkBtcpayAuth` as modal success callbacks ([lines 322-325](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L322-L325)).
  * *Failure State*: `checkUpdateWallet()` ([line 331](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L331)) still executes synchronously during `initWallet()`. If `ss.btcpayWallet` persisted in session memory across a webview reload, `processBtcpayQueue()` ([line 1253](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1253)) executes `autoBtcpay()` and broadcasts queued transactions while `dialogPassword` or `dialogMigrate` is still active on screen. If `ss.btcpayWallet` is null and manual orders exist, `processBtcpayQueue` opens `dialogBTCpay(false)` ([line 1268](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1268)) over the unlock modal.

* **Issue 4 (Reachable Password Change)**: **Closed under Settings, Broken on Header Lock Icon.**
  * *Mechanism*: Entry point added to `html/settings.html` ([line 562](file:///Users/bemeadows/Projects/freewallet-desktop/html/settings.html#L562)).
  * *Failure State*: Unmigrated v1 wallet. `readVault()` returns `null`. In `index.html` ([line 56](file:///Users/bemeadows/Projects/freewallet-desktop/index.html#L56)), clicking `#lock` checks `else if(readVault())`, which evaluates to `false`. Clicking `#lock` on an unmigrated wallet produces no action.

* **Issue 5 (Decrypt-Failure Guard)**: **Closed for Reporting, Unhandled Recovery Path.**
  * *Mechanism*: `dialogPassword` ([line 4326](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4326)) checks `decryptWallet(key)`.
  * *Failure State*: Corrupted v2 `walletVault` payload with intact v1 backup (`ls.wallet`). `isValidWalletPassword` verifies the verifier descriptor, but `decryptWallet` returns `false`. The user is stuck locked without fallback, even though the uncorrupted v1 backup files exist alongside the damaged vault.

* **Issue 6 (Validation Deduplication)**: **Closed.**
  * *Mechanism*: Consolidated in `validateNewWalletPassword` ([line 865](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L865)).

---

#### 2. The Callback Change Impact

No standard callers rely on the old unconditional callback firing. In `processURIData` ([line 5346](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L5346)), withholding the callback on cancel/failure prevents unauthorized URI execution.

However, routing `checkBtcpayAuth` through callbacks does **not** stop `checkUpdateWallet()` ([line 331](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L331)) from firing on the initial tick. `checkUpdateWallet` invokes `processBtcpayQueue()`. If `ss.btcpayWallet` contains a leftover session seed, `autoBtcpay` will execute and sign queue items prior to password verification.

---

#### 3. Lock Icon Evaluation

`index.html` ([lines 53-60](file:///Users/bemeadows/Projects/freewallet-desktop/index.html#L53-L60)):
```javascript
if(ss.getItem('wallet')){
    lockWallet();
    updateWalletOptions();
} else if(readVault()){
    dialogPassword();
}
```

* **v1-Only Legacy State**: `readVault()` returns `null`. Clicking `#lock` fails the `else if` condition and performs no operation. The user cannot trigger `dialogMigrate()` or unlock from the header icon.

---

#### 4. Password Change Gate Security

Requiring only `dialogCheckLocked` without demanding the *current* password is an insufficient security boundary:
* **Attack Mechanism**: An attacker with brief unattended access to an unlocked session navigates to Settings -> "Change Wallet Password". 
* **Impact**: They enter a new password without knowing the original password or 12-word seed. `changeWalletPassword` ([line 579](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L579)) overwrites `walletVault` with the attacker's derived key, permanently locking out the legitimate user upon next lock/restart. Current password re-authentication is required to prevent unauthorized key re-encryption.

---

#### 5. Decrypt-Failure Handling & v1 Backups

Leaving the wallet locked on decrypt failure is incorrect when legacy v1 backup blobs (`ls.wallet`, `ls.walletPassword`, `ls.walletKeys`) reside in `localStorage`. 

`migrateWalletToV2` ([lines 613-617](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L613-L617)) defers purging v1 blobs until `discardV1Backup()` is called upon the first successful v2 unlock ([line 554](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L554)). If `decryptWallet` fails on a corrupted v2 descriptor, the code should check for legacy v1 backup keys, attempt v1 decryption using the verified password, and offer automatic vault re-migration.

---

#### 6. Test Harness Coverage Gaps

`tools/test-wallet-wiring.cjs` extracts low-level storage routines into Node `vm`, missing:
1. **DOM & Dialog Logic**: Does not execute BootstrapDialog action handlers in `dialogPassword`, `dialogMigrate`, or `dialogEnableBtcpay`.
2. **Header Lock Event Listener**: Does not test `index.html` `#lock` click behavior when `readVault()` is `null`.
3. **Queue / Async Initialization Races**: Does not test `checkUpdateWallet()` or `processBtcpayQueue()` execution while unlock modals are open.
4. **Session Key Null Checks**: Does not verify `changeWalletPassword()` behavior if called when `FW.WALLET_ENCKEY` is uninitialized.
