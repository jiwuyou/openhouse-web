# OpenHouse Web

OpenHouse Web is the local system shell for OpenHouse. It borrows the calm,
phone-like visual language of SmallPhone while remaining an independent
product and repository. It does not implement chat, models, agents, or AI
credentials.

## Responsibilities

- application desktop and application launch entries;
- per-application service detail;
- all-services control and residency settings;
- local preferences and maintenance views;
- a strict server-side BFF for `service-manager`.

The browser never receives the service-manager bearer token and never reads
OpenHouse configuration files directly.

## Run locally

Node 20 or newer is required. There are no npm dependencies.

```sh
SERVICE_MANAGER_TOKEN=... npm start
```

Defaults:

- OpenHouse Web: `http://127.0.0.1:22110`
- service-manager: `http://127.0.0.1:20087`
- preferences: `${XDG_DATA_HOME:-$HOME/.local/share}/openhouseai/openhouse-web/preferences.json`
- local password: `${XDG_DATA_HOME:-$HOME/.local/share}/openhouseai/openhouse-web/password`

Useful environment variables:

```text
OPENHOUSE_WEB_HOST
OPENHOUSE_WEB_PORT
OPENHOUSE_WEB_DATA_DIR
OPENHOUSE_WEB_ALLOWED_HOSTS
OPENHOUSE_WEB_TICKET_FILE
OPENHOUSE_WEB_TICKET_TTL_MS
OPENHOUSE_WEB_SESSION_TTL_MS
OPENHOUSE_WEB_MAX_SESSIONS
SERVICE_MANAGER_URL
SERVICE_MANAGER_TOKEN
SERVICE_MANAGER_TOKEN_FILE
SERVICE_MANAGER_CONFIG
```

Only loopback service-manager URLs are accepted.

The server continuously publishes a mode-`0600`, short-lived bootstrap ticket to
`$OPENHOUSE_WEB_TICKET_FILE` (by default under the OpenHouse Web data
directory). Android reads that file and opens `/#ticket=<one-time-ticket>`.
The browser removes the fragment immediately and exchanges the ticket for an
HttpOnly, SameSite=Strict session cookie. The ticket cannot be replayed. All
API routes except `/health` and `/api/v1/session/exchange` require that
session; mutations additionally require an exact same-origin request and the
session-bound CSRF token. Consumed and expired tickets are replaced without a
service restart, and the handoff file always contains the latest ticket. The
number of active sessions is bounded by `OPENHOUSE_WEB_MAX_SESSIONS` (default
8), with the oldest session evicted first.

The same HttpOnly session can also be created with the local OpenHouse Web
password:

```text
POST /api/v1/session/password  {"password":"..."}
```

On the first start, if `dataDir/password` is absent, the server atomically
creates it as plaintext `123456\n`. The data directory is mode `0700` and the
password file is mode `0600`. Passwords must contain 6-128 characters and may
not contain CR, LF, or NUL. The password is never returned to the browser or
written to logs.

An authenticated session may replace it with:

```text
PUT /api/v1/password  {"currentPassword":"...","newPassword":"..."}
```

This mutation requires an exact same-origin request and the session CSRF token.
After the old password is verified and the file is atomically replaced, all old
sessions are revoked and the response issues a new HttpOnly session and CSRF
token. Bootstrap ticket exchange remains available and unchanged.

## Validate and package

```sh
npm run check
npm test
npm run build
npm run integration
scripts/build-payload.sh
```

`scripts/install.sh` installs the dependency-free runtime. `scripts/register-service.sh`
writes the production service declaration and, when possible, asks a running
service-manager to reload its registry.

## Service residency contract

The BFF exposes only the fixed service-manager contract:

```text
GET    /api/v1/residency
GET    /api/v1/services/:id/residency
PUT    /api/v1/services/:id/residency  {"resident": boolean}
DELETE /api/v1/residency/:id
```

`resident=false` removes future keep-alive intent but does not stop a running
service. Stopping a resident service suspends it; starting or restarting it
clears that suspension.
