# Sign in to Kerf Sabre with planner-004 (DINO)

Status: **proposed**. Nothing here is implemented yet.

Goal: a person who signs in to planner-004 (DINO) is signed in to the Kerf Editor, the Kerf Admin site and the Kerf Server queues, and those apps learn **who they are and what role they hold** from a signed JWT, with no extra Kerf password.

This document has two parts:

- **Part A: planner-004 changes.** Written to be copied into the `planner-004` repo as-is (for example `docs/specs/kerf-sso.md`). It refers only to planner-004 files and concepts.
- **Part B: Kerf Sabre changes.** Stays in this repo. Covers the Server, Editor, Admin and `shared/`.

Decisions already made: tokens are **JWTs** verified offline by the Kerf Server against a JWKS; planner-004 stays the only place passwords/sessions live.

---

# Part A: planner-004 changes (copy this part)

## A1. Summary

planner-004 already is an OAuth 2.1 authorization server for MCP (`src/lib/oauth/*`, `src/app/oauth/*`, migrations 105-107, `docs/MCP.md`). It issues **opaque** access tokens to **teachers only**, to **Claude's callbacks only**, and has **no way to read the profile** behind a token.

Add a second, first-party use of the same server for the **Kerf Sabre** apps. Existing MCP behaviour must not change.

| Today (MCP) | Added (Kerf) |
|---|---|
| Clients self-register (RFC 7591) | Kerf clients are **pre-registered** rows |
| Redirect URI must be a Claude callback or loopback | Exact-match redirect URIs stored on the client row |
| Teacher-only | Per-client list of allowed roles (pupil, teacher, admin, technician) |
| Opaque token, DB lookup on every call | **RS256 JWT** access token, verified offline with a JWKS |
| Allow/Deny consent page | First-party clients **skip** the consent page |
| No profile endpoint | `GET /oauth/userinfo` |
| 30-day refresh | Per-client access and refresh lifetimes |
| No revocation endpoint | `POST /oauth/revoke` (RFC 7009) |

Refresh tokens stay opaque and stored as SHA-256 hashes, exactly as now.

## A2. Non-goals

- Not OpenID Connect. No `id_token`, no `/.well-known/openid-configuration` (the middleware deliberately 404s it; keep that).
- No change to MCP clients, tokens, tools or the `MCP_SERVICE_KEY` path.
- No client secrets. Kerf's Editor and Admin are browser apps, so they are **public clients using PKCE S256**, like today's flow.
- No scopes beyond the two below. MCP continues to have none.
- No SSO for the Cutter / station PCs. They keep their own station tokens inside Kerf.

## A3. Data model (new migration)

Use the next free migration number (117 existed when this was written) and keep the `BEGIN; ... COMMIT;` and `IF NOT EXISTS` style of `105-mcp-oauth.sql`.

```sql
ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS first_party boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS token_format text NOT NULL DEFAULT 'opaque'
    CHECK (token_format IN ('opaque', 'jwt')),
  -- Roles allowed to sign in through this client. NULL = teacher only (today's rule).
  ADD COLUMN IF NOT EXISTS allowed_roles text[],
  -- JWT "aud" claim. Required when token_format = 'jwt'.
  ADD COLUMN IF NOT EXISTS audience text,
  -- Scopes this client may ask for: any of 'profile', 'groups'.
  ADD COLUMN IF NOT EXISTS allowed_scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS access_ttl_seconds integer,
  ADD COLUMN IF NOT EXISTS refresh_ttl_seconds integer,
  ADD CONSTRAINT oauth_clients_jwt_has_audience
    CHECK (token_format <> 'jwt' OR audience IS NOT NULL);

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';

ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';
```

(`ADD CONSTRAINT` is not idempotent; guard it with a `DO $$ ... IF NOT EXISTS` block or give it a `pg_constraint` check.)

### Pre-registered clients

Kerf has two public clients. They are inserted by a script, not by migration, because redirect URIs differ per environment (production, school LAN, localhost dev).

| `client_id` | Used by | `allowed_roles` | `allowed_scopes` | access / refresh TTL |
|---|---|---|---|---|
| `kerf-editor` | Kerf Editor (pupils and teachers) | `pupil, teacher, admin, technician` | `profile` | 900 s / 7 days |
| `kerf-admin` | Kerf Admin site | `teacher, admin` | `profile, groups` | 900 s / 7 days |

Both: `first_party = true`, `token_format = 'jwt'`, `audience = 'kerf-sabre'`.

Add `scripts/register-oauth-client.ts` (or SQL in `docs/`) that upserts a client from CLI args: `--id`, `--name`, `--redirect-uri` (repeatable), `--roles`, `--scopes`, `--audience`. Example:

```sql
INSERT INTO oauth_clients (client_id, client_name, redirect_uris, first_party, token_format,
                           allowed_roles, audience, allowed_scopes, access_ttl_seconds, refresh_ttl_seconds)
VALUES ('kerf-editor', 'Kerf Sabre Editor',
        ARRAY['https://kerf.example.org/auth/callback', 'http://localhost:5173/auth/callback'],
        true, 'jwt', ARRAY['pupil','teacher','admin','technician'], 'kerf-sabre',
        ARRAY['profile'], 900, 604800)
ON CONFLICT (client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris,
  allowed_roles = EXCLUDED.allowed_roles, allowed_scopes = EXCLUDED.allowed_scopes;
```

**Important:** `pruneExpired()` in `src/lib/oauth/server.ts` deletes any `oauth_clients` row older than 24 hours with no token. Add `and not c.first_party` to that delete, or the Kerf clients vanish.

## A4. Authorization endpoint (`/oauth/authorize`)

Changes to `checkAuthorizeRequest` and `src/app/oauth/authorize/page.tsx`:

1. **Redirect URI matching.** For `first_party` clients, require an **exact string match** against `redirect_uris`. No loopback wildcard (a dev loopback URI may be listed explicitly). `isAllowedRedirectUri` (Claude/loopback allow-list) is only used by dynamic registration and stays as is.
2. **Registration lock.** `POST /oauth/register` must never create or modify a `first_party` client or accept a `client_id` already present.
3. **Role gate.** Replace the hard-coded teacher check (`hasRole(profile, "teacher")` and `IS_TEACHER`) with "the user has at least one of the client's `allowed_roles`". `allowed_roles IS NULL` keeps today's teacher-only rule. A pupil signing in through `kerf-editor` is allowed; the same pupil through an MCP client is still refused.
4. **Scope.** Accept an optional `scope` parameter (space-separated). Unknown scopes, or scopes outside the client's `allowed_scopes`, fail with `invalid_scope` redirected to the client. Store the granted scope on the code.
5. **No consent page for first-party clients.** After the user is signed in and passes the role gate, issue the code and redirect immediately (still a server-side redirect from the authorize page). The Allow/Deny page stays for MCP clients. Because consent is skipped, no CSP `form-action` change is needed for Kerf.
6. **Sign-in.** Keep the existing redirect to `/signin?returnTo=...`. Pupils already sign in there; confirm `returnTo` handling works for pupil accounts.
7. `resource`: ignore it for `jwt` clients unless present, in which case it must equal the client's `audience` (else `invalid_target`). Do not require it.
8. The `SameSiteReload` cross-site workaround stays in place.

## A5. Token endpoint (`/oauth/token`)

Keep both grants, PKCE S256, single-use codes with replay revocation, and refresh rotation with reuse detection exactly as written. Changes:

- `exchangeAuthorizationCode` and `refreshAccessToken`: replace `is_teacher` with the same role check against the client's `allowed_roles`, **re-evaluated at refresh time**. A pupil removed from every allowed role, or deleted, cannot refresh.
- When the client's `token_format = 'jwt'`, the `access_token` in the response is a signed JWT (A6). The `refresh_token` is still an opaque random secret. Add `scope` to the response (granted scope, may be empty).
- Use the client's `access_ttl_seconds` / `refresh_ttl_seconds` when set, else today's defaults (1 h / 30 d).
- `oauth_tokens` still stores `access_token_hash` for JWT clients (hash of the JWT) so one row still represents one connection and revoking the row works. Add `access_expires_at` as today. A JWT cannot be revoked before it expires (see A10); only refresh is cut off.
- Browser clients call this endpoint cross-origin: keep the wildcard CORS headers (no cookies are involved).

## A6. The access token (JWT)

- Format: JWT, `typ: "at+jwt"` (RFC 9068), **`alg: RS256`**, header `kid`.
- Library: [`jose`](https://github.com/panva/jose) (works on Node and edge, no native deps).

Claims:

| Claim | Value |
|---|---|
| `iss` | `publicOrigin()` (the `APP_ORIGIN` value, no trailing slash) |
| `sub` | `profiles.user_id`. The stable pseudonymous ID. Kerf uses it as the person's ID |
| `aud` | the client's `audience` (`kerf-sabre`) |
| `iat`, `nbf`, `exp` | issue time, same, issue + `access_ttl_seconds` |
| `jti` | random 128-bit value, base64url |
| `client_id` | the OAuth client |
| `scope` | granted scopes, space separated (empty string if none) |
| `roles` | array of lowercase role IDs from `user_roles`, using the same rules as `readProfile` in `src/lib/auth.ts` (legacy `is_teacher` adds `teacher`; no rows means `["pupil"]`) |
| `groups` | **only if scope `groups` granted**: array of `{ "id": group_id }` for the user's group memberships (A8) |

**Never put a name or email in the token.** Logs in Kerf carry IDs only; JWTs end up in browser storage, headers and proxies.

Build the claims in one pure function (`buildAccessTokenClaims(profile, client, scope)`) so it can be unit tested without a database.

## A7. Signing keys and JWKS

- New env vars:
  - `OAUTH_JWT_PRIVATE_KEY`: RSA private key, PKCS#8 PEM, at least 2048 bits (newlines may be `\n`-escaped).
  - `OAUTH_JWT_KEY_ID`: string used as `kid`.
  - `OAUTH_JWT_PREVIOUS_PUBLIC_KEY` and `OAUTH_JWT_PREVIOUS_KEY_ID` (optional): the old public key, kept in the JWKS during rotation so tokens signed with it still verify until they expire.
- Add them to `src/lib/env/required-env.ts` in production. If a JWT client is used and the key is missing, the token endpoint returns `server_error` and logs the cause; it must **never** fall back to an unsigned or opaque token.
- New route `GET /oauth/jwks` returns `{ "keys": [ ... ] }` with the current public key (and the previous one if configured): `kty, n, e, use: "sig", alg: "RS256", kid`. Derive the public JWK from the private PEM at startup (`jose`: `createPrivateKey` then `exportJWK` of the public key). `Cache-Control: public, max-age=300`. CORS `*`, GET and OPTIONS.
- Rotation procedure (document in `docs/`): generate new key, set it as current and move the old public key into the `PREVIOUS` vars, deploy, remove `PREVIOUS` after the longest access-token lifetime (15 minutes) has passed.

## A8. Discovery metadata

Update `src/lib/oauth/metadata.ts` (`authorizationServerMetadata`), served by the middleware:

```json
{
  "jwks_uri": "<origin>/oauth/jwks",
  "userinfo_endpoint": "<origin>/oauth/userinfo",
  "revocation_endpoint": "<origin>/oauth/revoke",
  "scopes_supported": ["profile", "groups"],
  "access_token_signing_alg_values_supported": ["RS256"]
}
```

alongside the existing fields. `token_endpoint_auth_methods_supported` stays `["none"]`. Keep the 404 for `/.well-known/openid-configuration`. Update the CORS/`DISCOVERY_HEADERS` only if a new path needs it (the `/oauth/*` routes use `cors.ts`).

`groups`: use whatever planner-004 uses for classes/groups membership (the `group_members` table that the dashboard migrations join on). If there is no reliable pupil-to-class mapping, ship without the `groups` scope and remove it from `scopes_supported` (see Open questions).

## A9. New endpoints

### `GET /oauth/userinfo`

- Auth: `Authorization: Bearer <JWT>`. Verify signature, `iss`, expiry, and that the client's token row is not revoked. Reuse the verification helper from A11.
- Response `200` JSON:
  ```json
  { "sub": "<user_id>", "roles": ["pupil"] }
  ```
  With scope `profile`, add `"name": "<first_name last_name>"` and `"email"` (email only for teachers/admins; **never** for pupils). Name and email are for display only; Kerf must not store them.
- Errors: `401` with `WWW-Authenticate: Bearer error="invalid_token"`.
- CORS: `GET, OPTIONS`, headers `Authorization`. Wildcard origin is fine (no cookies). Extend `cors.ts` with a GET variant.
- This is read live, so a role change shows here before the next token refresh.

### `POST /oauth/revoke` (RFC 7009)

- Form body: `token` (refresh token or access JWT), `client_id`, optional `token_type_hint`.
- Finds the `oauth_tokens` row for that client by refresh hash or access hash and sets `revoked_at`. Always answers `200`, whether or not the token existed (RFC 7009 §2.2). Public clients, so no authentication beyond `client_id`.
- Used by Kerf "Sign out".

## A10. Security notes

- **Access JWTs cannot be revoked before expiry.** They live 15 minutes by design. Revoking or disabling a user stops refresh immediately and stops new codes; an already-issued JWT works until `exp`. Do not raise the lifetime to compensate.
- Exact redirect URI match for first-party clients; a code can only be delivered to the registered Kerf origins.
- Keep PKCE S256 mandatory, code single use, 10-minute code lifetime, refresh rotation with reuse detection (all existing).
- The Kerf Server must check `iss`, `aud`, `exp`, `nbf`, and **pin `alg` to RS256** (reject `none` and HS256). That is a Kerf-side rule, listed in Part B, but state it in planner-004's docs too.
- Rate-limit `/oauth/token` and `/oauth/revoke` per IP if the project already has a limiter; pupils share school IPs, so keep limits generous.
- Do not log tokens, codes or JWTs. Log `client_id`, `sub` and outcome only.
- `profiles.user_id` as `sub` means a pupil's ID in Kerf is their planner-004 user ID. Treat it as personal data.

## A11. Code layout

- `src/lib/oauth/jwt.ts` (new): `signAccessToken`, `verifyAccessJwt`, `publicJwks`, `buildAccessTokenClaims`.
- `src/lib/oauth/server.ts`: generalise `IS_TEACHER` to a role check using `allowed_roles`; branch on `client.token_format`; exempt `first_party` clients from pruning.
- `src/lib/oauth/metadata.ts`: new metadata fields.
- `src/app/oauth/jwks/route.ts`, `src/app/oauth/userinfo/route.ts`, `src/app/oauth/revoke/route.ts` (new).
- `src/app/oauth/authorize/page.tsx`: skip consent for first-party clients.
- `src/app/oauth/cors.ts`: GET variant.
- `src/migrations/NNN-kerf-sso.sql` and `scripts/register-oauth-client.ts`.
- `src/types/index.ts`: add `scope` to `OAuthAuthorizeParamsSchema`.
- `docs/MCP.md`: add a "Kerf Sabre sign-in" section (or a new `docs/KERF-SSO.md`).
- `src/lib/mcp/auth.ts` and the MCP route: **untouched**. MCP clients are `opaque`, so `verifyAccessToken` keeps working for them. `verifyAccessToken` must reject JWT-format tokens from Kerf clients (their `aud` is not the MCP resource), so a Kerf token never works against `/api/MCP`.

## A12. Acceptance tests

Unit (no DB where possible):

1. `buildAccessTokenClaims` for a pupil, a teacher, a user with legacy `is_teacher`, and a user with no role rows; no `name`/`email` ever present.
2. A signed JWT verifies against `/oauth/jwks`; wrong `kid`, wrong `aud`, expired, `alg: none` and HS256-signed tokens are rejected by `verifyAccessJwt`.
3. Rotation: a token signed with the previous key verifies while `PREVIOUS` vars are set.

Integration (existing OAuth test style, with a database):

4. `kerf-editor` with a pupil user: authorize issues a code with no consent page; token exchange returns a JWT whose `roles` is `["pupil"]` and `aud` is `kerf-sabre`.
5. The same pupil through a dynamically registered MCP client is still refused.
6. `kerf-admin` refuses a pupil.
7. A redirect URI that differs by even one character from the registered one is rejected without redirecting.
8. `scope=groups` on `kerf-editor` returns `invalid_scope`.
9. Refresh: rotates, returns a new JWT, and old refresh reuse revokes the connection. Removing the user's allowed roles makes refresh fail with `invalid_grant`.
10. `POST /oauth/revoke` makes the next refresh fail; unknown token still returns 200.
11. `/oauth/userinfo`: returns `sub` and `roles`; `name` only with `profile`; never `email` for a pupil; 401 for an expired token.
12. `pruneExpired` does not delete a `first_party` client.
13. MCP regression: existing OAuth tests and the `MCP_SERVICE_KEY` path unchanged; a Kerf JWT sent to `/api/MCP` is refused.

## A13. Open questions for planner-004

1. What are the real values of `user_roles.role_id` in production? (Seen in code: `pupil`, `teacher`, `admin`, `technician`.)
2. Is `profiles.user_id` safe to expose as a stable pupil ID (format, length, never reused)? Kerf allows letters, digits, `_`, `-`, up to 64 characters.
3. Is there a dependable way to list a pupil's classes/groups (for the optional `groups` claim)?

---

# Part B: Kerf Sabre changes (stays in this repo)

## B1. What exists today

- `server/kerf_server/security.py`: opaque bearer tokens in a `tokens` table. `Principal(role, id, school)`, roles `pupil, teacher, admin, station, platform`, dependency `require(*roles)`.
- Pupils sign in with class code + pupil ID + PIN (`POST /auth/login`), get a 10-hour token.
- Teachers, admins, stations and the platform use issued tokens (`POST /schools/.../staff`).
- `shared/openapi.yaml` already documents roles and `GET /auth/me`.

Planner SSO **adds** a way to produce a `Principal`; the existing opaque tokens (and so stations and the platform role) keep working.

## B2. Server (`server/`)

1. New module `kerf_server/sso.py`:
   - `PyJWT` + `cryptography` (add to `pyproject.toml` and the portable bundle). A `PyJWKClient` (or equivalent) fetches `<issuer>/oauth/jwks`, caches keys for about 5 minutes, and re-fetches **once** on an unknown `kid` (rate-limited) so rotation works.
   - Verify with `algorithms=["RS256"]` only; require `iss == cfg.sso_issuer`, `aud == "kerf-sabre"`, `exp`, `nbf`, `sub`; 30 s leeway.
   - Map claims to `Principal`: `id = sub`, `school = DEFAULT_SCHOOL` (single school for now). Role precedence: `admin` > `teacher` (also `technician`, see B7) > `pupil`. A token with no recognised role is refused `403`.
2. `current_principal` in `security.py`: if the bearer looks like a JWT (starts with `eyJ`), verify it with `sso.py`; otherwise use the existing hashed-token lookup. A bad JWT is `401`. Station and platform tokens never accept JWTs, and a JWT can never produce `station` or `platform`.
3. Config (`Settings`): `auth_mode` = `pins` (today, default), `planner` (JWT only for pupils/teachers/admins) or `both`; `sso_issuer`; `sso_audience` (default `kerf-sabre`); `sso_jwks_url` (default issuer + `/oauth/jwks`). In `planner` mode `POST /auth/login` answers `404 sso_only`.
4. JWKS fetch failure with no cached key: `503 sso_unavailable` (not 401), logged. Cached keys keep working, so a short planner-004 outage does not stop a lesson.
5. **Privacy:** store and log only `sub`. Never log the token. Do not copy `name`/`email` into the database or logs. Display names, if shown, come from `userinfo` in the browser only.
6. Pupil rows: today a pupil exists in a class with a PIN. With SSO a person may arrive with a valid JWT and no Kerf pupil row. Decide the rule (B7); until decided, `auth_mode: both` plus an existing row keeps working.
7. Tests (`server/tests/test_sso.py`): valid pupil/teacher/admin JWTs map to the right `Principal`; expired, wrong `aud`, wrong `iss`, `alg: none`, HS256, unknown `kid`, missing `sub`, JWT claiming `station` all rejected; JWKS cached and refreshed on unknown `kid`; station token still works; `/auth/me` works with a JWT. Generate test keys and a fake JWKS in `conftest.py`; no network.

## B3. Editor and Admin (`editor/`, `editor/admin/`)

- Authorization Code + PKCE (S256) against planner-004, using `client_id` `kerf-editor` or `kerf-admin`. Redirect URI `<origin>/auth/callback`.
- Sign-in screen gets a "Sign in with DINO" button when `GET /auth/config` says SSO is on; the PIN form stays when `auth_mode` is `pins` or `both`.
- Hold the access token **in memory**. Keep the refresh token in `sessionStorage` (cleared with the tab), not `localStorage`; rotation and reuse detection limit the damage of theft. Refresh silently about 60 s before `exp`.
- Send `Authorization: Bearer <JWT>` on API and WebSocket calls exactly as the opaque token is sent today.
- Sign out: `POST /oauth/revoke`, clear storage, return to the sign-in screen.
- Station mode keeps using the station token and never shows the SSO button.
- Dev: `python3 start.py --dev` runs offline, so add `--no-auth` (or a local stub issuer with a throwaway key) so the editor works without planner-004.

## B4. `shared/` (one feature at a time may change it)

Additive, so a minor version bump with a `shared/CHANGELOG.md` entry:

- `openapi.yaml`: `bearerAuth.bearerFormat` documents "opaque token or planner-004 JWT"; new public `GET /auth/config` returning `{ mode, issuer, clientId, authorizeUrl, tokenUrl, revokeUrl, scopes }`; `POST /auth/login` may answer `404 sso_only`; `Me` unchanged.
- No change to the job/preset/machine schemas.
- Bump `info.version` and the `schemaVersion` constants as the previous entries do.

## B5. Out of scope

Cutter and station PCs (they keep station tokens; outbound only). Mapping planner groups to Kerf class codes (B7). Multiple schools.

## B6. Rollout

1. planner-004: Part A, with the `kerf-editor` / `kerf-admin` clients registered for localhost first.
2. Kerf `shared/` bump (alone), then Server `sso.py` with `auth_mode: both`.
3. Editor and Admin sign-in flow, tested on one PC.
4. Production redirect URIs and keys; run `both` for a trial class; once happy, move to `planner`.
5. Keep PIN login available for a term as the fallback if DINO is down.

## B7. Open questions for you

1. **Is the DINO user ID the Kerf pupil ID?** The spec assumes yes (`sub` becomes the ID in jobs, queues and logs). Existing Kerf pupil IDs (for example `P001`) would then need a one-time mapping, or old jobs keep the old IDs.
2. **Class membership.** Kerf scopes pupils to a class code (teacher sees their classes). Should a first sign-in auto-create the pupil in the right class from DINO groups (`groups` scope), or does the teacher still add pupils in Kerf?
3. **Roles.** DINO has `technician` as well as `teacher` and `admin`. Treat technician as Kerf `teacher`? Is every DINO `admin` also a Kerf school admin, or should Kerf admin be a separate flag?
4. **Network.** The Kerf Server needs to reach `dino.mr-salih.org` to fetch the JWKS (only the first time and on rotation), and pupils' browsers need to reach it to sign in. Is that allowed from the school network and from the VPS?
5. **Lifetimes.** 15-minute access and 7-day refresh are the defaults here. Is a pupil staying signed in for a week on a shared lab PC acceptable, or should the refresh token be much shorter (for example 10 hours, matching today's PIN session)?
