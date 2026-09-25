# Round 1: 4 lanes on the review follow-ups patch (2026-09-25)

Lanes asked, and what each could see:

| Lane | Route | Saw | Result |
|---|---|---|---|
| DeepSeek V4.1 Flash | `council-ccx.sh deepseek-flash` | brief + diff + context excerpt + test harness (its path reads were denied, so citations are to the excerpt) | `review_deepseek-flash.md`, 5.6 KB: the check re-route makes the Auto-BTCpay dialog unreachable; a corrupted vault record routes to the create-wallet flow |
| SWE-2 max | `council-devin.sh swe-2-max` | same files plus settings.html, read by path | `review_devin-swe-2-max.md`, 6.5 KB: the same two, plus the third stash writer in order.html |
| GPT-6 Luna | Kagi `gpt-6-luna` with attachments (`gpt-5-6-luna` is retired) | same files | `review_gpt-6-luna.md`, 5.4 KB: decryptWallet assigns state before parsing keys; the hot-swap window passes every `ss.wallet` gate |
| Gemini | `council-gemini.sh` (agyx, repo dir) | full repo by absolute path | `review_gemini-agyx.md`, 7.5 KB: autoBtcpay cleanup can wipe a session unlocked mid-transaction |

Codex via ccx (`gpt-5.6-terra`) was unavailable: ChatGPT free-plan usage limit. Kagi's GPT-6 Luna took the seat.

---

## A. Verified defects (read against the code, fixed, and covered in tools/test-wallet-wiring.cjs)

**A1: the Auto-BTCpay dialog became unreachable.** *DeepSeek, SWE-2.* `checkBtcpayAuth` as the success callback of the unlock dialog always runs with `ss.wallet` set, so it always took the silent-stash branch and `dialogEnableBtcpay`, with the disclosure paragraph, could never open. Fix: the unlock dialog gained an `onCancel` hook, and `initWallet` passes the check on both answers; the disclosure moved to the opt-in point, the order form's confirmation checkbox, and stays in the dialog as well. Test: `checkBtcpayAuth` stashes when open, asks when locked; `initWallet` passes both hooks.

**A2: a third stash writer, and it stashed for manual orders.** *SWE-2.* `html/exchange/order.html` stashed `btcpayWallet` for every BTC give order regardless of the auto-pay choice and never `btcpayKeys`. Fix: stash only for an auto-pay order, keys with the seed. Not unit-testable (page script); covered by the runtime pass.

**A3: a corrupted vault record reached the create-wallet flow.** *DeepSeek, SWE-2, Luna.* `initWallet` judged presence by `readVault()`, which returns null for an unparseable record, so a damaged vault showed the welcome screen, where creating a wallet overwrites it. Fix: presence judged on the raw `walletVault` record at launch and on the lock icon; the unlock dialog names a damaged record. Test: `initWallet` routes a truncated record to the unlock dialog; the dialog reports the damage and leaves the record untouched.

**A4: partial unlock on a keys blob that decrypts but is not JSON.** *Luna.* `decryptWallet` set `FW.WALLET_ENCKEY` and `ss.wallet` before `JSON.parse` of the keys. Fix: decode everything first. Test: such a vault returns false with no state left behind.

**A5: the key stash never refreshed.** *DeepSeek.* A key imported after auto-pay was enabled never reached `btcpayKeys`. Fix: `writeVault` refreshes a live stash. Test: persist after import updates the stash.

**A6: the hot-swap cleanup could wipe a session the user had unlocked meanwhile.** *Gemini.* `autoBtcpay`'s completion handler removed `ss.wallet` and the keys whenever it had hot-swapped, even if the user unlocked during the network round trip. Fix: the cleanup is skipped when `FW.WALLET_ENCKEY` is set. Not unit-testable here (async); reasoning is in the comment.

**A7: "Disable" did not disable.** *DeepSeek.* The dialog's Disable button only closed the dialog; every flag stayed at 1 and the prompt returned at the next launch. Fix: `disableBtcpayAutopay` zeroes every order's flag, saves, and drops the stash. Test: flags, saved record, stash.

**A8: a damaged vault with the legacy backup still on disk.** *All four lanes.* Migration keeps the legacy blobs until the first successful v2 unlock; a vault damaged in that window was reported with "restore from your passphrase", whose only UI route (Logout) deletes the backup. Fix (Ben's decision, option a): `recoverVaultFromV1Backup` rebuilds the vault from the backup through the shared migration core, only on a proven password: the v2 verifier accepted it, or it opens the legacy record itself. Test: both legacy kinds, a wrong password refused, an unproven password refused for the convenience kind, the dialog path, and the no-backup path.

**Password change requires the current password.** *Gemini, Luna for; DeepSeek, SWE-2 "harmless".* Added: the verifier checks it (so a kept short legacy password works as the current one), and it closes the hot-swap window for that path. Test: wrong current, weak new, success.

**Exonerated:**
- "A wrong password drops a URI action" (DeepSeek Q2): the unlock dialog stays open on a wrong password, so the retry happens in place; only Cancel drops it, which is correct.
- "The change dialog rejects a short migrated password" (Gemini): the field it measured is the new password; the current-password field is verifier-checked only. Covered by the dialog test.
- "sessionStorage survives a reload, so the stash outlives its stated lifecycle" (DeepSeek): by design of the stash; the launch comment already says so, and the disclosure text says session memory.

## B. Where the lanes converge

**B1: the harness did not run the dialogs** (4 of 4). A re-introduced length check on unlock would have passed all 25 checks. Fixed: `BootstrapDialog.show` is captured and `$` stubbed, so `dialogPassword`, `dialogMigrate` and `dialogEnableBtcpay` handlers run for real on a 7-character migrated password.

**B2: the damaged-vault state** (4 of 4). See A8.

### Tensions to resolve

- Current password on change: two lanes for, two "harmless". Applied; the cost is one field.

## C. Performance

The wiring suite now derives many PBKDF2 keys (310k iterations each, ~1.6 s in pure JS); the whole run is over two minutes. Acceptable for a pre-merge check; not a per-save watch.

## D. What each lane got wrong

- Gemini's Issue 1 (change dialog rejects a short current password) was hypothetical and did not hold.
- SWE-2 opened with 85 bytes of narration and took ~9 minutes; the reply was worth the wait.
- Kagi `gpt-5-6-luna` is retired (HTTP 400): the council skill's fallback line needs `gpt-6-luna`.

## E. Not applied (pre-existing upstream behaviour, outside this patch)

- A queued manual BTCpay match while locked opens a "Wallet Locked!" notice over the launch dialog on every 60 s tick (SWE-2, Gemini, Luna).
- Every `dialogCheckLocked` gate passes during `autoBtcpay`'s hot-swap window (Luna, SWE-2); the change-password path is now protected by the current-password check, the others are unchanged.
