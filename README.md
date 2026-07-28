# Jack's Pokémon Collection

Scan a Pokémon card with your phone camera. It identifies the card, looks up
what it is actually worth, and adds it to the collection. Duplicates fold into
a copy count rather than filling the list with repeats.

## Running it

```bash
npm install
cp .env.example .env       # add GEMINI_API_KEY and a Postgres URL
npm start                  # http://localhost:3000
```

Open it on a phone and add it to the home screen — it installs as a standalone
app with the scanner one tap away.

## Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (`POSTGRES_URL` also accepted) |
| `GEMINI_API_KEY` | yes | Card identification from photos. Without it, scanning is disabled |
| `POKEMON_TCG_KEY` | recommended | Raises the Pokémon TCG API rate limit. Works without a key, slower |
| `SCRYDEX_API_KEY` + `SCRYDEX_TEAM_ID` | optional | An extra price source |
| `JUSTTCG_API_KEY` | optional | An extra price source |
| `PORT` | no | Defaults to 3000 |
| `CRON_SECRET` | no | Guards `/api/cron/refresh-prices` |

**More price sources means better prices.** Each card's price is the median of
the sources that agree, so with only one source live every price is a single
opinion — the app says so, per card, rather than pretending otherwise.

## How pricing works

The AI identifies the card. It never prices it — asked for a dollar value a
language model will produce a confident, plausible, wrong one. Prices come only
from marketplace APIs, and a card that cannot be matched stays unpriced.

For each card:

1. Every source is queried in parallel and returns *quotes*, each tagged with
   its marketplace, currency, and which printing it describes.
2. Quotes are converted to USD. EUR Cardmarket prices are never compared with
   USD TCGplayer prices as though both were dollars.
3. TCGplayer (the US market) wins when present; Cardmarket is the fallback.
4. Within that, quotes matching the card's actual printing — holo, reverse
   holo, 1st edition, plain — beat quotes that do not. When the printing has to
   be guessed, the *cheapest* variant is used, never the dearest.
5. Outliers more than 4× from the consensus are dropped, and the price is the
   median of what remains.

Every card records its confidence, the marketplace and variant used, the spread
across sources, and each individual quote. Open a card to see all of it.

Quotes are Near Mint. Each copy you own is discounted for its own condition
(LP 85%, MP 70%, HP 50%, Damaged 35%), so three played copies are not valued as
three mint ones. Graded slabs are a different market that this does not track —
set a value by hand on that copy instead.

## Duplicates

A row in `portfolio_cards` is a *printing*; `card_copies` holds each physical
card, with its own condition, grade, purchase price and photo. Scanning a card
already held adds a copy rather than a second row.

Cards added before this model existed may sit in separate rows. Settings →
*Merge duplicate cards* shows exactly what would change and does nothing until
confirmed; the merge is transactional and moves every copy and price point onto
the surviving row.

## Cards that cannot be confirmed

If the card databases cannot confirm a scan, it is saved anyway under **Needs
review**, unpriced, with the AI's best guess intact. A photo you took never
disappears, and no price is invented for a card that could not be identified.
Correct the name, set or printing and it prices itself.

## Tests

```bash
npm test                                       # unit tests, no services needed
TEST_DATABASE_URL=postgres://…      npm test   # adds integration tests
TEST_BASE_URL=http://localhost:3000 npm test   # adds browser tests
```

- `test/pricing.test.js` — the pricing and identity rules, including every
  mispricing this codebase has previously had.
- `test/api.integration.test.js` — migrations, the copies model, value maths
  and duplicate merging against a real Postgres.
- `test/browser.test.js` — the camera capture geometry.
