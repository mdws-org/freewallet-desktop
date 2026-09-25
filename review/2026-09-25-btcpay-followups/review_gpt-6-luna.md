<details><summary>Thinking</summary>

Hmmm...



**Evaluating wallet behavior**

I'm considering whether to use a librarian approach with the documents. I can read the patch line, but there's no way to verify every source. The question about auto-locking is interesting: if a wallet is genuinely unlocked while async payments are happening, the callback checks if the wallet is unlocked. If the wallet has a valid key, it seems like it stays unlocked until a set time interval. I'll focus on ensuring clarity and precision in my response.Hmmm...

Hmmm...



**Evaluating initialization context**

I’m reflecting on initializing objects, specifically looking at the `FW.NETWORK_INFO` structure and its potential initial values. I think the harness needs to mock queues and network effectively. It seems important to note that establishing a connection shouldn’t throw errors from the supplied snippets. Perhaps it’s best to ensure that the harness masks with initialized objects. I’m wondering if the CheckBtcpayTransactions hook could run before the network or queue is fully loaded, making this an actionable finding?Hmmm...

Hmmm...



**Evaluating session authentication**

It seems the user is asking about authenticated sessions and the path for handling them. I need to think about how the `raw ss.getItem` decisions are managed. It looks like there’s an intention for autopay with no authentication UI involved. Also, I'm wondering if `getWallet` readers could involve functions like `getWalletPassphrase` without an additional gate. I need to clarify these mechanisms to ensure I'm addressing the user's inquiry correctly.Hmmm...

Hmmm...

</details>

## Findings, ranked by impact

### 1. Remaining raw-seed readers

The supplied context does not include a full call-site search, so I cannot certify that every `ss.getItem('wallet')` or `getWallet()` reader is safe. In the provided excerpts:

- `checkBtcpayAuth()` reads `ss.getItem('wallet')` and, if Auto-BTCpay is enabled but its stash is absent, copies that value into `btcpayWallet` (lines 1131-1152). During a locked hot-swap this could promote the temporary seed into the stash. Normally the stash already exists to start that swap, so this is a race or inconsistent-state risk, not the ordinary path.
- `processBtcpayQueue()` uses wallet presence to select the auto-pay branch (lines 1316-1333). That is an intentional payment decision, not an authenticated-session gate. `autoBtcpay()` also uses presence to decide whether it owns cleanup of the temporary wallet (lines 1351-1375).
- `getWallet()` returns the raw session value (lines 688-689), and `getWalletPassphrase()` reads through it (lines 78-80). The excerpt does not show all callers. Any caller that exposes or uses that value without an `isWalletUnlocked()` gate remains relevant.

The harness tests `dialogCheckLocked()`, not all call sites that consume the seed.

### 2. Auto-lock during a swap

For a locked-wallet hot-swap, `FW.WALLET_ENCKEY` is null, so the new condition prevents auto-lock from removing `ss.wallet` during `cpBtcpay()`. That avoids the old mid-payment deletion hazard.

A genuinely unlocked wallet is not exempt: its key remains set, so an expired auto-lock still fires, including while `cpBtcpay()` is in flight. That is the old behavior for an unlocked wallet, not a new failure to auto-lock. The more concerning overlap is concurrent queue processing: a second `autoBtcpay()` call during the first swap sees the temporary seed as already present and sets `c=false`; its callback will not clean it up. Whether that overlap is reachable depends on the update/tick scheduling, which the harness does not test.

### 3. Launch-dialog flag

There is a definite false-while-dialog-open path. `FW.LAUNCH_DIALOG_OPEN` is set only by `initWallet()` (lines 327-341). A later lock-icon unlock, or a `dialogPassword` opened by `processURIData`, does not set it. A 60-second queue check can therefore open a manual-payment prompt over that password dialog.

A stale-true case is not established by the supplied excerpts. The launch password callbacks clear the flag on success and Cancel. The migrate callback is success-only; if migration failure closes the dialog without invoking the callback, the flag remains true and suppresses manual prompts indefinitely. The `dialogMigrate()` failure/close implementation is not included, so that case cannot be confirmed.

### 4. Hook ordering and readiness

Ordering matters after Cancel: `checkBtcpayAuth()` can open `dialogEnableBtcpay()` when Auto-BTCpay is enabled and no stash exists; the immediately following `checkBtcpayTransactions()` can open the manual-payment dialog as well. That recreates dialog stacking, though not the original launch-dialog stacking.

`initWallet()` starts `checkUpdateWallet()` before the user answers the launch dialog (lines 342-349), so the hook may run before network refresh completes. The excerpt does not include `checkBtcpayTransactions()` or its readiness guards; it is not possible to conclude whether it safely handles an empty/unloaded queue or missing network info. The harness pre-populates both structures, so it does not resolve this risk.

### 5. Test gate and coverage

`execFileSync()` throws on a nonzero child exit, so a failing tools script fails this test; the output-count assertions also reject a script that exits successfully without reporting checks. This is a real `npm test` gate if the existing test command discovers `test/tools.test.js`; the provided diff does not show the package/CI wiring.

The harness does not exercise actual signing or network calls, concurrent queue ticks, auto-lock during an in-flight payment, dialog stacking, the lock-icon/URI unlock paths, migration failure/close behavior, or queue/network initialization races.
