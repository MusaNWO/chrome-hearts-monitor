# Local testing (no Telegram / no Railway)

Branch: `feature/auto-book`

## What this does

- Monitors locations (default: Miami + NY West Village)
- **Auto-book** on Sun / Wed / Thu / Fri at **11:00, 12:00, 13:00 ET** — books every matching slot with random guest details
- For other slots: prints a numbered menu — type the number + Enter to book
- After a booking, prints **Store / Date / Time / Status / Manage URL**

## Setup

```bash
cd "/Users/musa/Downloads/Monitor 24:7"
npm install
npx playwright install chromium
```

## Dry-run (safe — does not create real bookings)

```bash
# One-shot book against Las Vegas (usually has open slots)
DRY_RUN=1 node book.js --location lasvegas-fontaine

# Live monitor menu (Las Vegas for easier testing)
DRY_RUN=1 LOCATION_IDS=lasvegas-fontaine node monitor.js
```

## Real booking

Waitwhile requires reCAPTCHA. Browser-generated tokens are often rejected.

1. Create a free account at [capsolver.com](https://www.capsolver.com/)
2. Put the key in `.env`:

```
CAPSOLVER_API_KEY=your_key_here
```

3. Run:

```bash
node book.js --location lasvegas-fontaine
# or
LOCATION_IDS=lasvegas-fontaine node monitor.js
```

## Miami + NY (production targets)

```bash
LOCATION_IDS=chromeheartsmiami,chromehearts DRY_RUN=1 node monitor.js
```

## Env flags

| Var | Meaning |
|---|---|
| `LOCATION_IDS` | Comma-separated Waitwhile short names |
| `DRY_RUN=1` | Simulate booking, still prints manage URL shape |
| `AUTO_BOOK_ENABLED=0` | Disable auto-book (manual menu only) |
| `AUTO_BOOK_DAYS` | Default `0,3,4,5` (Sun,Wed,Thu,Fri) |
| `AUTO_BOOK_HOURS_ET` | Default `11,12,13` |
| `CAPSOLVER_API_KEY` | Needed for real bookings |
| `HEADED=1` | Show Chromium window |

## Next (later)

When local booking works end-to-end with CapSolver:

1. Add Telegram BOOK button + new bot
2. Deploy this branch to Railway
