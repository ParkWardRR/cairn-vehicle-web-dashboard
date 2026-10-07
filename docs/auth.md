# Authentication

Every route and page needs an identity. There are three, and nothing else gets an answer:

| Identity | How | Can do |
|---|---|---|
| **Passkey** | a WebAuthn sign-in (Touch ID, Face ID, a security key, a phone) starts a 30-day session | everything; the only identity that can be *fresh* |
| **Tailnet device** | the client's address belongs to a device owned by an allowlisted Tailscale login | read and change saved places; cannot manage credentials |
| **Service token** | `Authorization: Bearer …`, for the deploy check and staging | read only |

No account in any cloud service is involved.

## Passkeys

`/login` signs in with a passkey. Before there is one:

- from a device on your tailnet whose login is in `NUXT_AUTH_TAILNET_USERS`, `/login` offers to create the first passkey; or
- with the one-time code in `bootstrap-code` in the data directory (`/var/lib/cairn-ui/`, readable by root only). The file is deleted when the first passkey exists. The sign-in page shows the command to read it (with a copy button) and, when the device is on a tailnet but not allowed, says why it was not recognised.

The code is deliberate: without it, whoever reached a fresh install first would own it. Tailnet recognition needs the request to arrive from a tailnet address; if the site's name resolves to a LAN address, a phone on home Wi-Fi arrives as a LAN client and needs the code.

Adding or removing a passkey (the Security page) needs a passkey used in the last five minutes, so a Tailnet address or a stolen session cannot enrol a second way in. Removing a passkey ends every session it started.

Passkeys only work on the origin named in `NUXT_AUTH_ORIGINS` (the browser enforces this), over HTTPS.

## Tailnet identity

The service asks the local `tailscaled` (its LocalAPI socket) who owns the address a request came from. The address is the TCP peer, or, for a request that came through the reverse proxy on this machine, the address the proxy appended to `X-Forwarded-For`. The service listens on loopback only (`NITRO_HOST=127.0.0.1` in the unit), so nothing else can claim an address. Tagged devices never match.

## Adding a phone

**Add a phone** (`/phones`) makes a single-use invitation for the iPhone app and shows it as a QR code the
camera opens. An invitation lets a phone read every trip, so it needs a passkey used in the last five minutes
(`requireFresh`), like changing a passkey; a Tailnet address or the service token cannot. The code is in the
response only: not stored, not logged, not audited (the trail records the device name). The invitation is a
*user* one, valid ten minutes, made by cairn-server's loopback local API with its write token
(`NUXT_CAIRN_LOCAL_TOKEN_FILE`, the file cairn-server reads with `-app-local-token-file`). The QR also carries
the private CA (a public certificate) so the phone trusts the server for the app's own connections.
Settings: `NUXT_PHONE_SETUP_URL`, `NUXT_PHONE_SETUP_CA_FILE`, optional `NUXT_PHONE_SETUP_TAILNET_URL`.

The same page lists the enrolled phones, the cars and their trips, and a week of activity. Anyone
signed in (a passkey or an allowlisted Tailnet device) may read them. **Revoking** a phone stops it
for good, on its very next request, and needs a passkey used in the last five minutes like an
invitation does; the trail records who did it and the phone's name. The activity comes from
cairn-server's audit log: phones joining and stopping, trips carried, history refreshes, and anything
refused (an unsigned or wrongly signed request, a scope refusal). It never holds a trip's contents,
a location, a token, a body hash or a Tailscale login.

## Cross-site requests

A request that changes something and names another origin (`Origin`, `Sec-Fetch-Site`) is refused, even from a Tailnet address: that identity belongs to the machine, not to the page that asked. Session cookies are `HttpOnly` and `SameSite=Strict`, and `Secure` over HTTPS.

## Secrets (for the settings in #16)

- `requireFresh(event)` in a handler demands a recent passkey; a Tailnet identity or the service token is never enough.
- Credential fields are write-only: never returned, never in a query string, never in the audit trail.
- `audit(event, action, field)` records who, when and which field. `GET /api/auth/audit` lists it (`/security`).

## Configuration

See `deploy/systemd/ui.env.example`. `NUXT_AUTH_MODE=off` opens every route and exists for local development only; the service says so loudly on start.
