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
| `EBAY_APP_ID` + `EBAY_CERT_ID` | recommended | Live listings and auction bids — the only source that sees what buyers are doing |
| `SCRYDEX_API_KEY` + `SCRYDEX_TEAM_ID` | optional | An extra price source |
| `JUSTTCG_API_KEY` | optional | An extra price source |
| `PRICE_REFRESH_DAYS` | no | How often every card is re-checked. Defaults to 1 (daily) |
| `PORT` | no | Defaults to 3000 |
| `CRON_SECRET` | no | Guards `/api/cron/refresh-prices` |

**More price sources means better prices.** Each card's price is the median of
the sources that agree, so with only one source live every price is a single
opinion — the app says so, per card, rather than pretending otherwise.

## Keeping prices current

The server re-checks every card on a schedule — daily by default, tunable with
`PRICE_REFRESH_DAYS`. The time of the last completed refresh is stored in the
database, not held in memory, so a deploy or restart cannot lose the schedule:
on restart it works out whether a refresh is due and runs it if so.

This needs a host that runs a process. It will not work on a static host such
as GitHub Pages, which serves files and nothing else — there would be no server
to check prices while the app is closed, and nowhere to store the collection.

On a host that sleeps when idle, the in-process timer cannot fire, because
there is no process. Drive it from outside instead: point any scheduler at
`GET /api/cron/refresh-prices` with `Authorization: Bearer $CRON_SECRET`. That
endpoint respects the schedule, so calling it every ten minutes is safe — it
starts a refresh only when one is actually due, and `?force=1` overrides. The
same request also wakes a sleeping service, so one mechanism covers both.

## Deploying to Render + Neon

`render.yaml` is a Render blueprint; the comments in it explain each variable.

1. **Neon** — create a project, copy the **pooled** connection string (the host
   containing `-pooler`). The app opens a connection pool, and Neon's direct
   endpoint allows far fewer concurrent connections. Note the region.
2. **Render** — New → Blueprint, point it at this repo. Set the region to match
   Neon. Fill in the secrets marked `sync: false`; `JWT_SECRET` and
   `CRON_SECRET` are generated for you.
3. **Migrate the data** — from a machine with both URLs to hand:

   ```bash
   pg_dump --no-owner --no-acl "$OLD_DATABASE_URL" > collection.sql
   psql "$NEW_DATABASE_URL" < collection.sql
   ```

   The app also creates its own schema on first boot, so an empty Neon database
   is a valid starting point if you would rather re-scan than migrate.
4. **Keep it awake** — add a cron-job.org (or GitHub Actions) job hitting
   `/api/cron/refresh-prices` every 10 minutes with the bearer token. Render's
   free tier spins down after 15 minutes idle and takes about a minute to wake,
   and 750 instance-hours a month is 31.25 days, so staying up continuously
   still fits.
5. **Point the domain** — add `jackspokemon.com` under the service's Custom
   Domains and follow the DNS instructions. TLS is issued automatically.

Do not use Render's own free Postgres: it expires 30 days after creation and is
then deleted.

Settings → **Price tracking status** shows which sources are live, when prices
last refreshed, when the next refresh is due, and how many cards carry a
verified price.

## eBay, and what "sold price" actually means here

Every other source reports a catalogue figure. eBay reports what people are
doing, which makes it the most valuable signal and also the easiest to get
wrong: a search for one card returns graded slabs, bulk lots, proxies, sealed
product and other languages alongside the card itself, and averaging that
produces a number with no meaning.

So `lib/ebay-comps.js` throws most of it away. A listing has to name the card
*and* its number, be raw when the copy is raw and graded to the same grade when
it is not, match on language and on 1st Edition, and not be a lot, a proxy, or
sealed product. The rejections are counted and reported — "48 listings, 41
rejected as graded slabs" is itself a true thing about that card's market.

**Completed sales are not available.** eBay's Marketplace Insights API is the
sole first-party source of sold data and is a Limited Release closed to new
applicants; the Finding API's `findCompletedItems` was decommissioned in
February 2025. Anyone claiming to read eBay sold comps through the public API is
scraping. What the Browse API does expose is two different things, and the app
keeps them apart:

1. **Live auctions carrying bids.** A bid is a buyer committing real money —
   revealed willingness to pay rather than a seller's hope. This is the closest
   thing to sold data obtainable legitimately, and when bids exist they decide
   the number.
2. **Buy-It-Now asking prices.** Sellers list above what cards clear at, so the
   middle of that distribution is systematically high. The app takes the 30th
   percentile, and only when there are no bids to go on.

Each price records which of the two it came from, so the number on screen can
say whether it rests on buyers or on sellers.

## How pricing works

The AI identifies the card. It never prices it — asked for a dollar value a
language model will produce a confident, plausible, wrong one. Prices come only
from marketplace APIs, and a card that cannot be matched stays unpriced.

For each card:

1. Every source is queried in parallel and returns *quotes*, each tagged with
   its marketplace, currency, and which printing it describes.
2. Quotes are converted to USD. EUR Cardmarket prices are never compared with
   USD TCGplayer prices as though both were dollars.
3. TCGplayer and eBay both describe the US market and are used together;
   Cardmarket is the fallback when neither has a quote. A catalogue price and
   live eBay bids agreeing is the strongest corroboration available, and
   confidence rises accordingly.
4. Within that, quotes matching the card's actual printing — holo, reverse
   holo, 1st edition, plain — beat quotes that do not. When the printing has to
   be guessed, the *cheapest* variant is used, never the dearest.
5. Outliers more than 4× from the consensus are dropped, and the price is the
   median of what remains.

Every card records its confidence, the marketplace and variant used, the spread
across sources, and each individual quote. Open a card to see all of it.

Two things lower confidence rather than being hidden: a printing worked out from
the card's rarity because the foil was not readable in the photo, and a price
quoted off current listings because nothing has sold recently.

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

If the card databases cannot confirm a scan, it is saved anyway under
**Pending**, unpriced, with the AI's best guess intact. A photo you took never
disappears, and no price is invented for a card that could not be identified.

Identification uses what is *printed* on the card, in this order of trust: the
name, the card number, and the number's denominator — "093/132" means the card
came out of a set of 132, which is a far better set discriminator than a set
name the model inferred from a symbol a few pixels across. A guessed set name
can raise confidence but never decides a match, and a candidate whose set is a
different size is ruled out however well it otherwise scores.

Nothing here is a task for you. Every scheduled refresh retries the pending
cards, so the list drains itself as the card databases gain sets; correcting a
name or number just settles it sooner.

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
