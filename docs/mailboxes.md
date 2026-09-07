# Mailboxes: Microsoft 365 and SMTP/IMAP

[← Back to the README](../README.md)

## Microsoft 365

Register a Microsoft Entra web application whose redirect URI exactly matches
`MICROSOFT_REDIRECT_URI`. Grant
delegated `Mail.ReadWrite` and `Mail.Send`; the former is required to create and
retrieve the persisted draft, while the latter sends it. OAuth also asks for
`openid profile email offline_access`. No directory-wide application permission
is used.

Sending and inbound reconciliation resolve the adapter from each connected
mailbox. Graph notification drain and subscription maintenance likewise follow
available Microsoft mailbox rows. The global `MAIL_PROVIDER` selects the fallback
when no mailbox is bound; it does not disable maintenance for connected Graph
mailboxes in a mixed-provider installation.

Generate a 32-byte encryption key and assign it a stable ID:

```bash
openssl rand -base64 32
# TOKEN_ENCRYPTION_ACTIVE_KEY_ID=prod-v1
# TOKEN_ENCRYPTION_KEYS=prod-v1:<generated value>
```

To rotate keys, add `prod-v2:<new value>` to the comma-separated keyring, switch
the active ID to `prod-v2`, and retain `prod-v1` until stored secrets have been
read and re-encrypted. Refresh and access tokens are AES-256-GCM encrypted at
rest. OAuth state is hashed; its encrypted PKCE verifier expires and becomes
single-use after callback consumption. Upstream response bodies and secrets are
not included in application errors.

Set `OPERATOR_API_TOKEN` to a random value of at least 32 characters. Start a
connection from `/settings`, or call authenticated
`GET /api/integrations/microsoft/authorize` using
`Authorization: Bearer <OPERATOR_API_TOKEN>`. The route rejects unauthenticated
initiation and binds the callback to a short-lived HttpOnly browser cookie as
well as the hashed, single-use OAuth state. Configure the public
HTTPS notification URL as `/api/webhooks/microsoft`. That route echoes Microsoft's
plain-text endpoint challenge and constant-time compares each `clientState`.
Subscriptions request immutable IDs, expire in under seven days, and can be
created, renewed, and deleted by the mailbox services. Lifecycle events are
audited and executed for renewal, recreation, and delta recovery. Validated
webhook deliveries are persisted and acknowledged before Graph retrieval or
classification; claimed background reconciliation has stale-claim recovery.
Inbox delta pagination starts from a persisted five-minute-overlap anchor and
saves only a completed `@odata.deltaLink` after every item is durable; `410` or
`syncStateNotFound` triggers a safe rebaseline. Absolute continuation links are
confined to the configured Graph origin/version path. Webhook and delta messages
enter the same idempotent inbound path.

The ordered maintenance cycle reconciles available Microsoft mailboxes through
the same inbound stage as SMTP/IMAP. Microsoft notification-subscription
maintenance remains a separate responsibility: Trigger.dev runs its dedicated
five-minute schedule. The authenticated
`POST /api/internal/microsoft/reconcile` endpoint remains available for an
explicit local diagnostic or recovery run. The webhook's post-response worker
is only a latency optimization; database-backed reconciliation remains the
correctness boundary.

This Graph subscription lifecycle is deliberately separate from the aggregate
send-safety cycle. A self-hosted local Microsoft installation that requires
continuous webhook renewal must run that narrow operation through its own
infrastructure automation or use Trigger.dev; SMTP/IMAP does not require it.

Outbound mail creates an immutable-ID Graph draft with `X-Outreach-ID`, persists
the draft identity before sending, treats Graph's `202 Accepted` as uncertain,
and confirms the message through its immutable Sent Items identity. The provider
is bound to one mailbox. Mock mode follows the same mail contract without
Microsoft credentials.

Live Graph behavior has not been verified in this checkout because no Microsoft
credentials are present. The remaining live smoke check is to connect a test
mailbox through a public HTTPS callback, create and renew its subscription, send
one approved message to a controlled recipient, confirm its immutable Sent Items
identity, reply, and verify both webhook and delta ingestion.

## SMTP/IMAP mailboxes

Mail delivery is selected per mailbox. In `/settings`, use **Connect an
SMTP/IMAP mailbox** for providers that expose standard protocols (Zimbra,
university/company webmail, Fastmail, and similar services). Enter the mailbox
address, provider username, IMAP and SMTP endpoints, and preferably an
app-specific password. The connection is saved only after IMAP authentication,
Drafts/Sent folder discovery, and SMTP authentication all succeed.

Only encrypted transports are accepted: implicit TLS or mandatory STARTTLS.
`TOKEN_ENCRYPTION_ACTIVE_KEY_ID` and `TOKEN_ENCRYPTION_KEYS` are required because
the password is stored as an AES-256-GCM envelope and is never rendered back to
the operator. Disconnect waits for any in-flight mailbox action, then clears the
password envelope, transport configuration, and inbound cursor.

The automatic local worker and Trigger.dev both reconcile every available
SMTP/IMAP inbox once per minute through the shared durable inbound path. **Sync
now** is an additional operator action, not a correctness requirement. Before
classification or body persistence, mail must match an outbound identity;
unrelated private mailbox traffic is ignored.
Standard delivery-status reports become hard/soft bounce signals. Verified hard
bounces and definite SMTP recipient refusals suppress the dead address. For an
enrollment using the [address ladder](address-ladder.md), another eligible address
can produce a replacement message for approval; address death alone need not end
the person's enrollment. Exhausted ladders and other terminal outcomes stop it.
Ambiguous socket failures remain quarantined to prevent duplicate sends.

For local verification, `npm run db:up` starts loopback-only GreenMail and
`npm run test:integration` executes the real TLS IMAP/SMTP round trip. The suite
never uses production mailbox credentials.
