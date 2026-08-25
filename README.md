# Lec Checker

Watches the USC Schedule of Classes for seat openings and sends an **ntfy** push to your iPhone the moment a section you care about has room.

Uses USC's public JSON API (`https://classes.usc.edu/api/Search/Basic`) — no login, no scraping, no myUSC automation.

## How it works

1. GitHub Actions runs `check-usc-seats.mjs` every 5 minutes.
2. The script reads `usc-watch.json`, calls the USC API once per subject, and evaluates each watched **linkCode group** (Lec + Lab + Discussion bundles that USC forces you to enroll in together).
3. A group is "open" iff **every** section in it has at least one seat left. On a `closed → open` transition, the script POSTs to your ntfy topic; your phone lights up.
4. State is stored in `usc-state.json` and committed back to the repo so the next run knows what changed.

Registration is **manual** — you tap the notification, it opens the course page, and you go to WebReg yourself. This bot deliberately does not automate WebReg (that would violate USC's acceptable-use policy).

## Setup

1. **Install ntfy on your iPhone**: [App Store link](https://apps.apple.com/app/ntfy/id1625396347). Pick a private topic name (e.g. `lec-checker-abc123xyz`) and subscribe to it in the app.

2. **Configure what to watch** in `usc-watch.json`:
   ```json
   {
     "notifyMode": "on_open",
     "excludeDenLinkCode": true,
     "watches": [
       { "term": "20263", "subject": "csci", "course": "CSCI 530", "linkCodes": ["A"] }
     ]
   }
   ```

   Field notes:
   - `term`: USC term code — `YYYY` + `1` Spring / `2` Summer / `3` Fall. Fall 2026 = `20263`, Spring 2027 = `20271`.
   - `subject`: subject prefix in lowercase (`csci`, `itp`, `ee`, `busi`, `math`, …).
   - `course`: exact `fullCourseName` from the API (e.g. `CSCI 530`, `ITP 449`).
   - `linkCodes`: which link groups to watch. Live on-campus is usually `A` (some big courses also have `B`); DEN@Viterbi is usually `D`.
   - `excludeDenLinkCode` (default `true`): safety net — skip `D` unless you explicitly ask for it.
   - `notifyMode`:
     - `"on_open"` (default) — ping only on `closed → open` transitions.
     - `"any_change"` — ping whenever the open-seat count changes.
     - `"always_if_open"` — ping every run while the group has seats (noisy).

3. **Try it locally**:
   ```bash
   node check-usc-seats.mjs --dry-run
   ```
   No ntfy sent, no state written. You'll see per-group `OPEN` / `closed` output.

4. **Push to GitHub** and set repo secret `NTFY_TOPIC` = your ntfy topic. Optional:
   - `NTFY_TOKEN` — if using a protected ntfy topic.
   - `NTFY_SERVER` — defaults to `https://ntfy.sh`.

5. **Actions tab → "Notify USC seats" → Run workflow** once manually. First run is a baseline (no notification). After that, cron takes over at `*/5`.

## What `linkCode` means

USC bundles sections you must enroll in together (Lec + Lab, Lec + Discussion, etc.) with a shared `linkCode`. Example — CSCI 530:

| linkCode | Sections | Meaning |
| :--: | --- | --- |
| A | 30015 Lec + 30017 Lab | Live on-campus |
| D | 30014 Lec + 30016 Lab | DEN@Viterbi (online) |

Watching a single section is wrong: the Lec could open while the required Lab stays full. This bot only fires when *every* section in a `linkCode` group has an open seat.

## Adjusting cadence

Default cron is `*/5 * * * *`. GitHub Actions won't honor anything faster than about 5 min reliably (scheduled workflows queue behind other jobs). If you need every-minute polling near add/drop, run the same script from your Mac via `launchd`:

```xml
<!-- ~/Library/LaunchAgents/com.you.lec-checker.plist -->
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.you.lec-checker</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/node</string>
      <string>/Users/you/lec-checker/check-usc-seats.mjs</string>
    </array>
    <key>StartInterval</key><integer>60</integer>
    <key>EnvironmentVariables</key>
    <dict><key>NTFY_TOPIC</key><string>your-topic-here</string></dict>
    <key>StandardOutPath</key><string>/tmp/lec-checker.log</string>
    <key>StandardErrorPath</key><string>/tmp/lec-checker.log</string>
  </dict>
</plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.you.lec-checker.plist`.
