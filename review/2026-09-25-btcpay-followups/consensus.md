# Round 1: 4 lanes on the Auto-BTCpay follow-ups (#11, #12), 2026-09-25

Lanes asked, and what each could see:

| Lane | Route | Saw | Result |
|---|---|---|---|
| DeepSeek V4.1 Flash | `council-ccx.sh deepseek-flash`, twice (first design, then the revision) | brief + diff + context excerpt (path reads refused) | `review_deepseek-flash.round1.md` 4.5 KB, `review_deepseek-flash.md` 4.5 KB: the Cancel-path stacking and the stuck flag in the first design; the two unverified claims on the revision, both refuted below |
| GPT-6 Luna | Kagi `gpt-6-luna` with attachments | same | `review_gpt-6-luna.md` 5.8 KB: the flag is set only at launch, so a later password dialog is unprotected |
| Gemini | `council-gemini.sh` (agyx, repo dir) | full repo | `review_gemini-agyx.md` 6.3 KB: `dialogPassphrase()` carried no gate of its own |
| SWE-2 max | `council-devin.sh swe-2-max`, twice | attempt 1: excerpts only, asked for the sources and stopped (227 bytes); attempt 2: full sources attached, 3.5 KB before the process was killed by a stray `pkill` from this side (its command line lists the attached test file) | `review_devin-swe-2-max.attempt1.md`, `review_devin-swe-2-max.md`: `checkBtcpayAuth` still read "seed present" as "wallet open" |

The brief carries a "Revision" section: the first design (a launch flag `FW.LAUNCH_DIALOG_OPEN` plus a hook that re-ran the queue check) was replaced after the first three replies.

---

## A. Verified defects (read against the code, fixed, covered in tools/test-wallet-wiring.cjs)

**A1: the launch flag re-created #11 on the Cancel path and left later dialogs unprotected.** *DeepSeek, Luna, Gemini.* After Cancel the hook opened the Auto-BTCpay dialog and then ran the queue check, so the manual prompt could stack on that dialog; and the flag was set only at launch, so a lock-icon or URI-handler unlock dialog got no protection. Fix: no flag and no hook; `processBtcpayQueue` asks `isPasswordDialogOpen()` at every tick, and the launch hooks are `checkBtcpayAuth` alone, as in #9. Test: the manual prompt is held while a password dialog is registered and offered after.

**A2: a DOM query is not exact at the instant a dialog opens.** *Found in the runtime pass, not by a lane; SWE-2 asserted the opposite.* Bootstrap appends the modal after the backdrop's fade: absent at 0 and 50 ms, present at 450 ms, while `initWallet` runs the first queue check synchronously, so a queued match still stacked its notice at launch. Fix: `isPasswordDialogOpen()` reads BootstrapDialog's instance registry, which is filled in the constructor and emptied on `hidden`; verified synchronous in the app. Test: the guard is true with a `btc-wallet-password` instance registered and false with only other dialogs.

**A3: `dialogPassphrase()` had no gate of its own.** *Gemini.* Its only caller gates, but the seed is shown in cleartext, so it now checks like `dialogViewPrivateKey()`. Test: refused during the swap, no dialog shown.

**A4: `checkBtcpayAuth` treated a swapped seed as consent.** *SWE-2.* The silent-stash branch keyed on `ss.wallet` alone. Fix: `isWalletUnlocked()`. Test: a swapped seed is not stashed and the check asks; an unlocked wallet is stashed silently.

**A5: test wrapper.** *DeepSeek, SWE-2.* `execFileSync` got a timeout, and a failing script's own output is now in the assertion message.

**Refuted:**
- "`isWalletUnlocked()` is false for a legitimately open unencrypted wallet" (DeepSeek): there is no unencrypted mode since #5, and every path that opens a wallet sets `FW.WALLET_ENCKEY` (createWallet, decryptWallet, changeWalletPassword, rebuildVaultFromV1).
- "Only one of the five dialogs is known to carry the class" (DeepSeek): all four dialog functions do (new wallet, migrate, unlock/change, enable Auto-BTCpay), checked by grep and now by the harness against the real function.
- "The launch dialog is realized synchronously before the queue check" (SWE-2): measured false, see A2.
- "Auto-lock can now strand an in-flight payment for an unlocked wallet" (Gemini, Luna): a wallet that was open when `autoBtcpay` began never hot-swaps (`c` is false), so this is the general case of the lock timer firing during any signing call, unchanged by this patch; and an unlock resets `WALLET_LAST_UNLOCKED`, so the timer cannot fire within the auto-lock period after it.
- "`checkBtcpayTransactions` in the hook runs before network info exists" (DeepSeek, Gemini, Luna): moot, the hook no longer calls it.

## B. Where the lanes converge

**B1: the hook-and-flag design was wrong** (3 of 3 that saw it). Replaced, see A1 and A2.

**B2: `checkAutoLock` requiring the derived key removes a real hazard** (DeepSeek, SWE-2, Luna): the old test fired mid-swap and deleted `ss.wallet` under an in-flight signing call.

## C. Not applied

- `cleanupBtcpay` dereferences `FW.NETWORK_INFO.network_info` unguarded (SWE-2, Gemini): reachable only with a persisted queue and no cached network info, which a fresh install cannot have. Pre-existing; noted.
- A second `autoBtcpay` starting during a first one's swap sets `c` false and skips cleanup (Luna): the first call's cleanup covers it. Pre-existing; noted.
- The guard is a naming contract: a future password dialog without the class would not be held (SWE-2). Recorded in the guard's comment.

## D. What each lane got wrong

- SWE-2's first attempt stopped at a request for files; the second was killed from this side, not by the lane.
- SWE-2 asserted the launch dialog is realized synchronously; the app measured otherwise.
- DeepSeek's two "unverified" items were both refutable from the code it could not read; the claims were labelled as such, which is the right shape.
