### 1. Unprotected Passphrase Export (`dialogPassphrase` Gate Bypass) — High Impact
* **Mechanism:** [`dialogPassphrase()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4464-L4494) calls [`getWalletPassphrase()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L701-L715), which reads `ss.getItem('wallet')`. If `dialogPassphrase()` is invoked while a hot-swap is active (`ss.wallet` populated by [`autoBtcpay()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1351-L1395)), it exports the master 12-word seed in cleartext while the wallet is locked (`FW.WALLET_ENCKEY === null`). Unlike [`dialogViewPrivateKey()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4162-L4206), `dialogPassphrase()` was not updated to check [`isWalletUnlocked()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L696-L698).
* **Remaining Readers:** [`getPrivateKey()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1923-L1961) and [`getWalletAddress()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L730-L751) read `getWallet()` directly. While `dialogCheckLocked()` protects standard UI actions, any call path reaching `getPrivateKey()` during a hot-swap (such as open dialog handlers or direct RPC calls) will derive keys without requiring `FW.WALLET_ENCKEY`.

---

### 2. Uncaught Crash on Uninitialized `NETWORK_INFO` — High Impact
* **Mechanism:** The launch hook [`afterLaunchDialog()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L327-L333) invokes [`checkBtcpayTransactions()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1172-L1235) immediately upon closing the launch dialog. `checkBtcpayTransactions()` calls [`processBtcpayQueue()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1316-L1349) -> [`cleanupBtcpay()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1241-L1275). Line 1251 executes:
  `if(FW.NETWORK_INFO.network_info[network].block_height < o.expire_index)`
  On fresh start (or clear `localStorage`), `FW.NETWORK_INFO` is `{}` because [`updateNetworkInfo()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1869-L1883) is async and has not resolved. This throws `TypeError: Cannot read property 'mainnet' of undefined`, crashing queue processing upon unlock/cancel.

---

### 3. `LAUNCH_DIALOG_OPEN` Lockout & Dialog Stacking — Medium Impact
* **State A (Permanent Prompt Suppression):** [`initWallet()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L305-L355) sets `FW.LAUNCH_DIALOG_OPEN = true`. [`dialogMigrate()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4274-L4345) runs `afterLaunchDialog` only on migration success (line 4340). If migration fails or the dialog is closed without migrating, `FW.LAUNCH_DIALOG_OPEN` remains `true` indefinitely, permanently suppressing manual BTCPay prompts.
* **State B (Stacking on Mid-Session Re-Unlock):** `afterLaunchDialog` clears `FW.LAUNCH_DIALOG_OPEN` on app start. If the wallet is locked mid-session, `FW.LAUNCH_DIALOG_OPEN` remains `false`. When a manual match exists, [`processBtcpayQueue()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1345) sees `FW.LAUNCH_DIALOG_OPEN === false` and opens `dialogBTCpay()`, which calls [`dialogCheckLocked()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4618-L4623) and stacks a "Wallet Locked!" dialog. When the user opens [`dialogPassword()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L4350) via the lock icon, `FW.LAUNCH_DIALOG_OPEN` is not set to `true`, causing subsequent 60s background ticks to stack additional "Wallet Locked!" prompts over the open unlock dialog.

---

### 4. Auto-Lock Behavior During Active Hot-Swap — Medium Impact
* **Mechanism:** If the wallet was unlocked (`FW.WALLET_ENCKEY` set) when `autoBtcpay()` begins, [`isWalletUnlocked()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L696-L698) returns `true`. If `FW.WALLET_LAST_UNLOCKED` expires while `cpBtcpay()` is in-flight, [`checkAutoLock()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1101-L1107) calls [`lockWallet()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L722-L728), clearing `ss.wallet`, `FW.WALLET_ENCKEY`, and `FW.WALLET_KEYS` mid-operation.
* **Impact:** `checkAutoLock()` does not fire during a hot-swap initiated from a locked state (since `FW.WALLET_ENCKEY` is null). For a genuinely unlocked wallet, mid-swap locking clears `FW.WALLET_ENCKEY`, so `autoBtcpay`'s completion handler (line 1390) evaluates `if(c && !FW.WALLET_ENCKEY)` as false (since `c` was false), leaving `ss.wallet` removed by `lockWallet()` while `FW.WALLET_KEYS` remains wiped. The old behavior of locking mid-swap was not relied upon; it was an unintended race condition during network calls.

---

### 5. CI Test Gate Integrity & Coverage Gaps — Low Impact
* **CI Enforcement:** [`test/tools.test.js`](file:///Users/bemeadows/Projects/freewallet-desktop/test/tools.test.js#L1-L25) executes each `.cjs` tool via `execFileSync`. An assertion failure in any script causes a non-zero exit code, failing `npm test` in CI.
* **Coverage Gaps:** [`tools/test-wallet-wiring.cjs`](file:///Users/bemeadows/Projects/freewallet-desktop/tools/test-wallet-wiring.cjs#L1-L615) does not test:
  1. DOM lock-icon class and UI menu mutations in [`index.html`](file:///Users/bemeadows/Projects/freewallet-desktop/index.html#L224-L236) and [`updateWalletOptions()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L971-L1021).
  2. Uninitialized `FW.NETWORK_INFO` during [`cleanupBtcpay()`](file:///Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js#L1251) execution.
  3. `dialogMigrate()` failure/abandonment effect on `FW.LAUNCH_DIALOG_OPEN`.
  4. Re-locking mid-session and subsequent dialog stacking during background ticks.
  5. `dialogPassphrase()` behavior under an active hot-swap.
