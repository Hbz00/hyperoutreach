# Authentication and the login rate limit

[← Back to the README](../README.md)

All mutations re-authenticate the signed session and verify its exact CSRF token.
Health, the Microsoft OAuth callback, and the Graph webhook are public; OAuth
initiation requires either an operator session or the server-side bearer token.
The application bounds failed login attempts per forwarded client address and
across all addresses. Those windows exist to damp noise and to keep a wrong
password cheap; they are deliberately not what stops a determined guessing
attack, and the trusted reverse-proxy rate limit is not optional advice for
distributed or multi-process deployments — it is the bound.

The reason is worth stating rather than leaving to be discovered. The forwarded
address is written by the client, so an attacker rotates it and never meets
their own window. Only the shared window is left, and a shared window that
refuses everyone locks the single operator out of their own installation after
a minute of anonymous requests from anywhere. So the credentials are evaluated
before the windows decide, and a correct password is always admitted. The cost
is that a wrong password answers 429 and a right one answers 303, which tells
an attacker whether a guess was right. That is unavoidable here: "a correct
password always works" and "an attacker cannot test passwords" are the same
statement negated, and with one shared secret and no out-of-band recovery the
availability of the account is the property worth keeping.

## Secrets at rest

Microsoft refresh/access tokens and SMTP/IMAP passwords are stored as
AES-256-GCM envelopes under the `TOKEN_ENCRYPTION_KEYS` keyring and are never
rendered back to the operator. To rotate, add a new `id:key` pair to the
comma-separated keyring, switch `TOKEN_ENCRYPTION_ACTIVE_KEY_ID` to it, and keep
the retired key until every stored secret has been read and re-encrypted.
Upstream response bodies and secrets are never included in application errors.
