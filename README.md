# Finance Tracker

A personal, offline-first expense tracker for Android, built with Expo (SDK 57), React Native and SQLite.
Everything is stored on the phone: there is no server, no account and no bank connection. You type entries in
(only the amount is required) and it shows where the money went.

## Download

**[Get the APK](https://faraxmalik.github.io/Finance-Tracker/)** (or grab `finance-tracker.apk` from the
[latest release](https://github.com/FaraxMalik/Finance-Tracker/releases/latest)) and open it on your Android phone.
It is not on the Play Store, so Android will ask you to allow installing from your browser or Files app.

## Features

- **Home dashboard**: total spent this cycle, split by category (Credit Card / Salary / Others) and by bank, income,
  what is left over, a daily-spending chart and recent entries.
- **Billing cycle from the 5th to the 4th** (configurable). "Start new cycle" saves a report table and zeroes the
  spending and income totals; the card balance and debts carry over.
- **Category and bank are separate**: an expense has a _category_ (what kind of spending) and a _bank_ (which
  account it was paid from): NayaPay, Meezan Bank, Cash, Faysal Bank, SadaPay. Both lists are editable.
- **Credit card screen**: what you owe, the limit and what is available, with three ways the card is used, each with
  its own total: **Online** (a purchase), **Swipe** (card to bank) and **Withdrawal** (card to cash), plus
  **Payments**.
- **Quick add**: saved shortcuts such as Food and Fuel. Tap one, type the amount, save. The date is today unless
  you pick another. Add your own with **+ New**.
- **All entries**: every entry across all cycles, grouped by day. Filter by type, period, category and bank, search,
  and sort. Totals for what is on screen.
- **Debts**: who owes you and whom you owe, with a history per person.
- **Monthly reports** as tables, exportable as CSV, and **backup / restore** to a JSON file.
- **Light, dark or system theme** and three typefaces (Mono, Serif, Classic), all in Settings.

## How money is counted

- **Category** (expenses only): Credit Card, Salary or Others. Untagged entries show as _Uncategorised_.
  Credit Card is credit spending; every other category is debit.
- **Income** (Salary / Project / Other) is tracked separately and is never spending.
- **Card swipe** and **withdrawal** raise what you owe on the card, but only their **fee** counts as spending (under
  Credit Card). A **card payment** lowers what you owe and is a transfer, not spending.
- **Online** is not a separate type: it is an expense filed under the Credit Card category, so an expense entered on
  Home with that category also appears on the Credit screen.
- Amounts are stored as integer paisa, never floats.

## Getting started

Requirements: Node 22.13 or newer (24 recommended) and the **Expo Go** app on an Android phone.

```sh
npm install
npm start          # phone and computer on the same Wi-Fi
npm run phone      # any network (uses a tunnel; slower to start)
```

Scan the QR code with Expo Go. Saving a file updates the app within a second or two. If a change to the database
does not show up, shake the phone and choose **Reload** (or press `r` in the terminal): database upgrades only run
on a full reload. `npm run clean` restarts with a clean cache.

Your data lives in Expo Go's storage on the phone. It is lost if you clear Expo Go's data, so use
**Settings > Export backup** now and then.

`npm run web` opens the same app in a browser with a real SQLite database. It is handy for quick visual checks; Expo
Go is the real thing (the native date picker, haptics and fonts behave differently).

## Scripts

| Command                | What it does                                                          |
| ---------------------- | --------------------------------------------------------------------- |
| `npm start`            | Start the dev server for Expo Go                                      |
| `npm run phone`        | Same, over a tunnel (works on any network)                            |
| `npm run web`          | Run in a browser                                                      |
| `npm run typecheck`    | TypeScript, strict mode                                               |
| `npm run lint`         | ESLint (`eslint-config-expo`)                                         |
| `npm run format`       | Format with Prettier (`npm run format:check` only reports)            |
| `npm test`             | Database, money-rule and filter tests (see below)                     |
| `npm run check`        | Type-check + lint + format check + tests, the same as CI              |

## Project structure

```
src/
  app/            screens (Expo Router). (tabs) = Home, Credit, Debts, History;
                  add, quick, quick-edit, debt-entry, settings, all, cycle/[id], person/[id]
  components/     shared UI (ui.tsx), charts, rows, tab bar, date chips, category and bank lists
  constants/      colour palettes, fonts, spacing
  db/             schema.ts (versioned migrations) and queries.ts (every SQL query)
  hooks/          theme and typeface, data loading on focus
  lib/            money, dates, cycle maths, All-entries filtering (ledger.ts), CSV/backup export
  dev/            demo data for the browser preview only (not in the app bundle)
tests/            logic tests
plugins/          Expo config plugin that signs release builds with our own key
scripts/          generate-icons.mjs (re-renders the icon and splash images)
docs/             the download website (GitHub Pages)
.github/          CI checks, APK build/release and website deployment workflows
```

## Database and migrations

The schema is versioned with SQLite's `PRAGMA user_version` and upgraded by `migrate()` in
[`src/db/schema.ts`](src/db/schema.ts) each time the app opens the database, so an existing phone upgrades in place
without losing data. To change the schema:

1. Add an `if (version < N)` block to `migrate()` (inside a transaction).
2. Bump `SCHEMA_VERSION` to `N`. The root layout uses it as the database provider's key, and a test checks that it
   matches what `migrate()` really produces.
3. Add a test that upgrades an older database and checks nothing is lost.

## Testing

`npm test` runs the app's real query code against Node's built-in SQLite through a small adapter, so no phone or
emulator is needed. It covers the migrations (including upgrading from every earlier version), the money rules, card
balances, cycles, backup and restore, quick adds and the All-entries filters.

## Releasing an APK

APKs are built on GitHub's servers (no Android tooling needed on your machine) and attached to a GitHub Release. The
download website links to the newest one.

**One-time setup**

1. Create a signing key and keep it safe (apps signed with a different key cannot update over an installed one, and
   Android will make users uninstall first, which deletes their data):

   ```sh
   openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=Finance Tracker" \
     -keyout key.pem -out cert.pem
   openssl pkcs12 -export -inkey key.pem -in cert.pem -name financetracker -out finance-tracker.p12
   ```

2. Add three repository secrets (Settings > Secrets and variables > Actions):
   `ANDROID_KEYSTORE_BASE64` (`base64 -i finance-tracker.p12`), `ANDROID_KEYSTORE_PASSWORD` and
   `ANDROID_KEY_ALIAS` (`financetracker`).
3. Settings > Pages > Source: **GitHub Actions**, so the website is published from `docs/`.

**Each release**

```sh
git tag v1.0.1 && git push origin v1.0.1
```

The **Build APK** workflow builds, checks the APK is signed with your key, and publishes the Release with
`finance-tracker.apk` and its SHA-256 checksum. You can also run it by hand from the Actions tab (the APK is then
attached to the run instead of a Release). Each build gets a higher `versionCode` so it installs over the previous one.

`eas.json` is also included if you prefer Expo's cloud builds: `eas build --platform android --profile preview`.

The launcher icon, adaptive-icon layers, splash images and favicon are generated by `scripts/generate-icons.mjs`
(a serif F over a ledger "total line"); edit it and re-run it to change them.

## Notes

- No licence has been chosen yet; add a `LICENSE` file when you decide how the code may be used.
- The app id is `com.faraz.financetracker` (change it in `app.json` before publishing anywhere that cares).
- `AGENTS.md` / `CLAUDE.md` come with the Expo template and tell coding agents to read the Expo SDK 57 docs first.
