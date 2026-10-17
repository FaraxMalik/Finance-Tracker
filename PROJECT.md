# Finance Tracker: project overview

How the app works inside: what it is, how the code is laid out, the data model and the money rules every screen
depends on. For features, setup, scripts and releasing, see [README.md](README.md).

## What it is

A personal expense tracker for one person's Android phone. Entries are typed in by hand (only the amount is
required), stored in a local SQLite database, and shown as totals per billing cycle. There is no server, no account,
no bank sync and no network call. Currency is PKR.

It is built around how its owner actually uses money:

- A **billing cycle from the 5th to the 4th** (the start day is a setting), not calendar months.
- Spending is split two ways at once: by **category** (Credit Card / Salary / Others, editable) and by **bank**
  (NayaPay, Meezan Bank, Cash, Faysal Bank, SadaPay, editable). These are separate fields.
- A **credit card** used three ways: **POS** and **Online** purchases, and **Credit → Debit** (swiped on a machine
  so the money lands in the bank, then spent from there). The card bill is paid later from salary.
- **Paying for friends** and tracking **debts** both ways.

|                 |                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Platform        | Android only (APK sideloaded, min Android 7). Runs in Expo Go during development.                         |
| Stack           | Expo SDK 57, React Native 0.86, React 19 (React Compiler on), Expo Router, expo-sqlite, TypeScript strict |
| App id          | `com.faraz.financetracker`                                                                                |
| Repo            | https://github.com/FaraxMalik/Finance-Tracker (git root is `app/`)                                        |
| Website         | https://faraxmalik.github.io/Finance-Tracker/ (from `docs/`)                                              |
| Current version | 1.3.0 (`app.json`), tagged `v1.3.0` at `HEAD`                                                             |

## Code map

```
src/
  app/                Expo Router screens
    _layout.tsx       root: fonts, SQLiteProvider (runs migrate), theme provider, stack + modals
    (tabs)/           bottom tabs: index (Home), credit, debts, history
    add.tsx           add/edit any entry (the largest screen); "Places" chips, paid-for-others, tags
    all.tsx           every entry across all cycles, with filters, search and multi-select
    cycle/[id].tsx    one cycle as a searchable list with totals and that cycle's debts
    person/[id].tsx   one person's debt history
    debt-entry.tsx    add a debt entry (modal)
    quick-edit.tsx    edit a saved Place (modal)
    settings.tsx      categories, banks, places, cycle day, card limit, theme, typeface, backup/CSV
  components/         ui.tsx (shared primitives), charts, tx-row, tab-bar, icons, pickers
  constants/theme.ts  light + dark palettes, font sets, spacing
  db/schema.ts        versioned migrations (PRAGMA user_version), seed data
  db/queries.ts       every SQL query, the money rules, backup/restore
  hooks/              use-theme (theme + typeface, saved in settings), use-focus-load
  lib/                pure logic: money, dates, cycle, ledger (All-entries filters), split, export, labels
  dev/seed.ts         demo data for the browser preview only
tests/logic.test.ts   runs the real queries against Node's built-in SQLite (47 tests)
plugins/              config plugin that signs release builds with the owner's key
scripts/              generate-icons.mjs (icon, adaptive icon, splash, favicon)
docs/                 download website (GitHub Pages)
.github/workflows/    ci.yml (npm run check), build-apk.yml (on v* tags), pages.yml
```

**Data flow.** There is no state library. Each screen loads what it needs with `useFocusLoad(loader)`
([src/hooks/use-focus-load.ts](src/hooks/use-focus-load.ts)), which re-runs the loader every time the screen gains
focus, so totals are fresh after editing on another screen. All reads and writes go through functions in
[src/db/queries.ts](src/db/queries.ts); screens never write SQL.

**Theme.** Colours are read through `useColors()` / `useStyles()`, never imported directly, because the palette
changes with the light/dark/system setting. Theme and typeface choices are stored in the `settings` table but are
deliberately left out of backups (they belong to the phone, not the data).

## Data model

All money is stored as **integer paisa** (1 PKR = 100 paisa), never floats ([src/lib/money.ts](src/lib/money.ts)).

| Table              | Holds                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings`         | key/value: `cycle_start_day`, `credit_limit`, `card_opening_balance`, `theme_mode`, `font_choice`                                                                                             |
| `accounts`         | **categories** (the name is historical). `kind` is `credit` or `debit`. `card_cash = 1` marks Credit → Debit                                                                                  |
| `banks`            | banks and wallets the money moved through                                                                                                                                                     |
| `cycles`           | one row per billing cycle; the open one has `closed_at IS NULL`. Closing stores snapshots of card owed and debts                                                                              |
| `transactions`     | every entry: `type`, `amount`, `date`, `account_id` (category), `bank_id`, `place`, `source`, `note`, `channel` (`'pos'` on a POS purchase). `fee` is legacy and ignored                      |
| `quick_expenses`   | saved **Places** (Food, Fuel, ...) with a default category and bank                                                                                                                           |
| `people`           | friends / people in debts                                                                                                                                                                     |
| `debt_entries`     | `lent`, `borrowed`, `got_back`, `paid_back`. `tx_id` links a friend's share to the entry it came from; `settlement_id` puts it in a settled stretch                                           |
| `debt_settlements` | one row per stretch of one `side` ('they' or 'me') that ended square (`settled_on`). Rebuilt from the entries by `settleDebts` ([src/db/settle.ts](src/db/settle.ts)) after every debt change |
| `tags`, `tx_tags`  | user labels (a trip, office, ...) on any number of entries                                                                                                                                    |

Transaction types:

| `type`         | Meaning                                                                                                         | Category | Bank                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- | -------- | -------------------------- |
| `expense`      | money spent. With the Credit Card category it is a card purchase: **POS** if `channel = 'pos'`, else **Online** | yes      | yes, except card purchases |
| `income`       | Salary / Project / Other (kept in `source`)                                                                     | no       | optional                   |
| `card_swipe`   | **Credit → Debit**: card → bank. Raises card owed, never spending, hidden from Home and entry lists             | no       | no                         |
| `card_payment` | paying the card bill. A transfer, never spending                                                                | no       | no                         |

### Migrations

The schema is at **version 10** (`SCHEMA_VERSION` in [src/db/schema.ts](src/db/schema.ts)). `migrate()` runs on every
open and upgrades step by step: v1 base tables, v2 default categories, v3 banks split out of categories, v4 adds
`card_withdrawal`, v5 places, v6 `debt_entries.tx_id`, v7 tags, v8 POS (`channel`), the Credit → Debit category
(`card_cash`) and withdrawals folded into `card_swipe`, v9 settled debt history, v10 settling "they owe me" and "I
owe them" as two separate histories instead of one net figure. The root layout keys the `SQLiteProvider` on
`SCHEMA_VERSION`, so a new migration runs even after a live reload. The README describes how to add one.

Backups are JSON (format version 7) and older versions 1 to 6 still restore; a restore runs the same clean-ups as
the upgrades (`ensureCardCashCategory`, `settleDebts`).

## Money rules

These live in [src/db/queries.ts](src/db/queries.ts) (`getCycleTotals`, `getCardSummary`) and are what every total
on every screen is built on. Tests cover them.

- **My share.** For an expense, your own part is `amount - (sum of linked lent debts)`. In SQL this is `MINE_SQL`.
  Category, bank and daily totals all use your share.
- **Debit spent** = your share of expenses whose category is `debit` or that have no category.
- **Credit spent** = your share of expenses in a credit category: Credit Card (POS + Online) and Credit → Debit.
- **My spending** = debit spent + credit spent.
- **Total paid** = my spending + friends' shares (everything that actually left your bank or card).
- **Never spending:** income, card payments and Credit → Debit moves. Fees are not tracked (old ones are ignored).
- **Card owed** is all-time, not per cycle: opening balance + POS and Online purchases (full amount) + Credit → Debit
  moves − payments. Expenses under the Credit → Debit category never add to it (the move already did).
  **Available** = limit − owed.
- **Starting a new cycle** closes the open cycle (saving card owed and debt totals as snapshots) and opens a new one
  starting today. Spending and income start again from zero; the card balance and debts carry over.
- **Paying for friends** works on expenses (a Credit → Debit move saved with shares before v8 keeps them). The entry keeps the full amount; each friend's
  share becomes a `lent` debt with `tx_id` set. Shares cannot add up to more than the amount. Deleting the entry
  deletes its shares. Linked debts are edited through the entry, not on the person page.
- **Income** is only income entries. Home's **With credit** tab adds this cycle's Credit → Debit to it (and to
  Left over) for display only; the choice is saved as the `income_view` setting.
- **Debt balances:** `they_owe` (lent − got back) and `i_owe` (borrowed − paid back) are two fully independent
  totals per person, each clamped at 0 and never moved onto the other — lending for one thing and borrowing for
  another are different arrangements, so an overpayment on one side is just clamped, not shifted across. `balance`
  (`they_owe - i_owe`) is only a display figure; nothing is filtered or settled by it. The Debts list and its
  per-tab totals both sum the same `they_owe`/`i_owe` values, so a person can appear on both tabs at once and the
  list always adds up to the header.
- **Settled history, per side:** `settleDebts` ([src/db/settle.ts](src/db/settle.ts)) processes "they" (lent/got
  back) and "me" (borrowed/paid back) as two independent streams. Going through one side's entries by date, each
  day its running total ends at zero closes a settled stretch on that side; the other side keeps going regardless.
  It is recomputed from the entries every time, so backdated entries and edits always land right. **Settle up**
  (`settleUp(db, personId, side)`) adds the closing `got_back` / `paid_back` entry for just that side's open
  amount, dated today.
- **Tags** have their own totals but never change the main ones.

## Design direction

The owner's explicit preference: simple, flat and quiet, not "AI-looking". Paper-white background (near-black in dark
mode), ink text, hairline borders, muted category colours, flat solid primary buttons. No gradients, glows, tinted
cards or decorative shapes. Four typefaces are selectable in Settings: DM Sans (default), Mono (Geist Mono), Serif
(Source Serif 4) and Classic (Fraunces + Inter).

Entry screens put a ✓ save button in the header because the keyboard hides the bottom Save button.

## Working on it

- Develop live in **Expo Go** on the phone (`npm start` or `npm run phone`). `npm run web` runs the same app in a
  browser for quick visual checks.
- `npm run check` = typecheck + lint + Prettier check + tests; CI runs the same.
- Do not add anything that needs a native rebuild (custom native modules, a dev client), because Expo Go must keep
  working.
- Read the Expo SDK 57 docs before writing Expo code (see [AGENTS.md](AGENTS.md)).
- Do not run `expo prebuild` locally: it rewrites `package.json` scripts and creates `android/`. APKs are built only
  by the GitHub workflow.
- Release: bump `version` in `app.json`, commit, push a `vX.Y.Z` tag. The workflow builds, signs and publishes the
  APK. The signing key lives outside the repo.

## Known gaps

- The APK has not been confirmed on a real phone from this machine (no Android tooling here); day-to-day use is
  through Expo Go.
- The app declares `INTERNET` but never uses it; blocking it would make "offline only" verifiable.
- No licence has been chosen.
- Unused font families are still loaded in `src/app/_layout.tsx`; they can be removed once the typeface choice is
  settled.
