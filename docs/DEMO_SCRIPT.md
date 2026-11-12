# Demo video script (under 3 minutes)

Target length **2:50**. Narration is about 150 words per minute; the written narration below totals about 360 words (about 2:25 of speech). Record at 1920x1080 (or 1440x900), browser zoom 100%, one browser window.

## Before you record (pre-flight, 10 minutes)

1. **Wake the hosted instance.** Open `https://purser-pf93.onrender.com/health` in a tab and wait for `{"status":"ok"...}`. The free instance sleeps when idle; the first request can take up to a minute. Keep that tab; reload it once just before recording.
2. **Check the sandbox Business balance** (PayPal developer dashboard, Sandbox accounts) is comfortably above 500 USD. The video moves about $125 of sandbox money (D $120 and C's refunds of $3).
3. **Tabs, in this order:**
   1. `https://purser-pf93.onrender.com/` (landing page). Open it in a fresh private window first so the intro loader plays once, then keep it.
   2. `https://purser-pf93.onrender.com/app`, signed in with the **admin token** (you want real PayPal for scenario D and the real webhook). Go to **Attack Lab**.
   3. A second private window with `/app` signed out, ready for **Try the demo** (your fallback, see below).
4. In the admin tab press **Reset demo** (Attack Lab > Reset demo). It restores the seeded policy, clears attempts, unfreezes the agent. Confirm the toast says "Demo reset".
5. Confirm webhooks are on: in the admin tab, Reconciliation page loads without an error. (`PAYPAL_WEBHOOK_ID` is set on Render; the webhook arrives a few seconds to a minute after a payout.)
6. Turn off OS and browser notifications, close other apps, hide bookmarks bar, mute the mic until you start.
7. Do one dry run of the click path below with the demo window (zero money) so the timing is in your hands.

**Fallback if PayPal or the network misbehaves:** record the whole video from the **Try the demo** window instead. Everything works the same (scenarios A to D, approvals, kill switch, audit trail); the payout is simulated, so skip the "real webhook" beat and say "in the sandbox" instead of "real". If the AI model is slow, nothing changes: replay uses cached verdicts.

## Script

Times are cumulative. **Click** lines are exact; **Say** lines are the narration.

### 0:00 to 0:20. Hook, landing page

**Show:** landing page hero ("Let your agents spend. Not overspend."). Let the orb loader finish. Slowly scroll to the three problem cards.

**Say:** "AI agents can now pay invoices. That is exactly the problem. One forged footer on a PDF, 'our bank details changed', and your agent happily pays a stranger. Telling the model to be careful is not a control, because the model reading the invoice is the one being fooled. Purser is the control that sits outside the model."

### 0:20 to 0:35. The pipeline

**Click:** scroll to **How a payment is judged**; scroll slowly so steps 1 to 4 highlight.

**Say:** "Every payment an agent attempts passes seven checks: kill switch, hard rules in plain code, payee trust checks, an AI reviewer that can only make a decision stricter, then a human, then PayPal, then reconciliation."

### 0:35 to 1:15. Scenario A: the poisoned invoice

**Click:** top-right **Open the dashboard** > you are in `/app` (admin tab) > **Attack Lab** > card **A, Poisoned invoice** > **Run scenario A**. When it finishes, point at the right panel: the **ESCALATE** chip, the **look-alike payee** and **vendor mismatch** chips, and the AI line. Then press **Review approval** > on the Approvals page point at "Purser flagged" and the AI reviewer text > press **Deny**.

**Say:** "Scenario A. The agent reads a normal-looking invoice and tries to pay a look-alike of our real vendor: one character swapped. Purser does not trust the agent's story. The payee isn't on the allowlist, and the trust checks flag a look-alike address, a vendor mismatch and a recently changed payee. The AI reviewer agrees and writes its reason. The payout is held, nothing has moved, and a human decides. I deny it. No money left the account."

### 1:15 to 1:45. Scenario C: the runaway loop and the kill switch

**Click:** **Attack Lab** > card **C, Runaway loop** > **Run scenario C**. Point at the first allowed $1 refunds, then the **DENY velocity** rows, then the red **All agents are frozen** banner. Click **Unfreeze** in the banner (or press **KILL SWITCH** in the header, read the confirm text, **Freeze all agents**, then **Unfreeze**).

**Say:** "Scenario C, a bug that refunds the same payment over and over. The first refunds go through; then the velocity rule denies the loop, and after repeated denies the circuit breaker freezes the agent. You can also freeze everything yourself with the kill switch. One click, every tool call is denied until you unfreeze."

### 1:45 to 2:10. Scenario D: the happy path, a real sandbox payout and a real signed webhook

**Click:** **Attack Lab** > card **D, Happy path** (leave **Reset state first** checked; this also unfreezes) > **Run scenario D** > point at **ALLOW** and the payout > open **Reconciliation** > **Run now** if the grid is empty > point at the green **matched** count and the `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` row with source **webhook**.

**Say:** "Scenario D is the normal case: a legitimate $120 invoice from an allowlisted vendor. Every check passes and the payout executes against the real PayPal sandbox. Then PayPal calls us back: a real signed webhook, verified through PayPal's signature endpoint, matched to our ledger row. And if money ever moves outside Purser, that shows up here as an unrecorded movement."

### 2:10 to 2:30. Plain-English policies

**Click:** **Policies** > click the example chip "Allow up to $50 a day on office supplies, refunds up to $30, never pay new vendors without asking" > **Compile**. Point at the **Proposal, not applied** badge, the diff table and the amber warnings. Do **not** press Apply (or press **Discard**).

**Say:** "Policies are plain English. I type a sentence and Purser proposes a change: here is the exact diff, and the warnings are honest about what it cannot enforce, like a category limit. It stays a proposal until I press Apply."

### 2:30 to 2:48. The audit trail

**Click:** **Live** > click the **$90 DENY** or the **$120 ALLOW** row to open the drawer. Scroll the drawer: **Decided at**, **Rules hit**, **Trust signals**, **AI reviewer**.

**Say:** "Every decision is explainable: which stage decided, which rules fired, the trust signals with their evidence, the AI's rationale, and what PayPal returned."

### 2:48 to 2:55. Close

**Click:** back to the landing page tab; hero in frame.

**Say:** "Purser: a spending firewall for AI agents on PayPal. Let your agents spend, not overspend."

## Narration word count

About 360 words in total, which is about 2:25 at 150 words per minute, leaving about 25 seconds for clicks and pauses. If you run long, cut the "pipeline" beat (0:20 to 0:35) first, then the audit-trail beat.

## Notes for a clean take

- Scenario B (structuring) moves $180 of real sandbox money in admin mode, so it is not in the recording. If you want to show it, do it in the **Try the demo** window (simulated, zero money).
- If the A scenario shows no "AI" text, you are in the wrong mode: keep **Replay** selected (the scripted agent with cached AI verdicts).
- If Reconciliation shows no webhook row yet, wait 20 to 40 seconds and press **Run now**; you can also run D earlier in the dry run and cut to the finished grid.
- Do not show the admin token. The sign-in field is a password input; paste it off-camera.
- Upload as a public YouTube video, under 3:00, in English, with no third-party music.
