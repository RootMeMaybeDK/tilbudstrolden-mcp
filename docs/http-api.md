# Localhost HTTP API

The HTTP adapter is a separate entrypoint for a future GUI. It calls shared services and safe store getters directly; it never starts MCP, calls MCP tools, or parses Markdown. MCP continues to use `dist/server.js` over stdio.

## Local startup

Use a supported Node runtime (tested on Node 24; the HTTP Node adapter requires at least 18.14.1). From the repository root:

```sh
npm run build
TILBUDSTROLDEN_DATA=/absolute/path/to/tilbudstrolden.json npm run http:start
```

For development use `npm run http:dev` with the same environment variable. Select the existing authoritative datastore explicitly; use a separate temporary datastore for experiments. The HTTP entrypoint refuses a missing or relative path. The underlying store retains its existing first-run behavior if the selected file does not exist.

The listener binds **only to `127.0.0.1:3000`**. `HOST` and `PORT` environment variables do not override this. The app factory (`src/http/app.ts`) opens no listener; `src/http/server.ts` owns the listener. No HTTP daemon, systemd unit, reverse proxy, Nginx configuration, LAN exposure, TLS, authentication, or frontend is included.

Requests must target `127.0.0.1:3000` or `localhost:3000`. If an Origin header is present, it must equal the target origin. Cross-site browser requests are rejected. CORS is not enabled. These guards do **not** authenticate local processes and do not make the API safe for LAN exposure. A future GUI should use a deliberate same-origin setup; arbitrary development-server origins are not permitted.

## Wire conventions

All successful responses and errors are JSON. POST/PATCH bodies must be JSON objects with `Content-Type: application/json`. Send `{}` when all fields are optional. Unknown object keys are stripped by route schemas. Strings are not trimmed unless explicitly documented. Numeric inputs retain the existing service/MCP permissiveness; this adapter does not add domain validation.

```json
{"error":{"code":"INVALID_REQUEST","message":"Request body does not match the route schema."}}
```

| Status | Meaning |
| --- | --- |
| 200 | Successful read, save, delete or computation |
| 400 | `INVALID_JSON`, `INVALID_REQUEST`, or `INVALID_COUNTRY` |
| 403 | `FORBIDDEN_ORIGIN`: target/origin violates localhost policy |
| 404 | `NOT_FOUND` route or `RECIPE_NOT_FOUND` |
| 422 | `NO_MATCHING_RECIPES`, `INSUFFICIENT_RECIPES`, or `NO_VALID_PLAN` |
| 503 | `DATASTORE_BUSY`; transaction could not acquire the datastore lock |
| 500 | `INTERNAL_ERROR`; details/stack/filesystem paths are not exposed |

Expected computation failures also include a `result` object with resolution/planning context. Invalid persisted JSON/schema is a server failure (500), not a malformed request (400). Upstream exceptions reaching the adapter produce 500. The adapter does not retry operations.

## Endpoints

| Method/path | Input | Success body |
| --- | --- | --- |
| `GET /api/health` | None | `{"status":"ok","service":"tilbudstrolden"}` |
| `GET /api/household` | None | Household object |
| `PATCH /api/household` | Optional `country`, `people`, `stores`, `defaultServings` | Updated household |
| `GET /api/pantry` | None | `{"items":[...]}` |
| `PATCH /api/pantry` | Optional `add` and `remove` string arrays, each defaults to `[]` | `{"items":[...]}` |
| `GET /api/recipes` | None | `{"recipes":[...]}` |
| `POST /api/recipes` | Recipe input below | `{"status":"saved","recipe":{...}}` |
| `DELETE /api/recipes/:name` | URL-encoded name | `{"status":"removed","requestedName":"..."}` |
| `POST /api/recipes/score` | Optional `people` | Scoring DTO |
| `POST /api/shopping-list` | `recipeNames: string[]`, optional `people`, `excludePantry` | Shopping DTO |
| `POST /api/plan-and-shop` | Optional planning input below | Planning DTO |
| `GET /api/stores` | None | Country, `source: "known-stores"`, `knownStores` name/alias-to-ID dictionary |
| `POST /api/deals/search` | `query: string`, optional integer `limit` (1–100, default 20) | Raw query, country/currency, offers |
| `GET /api/stores/:dealerId/offers` | Optional query `limit` (1–100, default 50) | Dealer ID and offers |

Health does not read/write the datastore or call upstream.

Store/deal reads delegate to locale data and the existing API client. The directory is curated, not exhaustive, and aliases may share an ID. Search is global within the household country and does not apply preferred-store filtering. It retains the core API's global over-fetch/country-filter behavior. HTTP passes the query string unchanged. Dealer-offer reads use the explicit ID rather than inferring a display name. Limits bound each read request; no pagination or extra multiplier was added. A weekly preferred-store rollup is deferred: its orchestration/presentation currently lives in the MCP deal tool and should be extracted into a shared read service before adding a parallel HTTP version.

### Household and pantry

Each supplied person has `name`, `dietaryRestrictions: string[]`, and `defaultSchedule: Record<string, boolean>`. Each supplied store has `name`, `dealerId`, and numeric `priority`. Validation matches the existing MCP wire types. `updateHouseholdSettings` owns country validation and schedule defaults. An empty country and `defaultServings: 0` retain their existing omission semantics. Unknown/duplicate stores and raw whitespace are accepted.

`updatePantryItems` delegates remove-before-add, case-insensitive matching, deduplication and sorting to the store. The route does not read pantry first. `{}` still invokes the existing no-op write/sort operation.

```sh
curl http://127.0.0.1:3000/api/household
curl -X PATCH http://127.0.0.1:3000/api/pantry \
  -H 'Content-Type: application/json' -d '{"add":["Salt"],"remove":[]}'
```

### Recipes

```json
{
  "name":"Tomatrisotto",
  "complexity":"medium",
  "cuisineType":"italian",
  "proteinType":"vegetarian",
  "ingredients":[{"name":"Citron","quantity":"0.5 stk"}]
}
```

`servings` defaults to 4 in `saveRecipe`. Complexity is `quick|medium|slow`. Ingredient `searchTerms` and `category` are optional: absent/empty search terms become `[name.toLowerCase()]`; absent/empty category becomes `other`. Non-empty arrays, raw quantities, whitespace, empty ingredient lists and duplicates are preserved.

POST is a case-insensitive **upsert**, not necessarily creation: the first matching recipe is replaced in place; otherwise the recipe is appended. Success is always 200 with neutral `saved` status. DELETE decodes the name exactly once and delegates first-match removal without trimming. Even a not-found delete still passes through the store's existing write path.

`GET /api/recipes` retains the store's DK default-seeding behavior. Removing the final DK recipe persists an empty list; the next GET seeds defaults. This is the existing read-side behavior, not route-owned logic.

### Scoring

```sh
curl http://127.0.0.1:3000/api/recipes/score \
  -H 'Content-Type: application/json' -d '{"people":3}'
```

Response keys: `householdSize`, `country`, `currency`, `pantry`, `scoredRecipes`. Recipes are already ranked by the service; the route does not rerank them. Each includes metadata, `matchedDealEstimate`, `matchSummary`, `priceSummary`, and ingredients.

Each ingredient has raw `quantity`, `confidence` (`high|low|none`), `matchedDealEstimate` (null if unmatched), `matchedDeal` (null or heading/store/`ingredientEstimate`), and `candidates`. Candidate `offerPrice` is the service's candidate offer-price value. A scored selected deal is a reduced projection; it does not contain the full offer or dealer ID. Use the shopping offer for those fields. No `dealMap`, locale synonym tables, or Markdown is returned.

### Shopping

```sh
curl http://127.0.0.1:3000/api/shopping-list \
  -H 'Content-Type: application/json' \
  -d '{"recipeNames":["Tomatrisotto","Chili con Carne"],"people":3}'
```

`excludePantry` defaults to true in the service. Result status is `ready` or `nothing-to-buy`. Response includes requested names, selected recipes, unknown names, household size, country/currency, pantry context, items, matched/unmatched items, store groups, warnings, `matchSummary`, `priceSummary`, and legacy `grandTotal`. Some unknown names alongside valid recipes do not fail the request; no matching recipes returns 422 plus available recipe names.

Items retain all structured service fields: quantities/aggregates/contributions, selected offer, confidence and alternatives, purchase calculation, matched purchase subtotal, and expiry snapshot. Mixed units remain separate contributions with a null aggregate. Semantic cooking units do not imply compatible retail packaging.

For a recipe requiring `0.5 stk` lemon at four servings, three people require `0.375 stk`. With a compatible one-piece pack, `purchase` has `quantityNeeded: 0.375`, `packSize: 1`, `packsNeeded: 1`, and `leftover: 0.625`.

`expiryStatus` and `expiryDaysRemaining` are the service's snapshot, copied without another clock read. Consumers should inspect each item's confidence directly: the existing service only emits an `uncertain-match` warning when alternatives exist.

### Planning

```sh
curl http://127.0.0.1:3000/api/plan-and-shop \
  -H 'Content-Type: application/json' \
  -d '{"days":3,"people":3,"maxPerProtein":2,"maxPerCuisine":2,"maxSlowDays":1}'
```

Defaults: `days=7`, `maxPerProtein=2`, `maxPerCuisine=2`, `maxSlowDays=2`. Optional fields are `people`, `excludeProteins: string[]`, `slowOnlyOnDays: number[]` (one-indexed), and `preferCuisines: Record<string, number>`. Constraints pass unchanged to `planAndShop`.

Success includes `status: "ok"`, days, household/country/currency context, constraints, scored recipes, planned days, selected recipes, `planningEstimate`, and a nested shopping DTO. Each day contains `day`, `recipeName`, a scored recipe DTO and `matchedDealEstimate`. Planning order and selected-library/shopping order may differ, as determined by the service.

Insufficient recipes and impossible constraints return 422 with `result.status` set to `insufficient-recipes` or `no-valid-plan`. The route neither calculates costs nor selects recipes. Scoring's existing deal map is reused by shopping within the service: integration tests assert exactly one `searchDealsBatch` call, including an empty-map case. The map never crosses HTTP.

## Price semantics

These amounts are **not full recipe or basket prices**. Unmatched items have no known price and are not free.

- Recipe `matchedDealEstimate` and ingredient `ingredientEstimate` are proportional recipe-requirement estimates from matched offers.
- `priceSummary` separates confirmed and uncertain estimates/subtotals. `matchSummary` includes eligible, confirmed, low-confidence and unmatched counts plus confirmed/candidate coverage.
- Shopping `selectedOffer.price` is the sticker price. `purchase.totalCost` is pack-aware where quantities are compatible; item `matchedPurchaseSubtotal` carries the service's contribution, or null if unmatched. When no compatible pack calculation exists, existing sticker-price fallback remains.
- Shopping `priceSummary.matchedPurchaseSubtotal` is the currency-rounded matched-deal purchase subtotal. `grandTotal` retains the legacy raw sum and may have floating-point representation differences; it is not a full basket total.
- `planningEstimate.matchedDealPlanningEstimate` is the planner's existing matched-deal estimate, not the shopping checkout subtotal. No normal-price data is invented.

## Persistence, tests and review

All writes delegate through shared mutation services to existing store primitives. State-dependent decisions remain inside `modify()` under the process mutex and kernel flock, followed by atomic persistence. The HTTP work does not change store locking, schemas, matching, quantities or planner algorithms.

Run `npm test -- src/http` for HTTP tests, or `npm test` for all regressions. HTTP integration tests create unique absolute temp datastore paths, block accidental live fetches, and call the app in memory without opening TCP. Listener tests mock the Node adapter. Test fixtures never use the authoritative user datastore.

The initial combined review (2026-09-07) classified the localhost foundation **B: ready with non-blocking limitations**. No HTTP-to-MCP imports, mutation pre-reads, internal Map leaks, duplicate computation, or expiry re-decisions were found. Store and MCP entrypoint are unchanged. Remaining concerns before broader deployment include authentication/exposure design, request resource limits, restore rehearsal and dependency advisories; this document is not a deployment runbook.

Local backup inspection found an executable script, a system timer configured daily at 03:15 with `Persistent=true`, and dated backups. Backup installation is host configuration and is not managed by this repository. Restore against live data has not been rehearsed. Recheck backup health and establish a restore procedure before exposing a write API beyond loopback.
