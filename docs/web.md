# Local web foundation

The GUI is a React/TypeScript/Vite shell with a read-only household settings page and placeholder
routes for the remaining domains. The shell makes one `GET /api/health` request, which does not
access the datastore. Visiting `/settings` also reads `GET /api/household`. React Router runs in
declarative mode; there is no global state or query framework.

## Development

Use Node 24 (validated on 24.19.0) and npm, then run `npm ci` in the repository root. The web
toolchain requires a newer runtime than the historical backend-only Node 18 engine declaration.
There is one package.json and lockfile, not a separate workspace.

In one terminal, select the backend datastore explicitly:

```sh
TILBUDSTROLDEN_DATA=/absolute/path/to/tilbudstrolden.json npm run http:dev
```

Use a separate temporary datastore when experimenting with future mutation pages. Do not copy
credentials or data into `web/`. In another terminal:

```sh
npm run web:dev
```

Open **http://127.0.0.1:5173**. Backend remains **127.0.0.1:3000**, MCP remains stdio. Neither
server is installed as a service. No Nginx, authentication, CORS relaxation or LAN deployment is
included. Do not override the host binding or put this development setup behind a LAN proxy.

The browser calls relative `/api/...` URLs. Vite proxies those paths to the existing backend.
The backend rejects a different Origin even on loopback: the Vite middleware therefore first
checks Host, Origin and Sec-Fetch-Site, rejecting foreign origins/hosts. Only then does the proxy
translate a present Origin to the backend origin and rewrite Host. Requests with no Origin retain
that absence. These are development same-origin guards, not authentication of local processes.
Port 5173 is fixed (`strictPort`) so the guard cannot silently drift to another port. CORS is off.

## Structure and contracts

- `web/src/api/client.ts`: JSON transport and `ApiError`, plus the typed health call.
- `web/src/hooks/useApiHealth.ts`: one health check per app mount, no polling/retry. Health times
  out after five seconds and is cancelled on unmount. Navigation does not repeat the check.
- `web/src/layout/AppShell.tsx`: sidebar, responsive two-column mobile navigation, connection state.
- `web/src/pages/PlaceholderPage.tsx`: titles only; no synthetic or real domain data.
- `web/src/api/household.ts`: typed relative household GET using `HouseholdHttpResponse`.
- `web/src/hooks/useHousehold.ts`: loading/success/ApiError state for one GET per settings mount,
  cancelled on unmount; late completions are ignored. No polling, caching or automatic retry.
- `web/src/pages/SettingsPage.tsx`: read-only defaults, people, individual restrictions and
  schedules, and preferred stores. No forms or mutation requests. Empty lists are explicit.
- `web/src/components/States.tsx`: reusable loading, error and empty states.
- `web/src/styles/base.css`: light-mode tokens, visible focus, semantic layout, no UI framework.

Routes: `/` (Overblik), `/plan`, `/shopping`, `/deals`, `/recipes`, `/pantry`, `/history`, `/settings`.
Unknown routes show a not-found page and a home link. All navigation uses links with active-state
indication; a keyboard skip link targets the main content. No icons/fonts or external assets load.

Shared HTTP types are imported **type-only** from `src/contracts/http.ts`. The browser tsconfig
includes that file and has no emitting `rootDir`; the backend tsconfig is unchanged. Browser source
must never import HTTP adapters, services, store, Node or MCP modules. Node imports belong only in
Vite/test tooling outside `web/src`. No contracts are copied or generated.

`request<T>` returns the selected wire contract for JSON success; it is a typed trust boundary,
not general runtime schema validation. Health additionally verifies its payload. Explicit
`response: "empty"` calls return void; an unexpected empty JSON response is a protocol error.
`ApiError` distinguishes HTTP, network, timeout, cancellation and protocol errors, retaining HTTP
status, server code/message and optional result context. `result` stays unknown until a future
endpoint-specific consumer validates/narrows it; error envelopes are never cast to success types.
Redirects are not followed. Requests have a 60-second default timeout and accept cancellation.
An aborted/timed-out mutation may still finish on the backend.

**No automatic retries, including reads.** In particular `POST /api/spend` may be committed before
a subsequent currency read fails. Never infer rollback from HTTP/network failure. Future tracking
forms must disable double-submit and offer a history refresh before any manual retry. Client tests
cover one request only on HTTP 500/503 and network failure. No authoritative state is stored in the
browser or localStorage.

## Build and test

```sh
npm run build           # backend dist/ AND web/dist/
npm run typecheck       # backend AND browser/tooling types (including web tests)
npm run lint            # backend AND web
npm test               # existing backend suite and filtering behavior
npm run test:all        # backend suite, then web suite
npm run web:test        # frontend + isolated dev-proxy tests only
npm run web:typecheck
npm run web:build
```

`npm run build:backend` still builds only MCP/HTTP; existing start/dev scripts are unchanged.
Root `test:watch` and `test:coverage` remain backend-only; web tests can be watched with
`npm run web:test -- --watch`. The frontend build is a separate gitignored `web/dist` artifact.
There is no backend static serving or production deployment in this increment.

Tests use the existing Vitest plus Testing Library and jsdom. Fetch mocks are restored and React
trees cleaned up after each test. The proxy integration test opens ephemeral **loopback-only**
listeners with an isolated fake upstream: it never connects to the actual backend or datastore.
It may need permission to bind loopback sockets in a restricted sandbox. Shared planning union
narrowing is checked by `web:typecheck`, not just transpiled by Vitest.

## Household settings

The page presents country and default servings without inferring a household size. Store names,
dealer IDs, priorities, duplicates and array order are preserved; there is no store lookup or
normalization. Restrictions belong to each person, not a fabricated household-level list.
Weekdays use Danish labels, with explicit Hjemme / Ikke hjemme text. Missing days are unknown
(Ikke angivet); an empty schedule stays empty. Non-standard schedule keys are shown unchanged.

Settings uses the existing loading/error announcements and shared API timeout. Errors show a
message, never the error's stack/result object. There is no retry button; leaving and returning
to the route starts a fresh GET. It does not repeat the shell health request.

Automated settings tests mock fetch and never use a datastore. For a read-only local smoke test,
start the backend with the explicitly selected existing datastore, open `/settings`, and navigate
away/back at desktop and mobile sizes. Only health/household GETs are needed. Stop temporary
servers afterwards; do not call recipe seeding or mutation endpoints during this check.

Recommended next slice: a read-only pantry view using the same small state/effect pattern.
Keep editing, spend submission and more complex planning flows for later commits.
