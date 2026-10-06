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
- with the one-time code in `bootstrap-code` in the data directory (`/var/lib/cairn-ui/`, readable by root only). The file is deleted when the first passkey exists.

Adding or removing a passkey (the Security page) needs a passkey used in the last five minutes, so a Tailnet address or a stolen session cannot enrol a second way in. Removing a passkey ends every session it started.

Passkeys only work on the origin named in `NUXT_AUTH_ORIGINS` (the browser enforces this), over HTTPS.

## Tailnet identity

The service asks the local `tailscaled` (its LocalAPI socket) who owns the address a request came from. The address is the TCP peer, or, for a request that came through the reverse proxy on this machine, the address the proxy appended to `X-Forwarded-For`. The service listens on loopback only (`NITRO_HOST=127.0.0.1` in the unit), so nothing else can claim an address. Tagged devices never match.

## Cross-site requests

A request that changes something and names another origin (`Origin`, `Sec-Fetch-Site`) is refused, even from a Tailnet address: that identity belongs to the machine, not to the page that asked. Session cookies are `HttpOnly` and `SameSite=Strict`, and `Secure` over HTTPS.

## Secrets (for the settings in #16)

- `requireFresh(event)` in a handler demands a recent passkey; a Tailnet identity or the service token is never enough.
- Credential fields are write-only: never returned, never in a query string, never in the audit trail.
- `audit(event, action, field)` records who, when and which field. `GET /api/auth/audit` lists it (`/security`).

## Configuration

See `deploy/systemd/ui.env.example`. `NUXT_AUTH_MODE=off` opens every route and exists for local development only; the service says so loudly on start.
