# MCP for the Kerf Server (read-only, staff, signed in with DINO)

Status: **Kerf Server side implemented and tested** (`server/kerf_server/mcp_layer/`, `server/tests/test_mcp.py`). **planner-004 side (Part A below) is not built yet**, so a real AI app cannot sign in end to end until it is. Offline you can use it today with a stored teacher token (see "Try it").

## What it is

An MCP server inside the Kerf Server at `POST /mcp` (MCP "Streamable HTTP", JSON responses, stateless, no sessions). A teacher, admin or technician connects an AI app (for example a Claude custom connector at `https://<kerf>/mcp`), signs in with DINO, and can **read**:

| Tool | Gives |
|---|---|
| `list_files` | submitted files, newest first: status and reason, pupil ID (and display name, staff only), material, station, ticket, shapes per layer, estimate. Filters: status, station, pupil, activity; `limit`/`offset` |
| `get_file` | one file: the above plus origin, warnings, where it was framed and its history; `include_design` adds the shapes (capped at 100 KB) and the DXF clean-up report |
| `get_gcode` | the G-code for a file (first `max_lines`, default 200, max 2000) with total lines and SHA-256 |
| `get_queue` | files on a laser, then waiting files in order with position, ticket, time ahead; with `station`, which one is next for it |
| `list_stations` | every laser: online, state, head position, current file and progress, last seen, calibrated, next ticket, how many files wait for it |
| `get_station` | one laser; `log_lines` (max 100) adds its newest Cutter and Server log lines |

Every tool is marked `readOnlyHint`. There is **no tool that changes anything** (no approve, reject, move, cancel, frame or start). Adding any is a separate decision.

## Who may use it and what they see

- Roles: `teacher`, `admin`, `technician`. Pupils, stations and the platform owner get 403.
- Each call runs the same service code as the REST API with the caller's `Principal`, so **a school only sees its own files, queue and lasers**; another school's id answers "no such file/laser". `tests/test_mcp.py::TestSchoolsAreWalls` is the isolation suite for MCP.
- Privacy is the existing rule (shared 0.2.22): pupil IDs everywhere; a DINO display name only for staff of the same school; never an email; no camera frames (only `cameraAvailable`).
- Audit: every call logs `who` (DINO `sub`), role, tool name and whether it worked, to logger `kerf.mcp` (console). Never arguments, results, names or tokens.
- Results are capped (200 KB) and lists are paged, so one question cannot dump the database.

## Sign-in (planner-004 / DINO)

Kerf is an OAuth 2.1 **resource server**; DINO is the authorization server.

1. The AI app calls `POST /mcp` with no token and gets `401` with `WWW-Authenticate: Bearer resource_metadata="https://<kerf>/.well-known/oauth-protected-resource/mcp"`.
2. That document (RFC 9728) names the resource (`https://<kerf>/mcp`) and DINO (`authorization_servers`). The app then talks to DINO: registers itself, sends the person through DINO sign-in and consent, and asks for a token **for that resource** (RFC 8707 `resource`).
3. DINO issues an RS256 JWT access token with `aud` = the resource URL. Kerf verifies it offline with DINO's JWKS (the same `sso.py` as the Editor), pinned to RS256, `iss`, `aud`, `exp`, `nbf`, `sub`.

Token separation (so a token for one thing cannot be replayed on the other): an **Editor token** (`aud: kerf-sabre`) is refused on `/mcp`, and an **MCP token** (`aud` = the MCP resource) is refused on the REST API. `client_id` is not restricted for MCP, because AI apps register themselves; the audience and the role are what count. In `KERF_AUTH_MODE=planner` a stored token is never accepted on `/mcp`.

## Kerf configuration

| Variable | |
|---|---|
| `KERF_MCP=1` | turn it on (default off: `/mcp` is 404) |
| `KERF_PUBLIC_URL` | this server's public origin, e.g. `https://kerf.example.org`. Required with DINO sign-in; the MCP resource is `<it>/mcp` |
| `KERF_MCP_AUDIENCE` | the `aud` to require, if DINO uses something other than the resource URL (default: the resource URL) |
| `KERF_SSO_ISSUER` and the rest | as for the Editor (`docs/AUTH-PLANNER-004.md`) |

The reverse proxy must pass `/mcp` and `/.well-known/oauth-protected-resource*` to the Server (not to the Editor's static files). The Server checks the `Origin` header on `/mcp` (browsers must come from `KERF_PUBLIC_URL` or `KERF_CORS_ORIGINS`; AI apps send none).

## Try it offline (no DINO)

```bash
KERF_AUTH_MODE=pins KERF_MCP=1 KERF_PUBLIC_URL=http://127.0.0.1:8000 kerf-server
kerf-admin create-token --role teacher --id T001        # prints a kt_... token (pins mode only)
curl -s localhost:8000/mcp -H "Authorization: Bearer kt_..." -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_stations","arguments":{}}}'
```

The MCP Inspector (`npx @modelcontextprotocol/inspector`, Streamable HTTP, header `Authorization: Bearer kt_...`) works the same way.

## Why not the official MCP SDK

mcp 2.x (a new major version, `FastMCP` removed) brings many dependencies (OpenTelemetry, a second HTTP stack, SSE) into a server that is meant to stay small and bundle into a portable folder, and wants to own the auth routes. The surface needed here (initialize, ping, tools/list, tools/call) is small, so it is implemented directly in `mcp_layer/protocol.py` and reuses the Server's own auth. Tools live in a registry (`mcp_layer/tools.py`), so moving to the SDK later means re-registering six functions.

## Not covered

Writes (approve, reject, move in queue, requeue, stop a laser); MCP resources/prompts; streaming and notifications; pupils as MCP users; the camera picture.

---

# Part A: planner-004 changes (copy this part into the planner-004 repo)

planner-004 already is an OAuth 2.1 server for its own MCP (opaque tokens, teachers only, dynamic client registration). Kerf needs its tokens to be **verifiable offline** and **bound to the Kerf MCP resource**. This builds on `docs/AUTH-PLANNER-004.md` Part A (RS256 signing keys, `/oauth/jwks`, `jwt.ts`); if that is not merged yet, do it first. Existing planner-004 MCP behaviour must not change.

## A1. Resource-bound JWTs

1. **Registered resources.** New config (env `OAUTH_RESOURCES_JSON` or a table) listing resource URLs DINO may issue JWTs for, each with `allowed_roles`. First entry: `https://<kerf>/mcp`, roles `teacher, admin, technician`. (One per environment: production, school LAN, localhost.)
2. **`resource` parameter (RFC 8707)** on `/oauth/authorize` and `/oauth/token` (code and refresh). If it equals a registered resource: the client may be **any** client, including a dynamically registered one (Claude registers itself); otherwise behave exactly as today. An unknown `resource` is `invalid_target`.
3. **Role gate** for that resource: the signed-in person must hold one of its `allowed_roles`, checked at authorize and again at every refresh. A pupil is refused at authorize. (This is separate from today's MCP rule, which is teachers only.)
4. **Token.** For such requests the `access_token` is an RS256 JWT, `typ: at+jwt`, `kid`, same keys and `/oauth/jwks` as the Kerf sign-in, with claims: `iss` (public origin), `sub` (`profiles.user_id`), **`aud` = the resource URL exactly**, `iat`, `nbf`, `exp` (15 minutes), `jti`, `client_id`, `scope` (empty), `roles` (as in `AUTH-PLANNER-004.md` A6). **Never a name or email.** The refresh token stays opaque and rotating, with reuse detection.
5. **Consent stays on** for these dynamically registered clients (the person is handing an AI app access to school data; show who is asking and what for). Skip it only for first-party clients.
6. **Metadata.** `jwks_uri`, `revocation_endpoint` and `registration_endpoint` as already planned; advertise `resource_indicators_supported` if the metadata library has it.
7. **Separation.** A Kerf MCP JWT must not work on planner-004's own `/api/MCP` (its `aud` is not that resource, and it is not an opaque token), and a planner-004 MCP token must not work on Kerf (opaque, so Kerf refuses it).

## A2. Acceptance tests

1. A teacher signs in through a dynamically registered client with `resource=https://<kerf>/mcp`: gets a JWT with `aud` = that URL and `roles` containing `teacher`.
2. A pupil through the same flow is refused at authorize. A user who loses every allowed role cannot refresh.
3. `resource` set to something unregistered: `invalid_target`. No `resource`: today's opaque-token behaviour, unchanged.
4. The JWT verifies against `/oauth/jwks`; it is refused by `/api/MCP`; no name or email in it.
5. Existing MCP and Kerf Editor/Admin sign-in tests unchanged.

## A3. Questions for planner-004

1. Does the AI app you will use send `resource` (the MCP spec says it must)? If it does not, DINO can fall back to the resource of the request's redirect/registration.
2. Is `technician` allowed to hand AI apps access, or only `teacher` and `admin`? (Kerf accepts all three.)
3. Should `admin` of a DINO school map to Kerf `admin` here as it does in the Editor? (Yes by default.)
