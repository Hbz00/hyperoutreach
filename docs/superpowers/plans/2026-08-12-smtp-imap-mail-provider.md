# Provider mail SMTP/IMAP — Implementation Plan

**Status:** Implemented and release-audited on 2026-08-13. The unchecked boxes
below preserve the original execution brief; current verification is recorded
in the repository test suites and README validation commands.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre l'envoi et la réception réels depuis une boîte Zimbra via SMTP/IMAP, avec un provider structurellement symétrique de `microsoft_graph`, et unifier au passage l'orchestration entrante aujourd'hui spécifique à Graph.

**Architecture:** Un provider `smtp_imap` implémente l'interface `MailProvider` existante. L'orchestration entrante est extraite derrière une interface `InboundMailSource` dont Graph et IMAP sont deux implémentations. Un registre indexé par `MailProviderKind` remplace les `if/else` et le gate global `MAIL_PROVIDER`, résolvant désormais le provider par boîte, côté entrant comme sortant.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM, PostgreSQL, Vitest, `nodemailer` (SMTP), `imapflow` (IMAP).

## Préalable obligatoire avant la première tâche

**L'index git contient déjà un chantier sans rapport** (le provider Codex CLI, une trentaine de
fichiers en `A`/`M`). Or `git add <chemins> && git commit -m` commite **tout l'index**, pas seulement
les chemins ajoutés : la première tâche emporterait ce chantier dans son commit.

Choisir l'une de ces trois options avant de commencer :

1. commiter ou remiser le chantier Codex CLI (`git stash push --staged`) ;
2. exécuter le plan dans un worktree isolé via `superpowers:using-git-worktrees` ;
3. remplacer chaque commit du plan par sa forme limitée aux chemins :
   `git commit -- <chemins> -m "..."`.

Sans ce choix, les commits du plan seront pollués.

## Global Constraints

- Spec de référence : `docs/superpowers/specs/2026-08-12-smtp-imap-mail-provider-design.md`.
- **L'état des dossiers IMAP n'est jamais autoritaire pour le statut d'envoi.** Le journal local `workflowEvents` a la précédence.
- Le `Message-ID` est **dérivé de l'`outreachId`**, jamais aléatoire.
- Aucune dépendance à `QRESYNC` ni `CONDSTORE` : capacités et noms de dossiers sont découverts à l'exécution.
- Le nom d'utilisateur SMTP/IMAP est **distinct** de l'adresse email (Zimbra attend `corentin.sacazes`).
- Chiffrement des secrets : réutiliser `encryptSecret`/`decryptSecret` de `@/lib/microsoft/token-crypto` avec le keyring `TOKEN_ENCRYPTION_KEYS`. Aucun code de chiffrement nouveau.
- Aucun test d'intégration ne vise le serveur de l'école. Conteneur local uniquement.
- Commandes : `npm test` (unitaires), `npm run test:integration`, `npm run typecheck`, `npm run lint`.
- Le code Microsoft Graph n'est pas supprimé et doit rester fonctionnellement inchangé.

---

## File Structure

**Créés :**

| Fichier                                                   | Responsabilité                                           |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `src/modules/mailboxes/provider-registry.ts`              | Registre sortant indexé par `MailProviderKind`           |
| `src/modules/mailboxes/inbound-source.ts`                 | Interface `InboundMailSource` et types de curseur        |
| `src/modules/mailboxes/inbound-reconciliation.ts`         | Orchestrateur partagé `reconcileInboundMailbox`          |
| `src/modules/mailboxes/inbound-source-registry.ts`        | Registre entrant indexé par `MailProviderKind`           |
| `src/modules/mailboxes/microsoft-graph-inbound-source.ts` | `InboundMailSource` pour Graph                           |
| `src/lib/smtp-imap/transport-config.ts`                   | Schéma zod du bloc `transport`, ports et sécurité        |
| `src/lib/smtp-imap/imap-client.ts`                        | Client IMAP : connexion, dossiers, APPEND, SEARCH, FETCH |
| `src/lib/smtp-imap/smtp-client.ts`                        | Client SMTP : soumission STARTTLS authentifiée           |
| `src/lib/smtp-imap/message-id.ts`                         | Dérivation déterministe du `Message-ID`                  |
| `src/lib/smtp-imap/mime.ts`                               | Construction du MIME sortant                             |
| `src/modules/mailboxes/smtp-imap-mail-provider.ts`        | `MailProvider` pour `smtp_imap`                          |
| `src/modules/mailboxes/smtp-imap-inbound-source.ts`       | `InboundMailSource` pour IMAP                            |
| `src/modules/mailboxes/smtp-imap-connection-service.ts`   | Ajout de boîte avec vérification préalable               |

**Modifiés :**

| Fichier                                                         | Nature                                                |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| `src/lib/db/schema.ts:83-86, 434-462`                           | Enum `smtp_imap`, `sync_cursor`, `encrypted_password` |
| `src/modules/mailboxes/mail-provider.ts:12`                     | `MailProviderKind` devient la source unique           |
| `src/modules/mailboxes/provider-factory.ts`                     | Délègue au registre                                   |
| `src/modules/messages/send-service.ts:107`                      | Union dérivée de `MailProviderKind`                   |
| `src/modules/mailboxes/microsoft-graph-sync-service.ts:572-742` | Orchestration extraite                                |
| `src/modules/workflows/service-factory.ts:230-241`              | Résolution par boîte                                  |
| `src/modules/workflows/task-contracts.ts`                       | Renommage de tâche                                    |
| `src/modules/workflows/runtime.ts:103`                          | Renommage de tâche                                    |
| `trigger/tasks.ts:40`                                           | Renommage de tâche                                    |
| `src/app/api/operator/commands/[command]/route.ts:630`          | Dispatch et nouvelle commande                         |
| `src/app/(operator)/settings/page.tsx`                          | Formulaire d'ajout et affichage                       |

---

## Task 1 : Type de provider unique et migration de schéma

**Files:**

- Modify: `src/lib/db/schema.ts:83-86`, `:451`, `:434-462`
- Modify: `src/modules/mailboxes/mail-provider.ts:12`
- Modify: `src/modules/messages/send-service.ts:107`
- Create: `drizzle/<généré>.sql`
- Test: `tests/unit/mail-provider-kind.test.ts`

**Interfaces:**

- Produces: `MailProviderKind = "mock" | "microsoft_graph" | "smtp_imap"`, colonnes `mailboxConnections.syncCursor` et `mailboxConnections.encryptedPassword`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/mail-provider-kind.test.ts
import { describe, expect, it } from "vitest";

import { mailboxProvider } from "@/lib/db/schema";
import type { MailProviderKind } from "@/modules/mailboxes/mail-provider";

describe("provider kind is a single source of truth", () => {
  it("keeps the database enum and the TypeScript union aligned", () => {
    const dbValues = [...mailboxProvider.enumValues].sort();
    const unionValues: MailProviderKind[] = [
      "microsoft_graph",
      "mock",
      "smtp_imap",
    ];
    expect(dbValues).toEqual([...unionValues].sort());
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- mail-provider-kind`
Expected: FAIL — l'enum ne contient pas `smtp_imap`.

- [ ] **Step 3: Étendre l'enum et les colonnes**

Dans `src/lib/db/schema.ts` :

```ts
export const mailboxProvider = pgEnum("mailbox_provider", [
  "mock",
  "microsoft_graph",
  "smtp_imap",
]);
```

Dans la table `mailboxConnections`, remplacer `deltaLink` et ajouter le mot de passe :

```ts
    syncCursor: text("sync_cursor"),
    encryptedPassword: text("encrypted_password"),
```

- [ ] **Step 4: Aligner l'union TypeScript**

Dans `src/modules/mailboxes/mail-provider.ts` :

```ts
export type MailProviderKind = "mock" | "microsoft_graph" | "smtp_imap";
```

Dans `src/modules/messages/send-service.ts:107`, remplacer l'union codée en dur :

```ts
provider: MailProviderKind | null;
```

et ajouter l'import `import type { MailProviderKind } from "@/modules/mailboxes/mail-provider";`.

- [ ] **Step 5: Renommer les usages de `deltaLink`**

Remplacer `deltaLink` par `syncCursor` dans `src/modules/mailboxes/microsoft-graph-sync-service.ts` (lignes 674, 682, 729) et `src/modules/mailboxes/microsoft-oauth-service.ts` (lignes 278, 475).

- [ ] **Step 6: Générer et appliquer la migration**

```bash
npm run db:generate
npm run db:migrate
```

Vérifier que le SQL généré contient `ALTER TYPE "mailbox_provider" ADD VALUE 'smtp_imap'`, `ALTER TABLE "mailbox_connections" RENAME COLUMN "delta_link" TO "sync_cursor"` et l'ajout de `encrypted_password`. **Si drizzle génère un DROP/ADD au lieu d'un RENAME, éditer le fichier SQL à la main pour préserver les données.**

Note PostgreSQL : `scripts/migrate.ts` utilise le migrateur drizzle, qui exécute chaque fichier dans
une transaction. Sur PostgreSQL 17, `ALTER TYPE ... ADD VALUE` y est autorisé, mais la valeur ajoutée
**ne peut pas être utilisée dans la même transaction**. Cette migration se contente d'altérer des
colonnes, donc elle passe. En revanche, toute écriture ultérieure employant `'smtp_imap'` (seed,
backfill) doit vivre dans un **fichier de migration distinct**.

- [ ] **Step 7: Vérifier**

Run: `npm test -- mail-provider-kind && npm run typecheck && npm test`
Expected: PASS partout. `npm run typecheck` signalera tout usage résiduel de `deltaLink`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema.ts src/modules/mailboxes/mail-provider.ts src/modules/messages/send-service.ts src/modules/mailboxes/microsoft-graph-sync-service.ts src/modules/mailboxes/microsoft-oauth-service.ts drizzle tests/unit/mail-provider-kind.test.ts
git commit -m "feat: ajoute le type de provider smtp_imap et generalise le curseur de synchronisation"
```

---

## Task 2 : Registre des providers sortants

**Files:**

- Create: `src/modules/mailboxes/provider-registry.ts`
- Modify: `src/modules/mailboxes/provider-factory.ts`
- Test: `tests/unit/mail-provider-registry.test.ts`

**Interfaces:**

- Consumes: `MailProviderKind` (Task 1).
- Produces: `registerMailProvider(kind, factory)`, `resolveMailProvider(db, mailbox, deps)`.

Le registre supprime deux défauts de `provider-factory.ts` : la chaîne de `if`, et l'exigence d'un `microsoftConfig` même pour une boîte qui n'en a pas besoin. Chaque entrée résout **paresseusement** sa configuration.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/mail-provider-registry.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { resolveMailProvider } =
  await import("@/modules/mailboxes/provider-registry");

const smtpMailbox = {
  id: "11111111-1111-1111-1111-111111111111",
  provider: "smtp_imap" as const,
  status: "available" as const,
};

describe("mail provider registry", () => {
  it("resolves an smtp_imap mailbox without any Microsoft configuration", async () => {
    const provider = await resolveMailProvider({} as never, smtpMailbox, {
      microsoftConfig: undefined,
    });
    expect(provider.kind).toBe("smtp_imap");
  });

  it("fails loudly for an unregistered provider kind", async () => {
    await expect(
      resolveMailProvider(
        {} as never,
        { ...smtpMailbox, provider: "unknown" as never },
        {},
      ),
    ).rejects.toThrow("Unsupported mail provider");
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- mail-provider-registry`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 3: Écrire le registre**

```ts
// src/modules/mailboxes/provider-registry.ts
import "server-only";

import type { AppDatabase } from "@/lib/db/types";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import type {
  MailProvider,
  MailProviderKind,
} from "@/modules/mailboxes/mail-provider";

export type MailProviderDependencies = {
  microsoftConfig?: MicrosoftConfig;
};

export type MailboxRow = {
  id: string;
  provider: MailProviderKind;
  status: string;
};

type MailProviderFactory = (
  db: AppDatabase,
  mailbox: MailboxRow,
  deps: MailProviderDependencies,
) => Promise<MailProvider> | MailProvider;

const registry = new Map<MailProviderKind, MailProviderFactory>();

export function registerMailProvider(
  kind: MailProviderKind,
  factory: MailProviderFactory,
): void {
  registry.set(kind, factory);
}

export async function resolveMailProvider(
  db: AppDatabase,
  mailbox: MailboxRow,
  deps: MailProviderDependencies,
): Promise<MailProvider> {
  const factory = registry.get(mailbox.provider);
  if (!factory) {
    throw new Error(`Unsupported mail provider: ${mailbox.provider}`);
  }
  return factory(db, mailbox, deps);
}
```

Enregistrer `mock` et `microsoft_graph` dans un module d'amorçage importé par `provider-factory.ts`, en déplaçant le corps des `if` existants dans les fabriques correspondantes. La fabrique `smtp_imap` sera branchée en Task 8 ; d'ici là elle lève `new Error("smtp_imap provider not implemented yet")`, ce qui suffit à faire passer le premier test si celui-ci vérifie `kind` sur une fabrique factice enregistrée dans le test.

> Note d'implémentation : dans le test ci-dessus, enregistrer une fabrique factice `smtp_imap` via `registerMailProvider` avant l'assertion, afin de tester le registre et non le provider.

- [ ] **Step 4: Faire déléguer la fabrique existante**

`createMailProviderForMailbox` conserve sa signature publique et son chargement de la boîte, puis délègue à `resolveMailProvider`. Aucun appelant ne change.

- [ ] **Step 5: Vérifier**

Run: `npm test -- mail-provider-registry && npm test && npm run typecheck`
Expected: PASS. Les tests d'envoi existants doivent passer inchangés.

- [ ] **Step 6: Commit**

```bash
git add src/modules/mailboxes/provider-registry.ts src/modules/mailboxes/provider-factory.ts tests/unit/mail-provider-registry.test.ts
git commit -m "refactor: remplace la chaine de if du provider mail par un registre"
```

---

## Task 3 : Extraction de l'orchestrateur entrant partagé

**Files:**

- Create: `src/modules/mailboxes/inbound-source.ts`
- Create: `src/modules/mailboxes/inbound-reconciliation.ts`
- Create: `src/modules/mailboxes/microsoft-graph-inbound-source.ts`
- Modify: `src/modules/mailboxes/microsoft-graph-sync-service.ts:572-742`
- Test: `tests/unit/inbound-reconciliation.test.ts`

**Interfaces:**

- Produces: `InboundMailSource` ; et **exactement** cette signature, à respecter à l'identique en Task 4 :

```ts
export async function reconcileInboundMailbox(
  target: { source: InboundMailSource; mailboxId: string },
  deps: {
    loadCursor: (mailboxId: string) => Promise<string | null>;
    saveCursor: (
      mailboxId: string,
      cursor: string,
      rebaselined: boolean,
    ) => Promise<void>;
    ingest: (
      message: unknown,
    ) => Promise<{ ok: boolean; disposition?: string; code?: string }>;
  },
): Promise<{ processed: number; nextCursor: string; rebaselined: boolean }>;
```

Les dépendances sont injectées — c'est ce qui rend l'orchestrateur testable sans base ni réseau, et
c'est la forme utilisée par les tests ci-dessous comme par le handler de Task 4.

C'est le cœur du refactor. `reconcileGraphDelta` (lignes 572-655) est déjà agnostique : verrous, événement de santé, try/catch, planification de reprise. Seul `reconcileGraphDeltaLocked` est spécifique.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/inbound-reconciliation.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { reconcileInboundMailbox } =
  await import("@/modules/mailboxes/inbound-reconciliation");

describe("shared inbound reconciliation", () => {
  it("advances the cursor and ingests every returned message", async () => {
    const fetchSince = vi.fn().mockResolvedValue({
      messages: [{ providerMessageId: "uid-1" }],
      nextCursor: "1:42",
      rebaselined: false,
    });
    const ingest = vi
      .fn()
      .mockResolvedValue({ ok: true, disposition: "processed" });

    const result = await reconcileInboundMailbox(
      { source: { kind: "smtp_imap", fetchSince }, mailboxId: "mbx-1" },
      { loadCursor: async () => null, saveCursor: vi.fn(), ingest },
    );

    expect(fetchSince).toHaveBeenCalledWith(null);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.nextCursor).toBe("1:42");
  });

  it("propagates the rebaseline flag", async () => {
    const result = await reconcileInboundMailbox(
      {
        source: {
          kind: "smtp_imap",
          fetchSince: async () => ({
            messages: [],
            nextCursor: "2:0",
            rebaselined: true,
          }),
        },
        mailboxId: "mbx-1",
      },
      { loadCursor: async () => "1:9", saveCursor: vi.fn(), ingest: vi.fn() },
    );
    expect(result.rebaselined).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- inbound-reconciliation`
Expected: FAIL — module absent.

- [ ] **Step 3: Définir l'interface**

```ts
// src/modules/mailboxes/inbound-source.ts
import type { MailProviderKind } from "@/modules/mailboxes/mail-provider";

export type InboundFetchResult = {
  nextCursor: string;
  rebaselined: boolean;
};

export interface InboundMailSource {
  readonly kind: MailProviderKind;
  fetchSince(
    cursor: string | null,
    ingestPage: (messages: unknown[]) => Promise<number>,
  ): Promise<InboundFetchResult>;
}
```

`messages` est typé `unknown[]` : `ingestInboundMessage` valide déjà l'entrée par zod (`inbound-service.ts:34-51`). Dupliquer ce schéma ici violerait DRY.

**La source ne retourne pas les messages, elle les pousse.** `ingestPage` est fourni par
l'orchestrateur et appelé **une fois par page, au fur et à mesure de la récupération** ; il retourne
le nombre de messages effectivement traités, que l'orchestrateur cumule.

Ce choix est normatif, et il corrige un défaut de conception : une interface qui retourne
`messages: unknown[]` accumule toutes les pages en mémoire avant ingestion — tout le backlog lors
d'une première synchronisation — et surtout, un échec sur la page N annule l'ingestion des pages
1..N-1. Une seule page empoisonnée gèlerait alors définitivement la détection des réponses. Le
streaming page par page reproduit le comportement d'origine et borne la mémoire.

- [ ] **Step 4: Écrire l'orchestrateur**

Déplacer le corps de `reconcileGraphDelta` (572-655) dans `reconcileInboundMailbox`, en remplaçant les littéraux Graph par des valeurs dérivées de `source.kind` :

- clé de verrou : `` `inbound-delta:${source.kind}:${mailboxId}` ``
- clé d'idempotence : `` `${source.kind}:inbound-health:${mailboxId}` ``
- nom d'événement : `` `${source.kind}.inbound_failed` ``
- `workflowName` : `"inbound_reconciliation"`

La boucle d'ingestion, la persistance du curseur, le recul d'ancre de 5 minutes et l'insertion du `workflowEvent` final proviennent de `reconcileGraphDeltaLocked` (657-742) et deviennent partagés.

- [ ] **Step 5: Réimplémenter Graph au-dessus de l'interface**

`microsoft-graph-inbound-source.ts` contient la pagination `@odata.nextLink`, la construction de l'URL `/me/mailFolders/Inbox/messages/delta`, la conversion par `graphMessageToInbound`, et la traduction du `410`/`syncStateNotFound` en `rebaselined: true`.

`reconcileGraphDelta` devient un mince adaptateur conservant sa signature, pour ne casser aucun appelant.

- [ ] **Step 6: Vérifier la non-régression Graph**

Run: `npm test && npm run test:integration -- microsoft-graph-integration`
Expected: PASS sans modification des tests Graph existants. **Si un test Graph doit être modifié, c'est que le refactor a changé le comportement : corriger le code, pas le test.**

- [ ] **Step 7: Commit**

```bash
git add src/modules/mailboxes/inbound-source.ts src/modules/mailboxes/inbound-reconciliation.ts src/modules/mailboxes/microsoft-graph-inbound-source.ts src/modules/mailboxes/microsoft-graph-sync-service.ts tests/unit/inbound-reconciliation.test.ts
git commit -m "refactor: extrait l'orchestration entrante partagee derriere InboundMailSource"
```

---

## Task 4 : Tâche entrante résolue par boîte

**Files:**

- Create: `src/modules/mailboxes/inbound-source-registry.ts`
- Modify: `src/modules/workflows/task-contracts.ts:48-52, 106, 167`
- Modify: `src/modules/workflows/service-factory.ts:230-241`
- Modify: `src/modules/workflows/runtime.ts:103`
- Modify: `trigger/tasks.ts:40`
- Modify: `src/app/api/operator/commands/[command]/route.ts:630-644`
- Test: `tests/unit/inbound-task-routing.test.ts`

**Interfaces:**

- Consumes: `InboundMailSource` (Task 3), `MailProviderKind` (Task 1).
- Produces: tâche `reconcile-inbound-mailbox`, `resolveInboundSource(db, mailbox, deps)`.

C'est la correction d'incohérence identifiée dans le spec : `service-factory.ts:231` conditionne le sync à la variable **globale** `MAIL_PROVIDER`, alors que le sortant résout par boîte.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/inbound-task-routing.test.ts
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_TASKS,
  workflowTaskNames,
} from "@/modules/workflows/task-contracts";

describe("inbound sync task", () => {
  it("is named after the mailbox concept, not the Graph provider", () => {
    expect(workflowTaskNames).toContain("reconcile-inbound-mailbox");
    expect(workflowTaskNames).not.toContain("reconcile-graph-delta");
  });

  it("keeps the retry envelope of the task it replaces", () => {
    expect(WORKFLOW_TASKS["reconcile-inbound-mailbox"]).toEqual({
      maxDuration: 300,
      retry: { maxAttempts: 4, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
    });
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- inbound-task-routing`
Expected: FAIL — la tâche s'appelle encore `reconcile-graph-delta`.

- [ ] **Step 3: Renommer la tâche**

Dans `task-contracts.ts`, renommer la clé dans `WORKFLOW_TASKS`, dans `WorkflowPayloads` (payload inchangé : `{ mailboxId: string }`) et dans le map de schémas zod. Répercuter dans `runtime.ts:103` et `trigger/tasks.ts:40` (`export const reconcileInboundMailboxTask = regularTask("reconcile-inbound-mailbox");`).

- [ ] **Step 4: Supprimer le gate global**

Dans `service-factory.ts`, remplacer le handler :

```ts
    "reconcile-inbound-mailbox": async (payload) => {
      const [mailbox] = await db
        .select()
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, payload.mailboxId))
        .limit(1);
      if (!mailbox) throw new Error("Mailbox not found");
      const source = await resolveInboundSource(db, mailbox, { environment });
      return reconcileInboundMailbox(
        { source, mailboxId: payload.mailboxId },
        inboundDependencies(db, classifier),
      );
    },
```

`resolveInboundSource` est le pendant entrant du registre de Task 2 : `microsoft_graph` y résout paresseusement `requireMicrosoftConfig`, `smtp_imap` ne requiert rien, `mock` retourne une source vide.

Les tâches `drain-graph-webhooks` et `maintain-graph-subscriptions` **conservent** leur gate `MAIL_PROVIDER` : elles n'ont pas d'équivalent IMAP.

- [ ] **Step 4-bis: Étendre la garde d'envoi au nouveau provider**

`send-service.ts:601-604` bloque l'envoi tant qu'une synchronisation entrante est en échec, en
filtrant sur `workflowName IN ("graph_lifecycle_reconciliation", "graph_delta_health")`. Ces
littéraux sont **load-bearing** : c'est pourquoi Graph les conserve.

Une boîte `smtp_imap` produit `workflowName: "inbound_reconciliation"`, absent de cette liste : sans
correction, elle enverrait à l'aveugle alors qu'elle ne sait plus lire les réponses. Ajoute
`"inbound_reconciliation"` à la liste, et vérifie que la condition englobante
(`send-service.ts:577`, aujourd'hui bornée à `mailboxProvider === "microsoft_graph"`) couvre bien
les deux providers réels.

Écris d'abord le test qui échoue : une boîte `smtp_imap` avec un `workflowEvent`
`inbound_reconciliation` en statut `failed` doit voir son envoi bloqué.

- [ ] **Step 5: Mettre à jour le déclencheur UI**

Dans `route.ts:636`, changer `task: "reconcile-graph-delta"` en `task: "reconcile-inbound-mailbox"` et la clé d'idempotence en `` `ui:inbound-sync:${mailboxId}:${randomUUID()}` ``.

- [ ] **Step 6: Vérifier**

Run: `npm test && npm run test:integration -- workflow-runtime && npm run typecheck`
Expected: PASS. Le typecheck garantit qu'aucune référence à l'ancien nom ne subsiste.

- [ ] **Step 7: Commit**

```bash
git add src/modules/mailboxes/inbound-source-registry.ts src/modules/workflows src/app/api/operator/commands trigger/tasks.ts tests/unit/inbound-task-routing.test.ts
git commit -m "refactor: resout la synchronisation entrante par boite au lieu du gate global"
```

---

## Task 5 : Configuration de transport et identifiants chiffrés

**Files:**

- Create: `src/lib/smtp-imap/transport-config.ts`
- Test: `tests/unit/smtp-imap-transport-config.test.ts`

**Interfaces:**

- Produces: `transportConfigSchema`, `type MailboxTransport`, `readTransport(settings)`, `writeTransport(transport)`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-transport-config.test.ts
import { describe, expect, it } from "vitest";

import {
  readTransport,
  transportConfigSchema,
} from "@/lib/smtp-imap/transport-config";

const valid = {
  username: "corentin.sacazes",
  imap: { host: "webmail.polytechnique.fr", port: 993, security: "tls" },
  smtp: { host: "webmail.polytechnique.fr", port: 587, security: "starttls" },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};

describe("mailbox transport configuration", () => {
  it("accepts a Zimbra style configuration whose username is not an email", () => {
    const parsed = transportConfigSchema.parse(valid);
    expect(parsed.username).toBe("corentin.sacazes");
    expect(parsed.username).not.toContain("@");
  });

  it("rejects a plaintext IMAP port", () => {
    expect(() =>
      transportConfigSchema.parse({
        ...valid,
        imap: { host: "h", port: 143, security: "none" },
      }),
    ).toThrow();
  });

  it("returns null when the settings blob carries no transport", () => {
    expect(readTransport({})).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-transport-config`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/smtp-imap/transport-config.ts
import { z } from "zod";

const endpointSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  security: z.enum(["tls", "starttls"]),
});

export const transportConfigSchema = z.object({
  username: z.string().trim().min(1).max(320),
  imap: endpointSchema,
  smtp: endpointSchema,
  folders: z.object({
    drafts: z.string().trim().min(1),
    sent: z.string().trim().min(1),
    inbox: z.string().trim().min(1).default("INBOX"),
  }),
});

export type MailboxTransport = z.infer<typeof transportConfigSchema>;

export function readTransport(
  settings: Record<string, unknown>,
): MailboxTransport | null {
  const parsed = transportConfigSchema.safeParse(settings.transport);
  return parsed.success ? parsed.data : null;
}

export function writeTransport(
  settings: Record<string, unknown>,
  transport: MailboxTransport,
): Record<string, unknown> {
  return { ...settings, transport };
}
```

L'absence de `"none"` dans l'enum `security` rend le chiffrement non négociable : c'est ce qui fait échouer le second test.

- [ ] **Step 4: Vérifier**

Run: `npm test -- smtp-imap-transport-config`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/smtp-imap/transport-config.ts tests/unit/smtp-imap-transport-config.test.ts
git commit -m "feat: ajoute la configuration de transport smtp/imap validee"
```

---

## Task 6 : Message-ID déterministe et construction MIME

**Files:**

- Create: `src/lib/smtp-imap/message-id.ts`
- Create: `src/lib/smtp-imap/mime.ts`
- Test: `tests/unit/smtp-imap-message-id.test.ts`

**Interfaces:**

- Produces: `outreachMessageId(outreachId, domain)`, `buildMime(input, transport, messageId)`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-message-id.test.ts
import { describe, expect, it } from "vitest";

import { buildMime } from "@/lib/smtp-imap/mime";
import { outreachMessageId } from "@/lib/smtp-imap/message-id";

describe("deterministic message id", () => {
  it("returns the same value for the same outreach id", () => {
    const a = outreachMessageId("outreach-42", "polytechnique.edu");
    const b = outreachMessageId("outreach-42", "polytechnique.edu");
    expect(a).toBe(b);
    expect(a).toMatch(/^<.+@polytechnique\.edu>$/);
  });

  it("differs across outreach ids", () => {
    expect(outreachMessageId("a", "d.tld")).not.toBe(
      outreachMessageId("b", "d.tld"),
    );
  });

  it("embeds the identifier in the MIME headers", () => {
    const mime = buildMime(
      {
        sender: "corentin.sacazes@polytechnique.edu",
        recipient: "prospect@example.com",
        subject: "Sujet",
        body: "Corps",
        headers: { "X-Outreach-ID": "outreach-42" },
      },
      outreachMessageId("outreach-42", "polytechnique.edu"),
    );
    expect(mime).toContain("Message-ID: <");
    expect(mime).toContain("X-Outreach-ID: outreach-42");
  });

  it("refuses header injection through the subject", () => {
    expect(() =>
      buildMime(
        {
          sender: "a@b.tld",
          recipient: "c@d.tld",
          subject: "Sujet\r\nBcc: attaquant@example.com",
          body: "Corps",
          headers: {},
        },
        "<x@b.tld>",
      ),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-message-id`
Expected: FAIL — modules absents.

- [ ] **Step 3: Implémenter**

`outreachMessageId` construit `` `<${encodeURIComponent(outreachId)}.hyperoutreach@${domain}>` ``. Aucun aléa, aucune horloge.

`buildMime` assemble les en-têtes `From`, `To`, `Subject`, `Date`, `Message-ID`, `MIME-Version`, `Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: base64`, puis les en-têtes personnalisés. Il **lève** si une valeur d'en-tête contient `\r` ou `\n`, en miroir de la validation déjà présente dans `MicrosoftGraphMailProvider.createDraft` (lignes 36-44). Le sujet est encodé en RFC 2047 s'il sort de l'ASCII.

- [ ] **Step 4: Vérifier**

Run: `npm test -- smtp-imap-message-id`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/smtp-imap/message-id.ts src/lib/smtp-imap/mime.ts tests/unit/smtp-imap-message-id.test.ts
git commit -m "feat: ajoute le message-id deterministe et la construction mime"
```

---

## Task 7 : Clients IMAP et SMTP

**Files:**

- Create: `src/lib/smtp-imap/imap-client.ts`
- Create: `src/lib/smtp-imap/smtp-client.ts`
- Modify: `package.json`
- Test: `tests/unit/smtp-imap-folder-resolution.test.ts`

**Interfaces:**

- Consumes: `MailboxTransport` (Task 5).
- Produces: `ImapClient` avec `resolveFolders()`, `appendDraft(mime)`, `findByMessageId(folder, messageId)`, `fetchSince(uidValidity, lastUid)`, `moveToSent(uid)` ; `SmtpClient.submit(mime, envelope)`.

- [ ] **Step 1: Installer les dépendances**

```bash
npm install imapflow nodemailer
npm install --save-dev @types/nodemailer
```

- [ ] **Step 2: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-folder-resolution.test.ts
import { describe, expect, it } from "vitest";

import { resolveFolderRoles } from "@/lib/smtp-imap/imap-client";

describe("folder discovery", () => {
  it("prefers special-use flags over folder names", () => {
    const roles = resolveFolderRoles([
      { path: "Brouillons", specialUse: "\\Drafts" },
      { path: "Envoyes", specialUse: "\\Sent" },
      { path: "INBOX", specialUse: undefined },
    ]);
    expect(roles.drafts).toBe("Brouillons");
    expect(roles.sent).toBe("Envoyes");
  });

  it("falls back to conventional names when no flag is advertised", () => {
    const roles = resolveFolderRoles([
      { path: "Drafts", specialUse: undefined },
      { path: "Sent", specialUse: undefined },
      { path: "INBOX", specialUse: undefined },
    ]);
    expect(roles.drafts).toBe("Drafts");
    expect(roles.sent).toBe("Sent");
  });

  it("throws when neither a flag nor a conventional name exists", () => {
    expect(() =>
      resolveFolderRoles([{ path: "INBOX", specialUse: undefined }]),
    ).toThrow("Unable to resolve the Drafts folder");
  });
});
```

- [ ] **Step 3: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-folder-resolution`
Expected: FAIL — module absent.

- [ ] **Step 4: Implémenter**

`resolveFolderRoles` est une fonction pure exportée : c'est ce qui rend la découverte testable sans serveur. Ordre de résolution : drapeau `\Drafts`/`\Sent`, puis noms conventionnels (`Drafts`, `Brouillons`, `Sent`, `Sent Items`, `Envoyés`), sinon exception explicite.

`ImapClient` encapsule `imapflow`. Il n'expose **aucun** type d'`imapflow` dans sa signature publique, pour que le provider reste testable par doublure. `appendDraft` retourne `{ uidValidity, uid }` en utilisant `APPENDUID` si le serveur l'annonce, sinon en recherchant le `Message-ID`.

`SmtpClient` encapsule `nodemailer` avec `secure: false` et `requireTLS: true` pour le port 587, et retourne l'accusé une fois le `250` reçu.

- [ ] **Step 5: Vérifier**

Run: `npm test -- smtp-imap-folder-resolution && npm run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/smtp-imap tests/unit/smtp-imap-folder-resolution.test.ts
git commit -m "feat: ajoute les clients imap et smtp avec decouverte des dossiers"
```

---

## Task 8 : Provider `smtp_imap` — création de brouillon

**Files:**

- Create: `src/modules/mailboxes/smtp-imap-mail-provider.ts`
- Test: `tests/unit/smtp-imap-provider-draft.test.ts`

**Interfaces:**

- Consumes: `ImapClient` (Task 7), `outreachMessageId`/`buildMime` (Task 6).
- Produces: `SmtpImapMailProvider` implémentant `MailProvider`, `draftId` au format `` `${uidValidity}:${uid}` ``.

**Expéditeur nul.** `MailDraftInput.sender` est `string | null`, alors que `buildMime` exige un
expéditeur. Quand `input.sender` est `null`, `createDraft` retombe sur **l'adresse de la boîte
connectée** : en SMTP authentifié, l'expéditeur _est_ la boîte, il n'y a pas d'autre valeur
légitime. Ne lève pas, ne laisse pas passer une chaîne vide.

**Signature de `buildMime`.** Deux paramètres — `buildMime(input, messageId)`. Le domaine de
l'expéditeur est porté par le constructeur du provider (`senderDomain`), pas par `buildMime`.

**Constructeur définitif, à écrire dès maintenant en 5 paramètres** — le journal n'est utilisé qu'à
partir de Task 9, mais l'ajouter plus tard casserait les tests commités ici :

```ts
constructor(
  private readonly imap: ImapClient,
  private readonly smtp: SmtpClient,
  private readonly boundMailboxId: string,
  private readonly senderDomain: string,
  private readonly journal: SendJournal,
)
```

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-provider-draft.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SmtpImapMailProvider } =
  await import("@/modules/mailboxes/smtp-imap-mail-provider");

const input = {
  outreachId: "outreach-42",
  mailboxId: "mbx-1",
  sender: "corentin.sacazes@polytechnique.edu",
  recipient: "prospect@example.com",
  subject: "Sujet",
  body: "Corps",
  headers: {},
};

describe("smtp_imap createDraft", () => {
  it("reuses an existing draft found by message id instead of appending twice", async () => {
    const imap = {
      findByMessageId: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 12 }),
      appendDraft: vi.fn(),
    };
    const provider = new SmtpImapMailProvider(
      imap as never,
      {} as never,
      "mbx-1",
      "polytechnique.edu",
      {} as never,
    );

    const draft = await provider.createDraft(input as never);

    expect(draft.draftId).toBe("7:12");
    expect(imap.appendDraft).not.toHaveBeenCalled();
  });

  it("appends when no draft exists yet", async () => {
    const imap = {
      findByMessageId: vi.fn().mockResolvedValue(null),
      appendDraft: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 13 }),
    };
    const provider = new SmtpImapMailProvider(
      imap as never,
      {} as never,
      "mbx-1",
      "polytechnique.edu",
      {} as never,
    );

    const draft = await provider.createDraft(input as never);

    expect(draft.draftId).toBe("7:13");
    expect(imap.appendDraft).toHaveBeenCalledTimes(1);
  });

  it("refuses a mailbox binding mismatch", async () => {
    const provider = new SmtpImapMailProvider(
      {} as never,
      {} as never,
      "mbx-1",
      "boite@d.tld",
      {} as never,
    );
    await expect(
      provider.createDraft({ ...input, mailboxId: "autre" } as never),
    ).rejects.toThrow("mailbox binding mismatch");
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-provider-draft`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `createDraft`**

Reproduire `assertMailbox` de `MicrosoftGraphMailProvider` (lignes 27-31). `createDraft` calcule le `Message-ID`, **cherche d'abord** dans Drafts, réutilise si trouvé, sinon construit le MIME et fait l'`APPEND`. C'est ce qui rend l'opération idempotente sans état local.

- [ ] **Step 4: Vérifier**

Run: `npm test -- smtp-imap-provider-draft`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/mailboxes/smtp-imap-mail-provider.ts tests/unit/smtp-imap-provider-draft.test.ts
git commit -m "feat: ajoute la creation de brouillon idempotente du provider smtp/imap"
```

---

## Task 9 : Envoi et journal d'acceptation

**Files:**

- Modify: `src/modules/mailboxes/smtp-imap-mail-provider.ts`
- Test: `tests/unit/smtp-imap-provider-send.test.ts`

**Interfaces:**

- Produces: événements `workflowEvents` `smtp.send_attempted` et `smtp.accepted`, clés `` `smtp-send-attempted:${messageKey}` `` et `` `smtp-accepted:${messageKey}` ``.

**C'est la tâche qui garantit l'absence de double envoi.** L'ordre des écritures y est normatif.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-provider-send.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SmtpImapMailProvider } =
  await import("@/modules/mailboxes/smtp-imap-mail-provider");

describe("smtp_imap sendDraft", () => {
  it("records acceptance before attempting the Sent copy", async () => {
    const order: string[] = [];
    const journal = {
      recordAttempt: vi.fn(async () => void order.push("attempt")),
      recordAcceptance: vi.fn(async () => void order.push("accepted")),
      hasAcceptance: vi.fn().mockResolvedValue(false),
      hasAttempt: vi.fn().mockResolvedValue(false),
    };
    const smtp = { submit: vi.fn(async () => void order.push("smtp")) };
    const imap = {
      moveToSent: vi.fn(async () => void order.push("sent-copy")),
    };

    const provider = new SmtpImapMailProvider(
      imap as never,
      smtp as never,
      "mbx-1",
      "boite@d.tld",
      journal as never,
    );
    const result = await provider.sendDraft({
      draftId: "7:13",
      outreachId: "outreach-42",
      mailboxId: "mbx-1",
    });

    expect(result.status).toBe("accepted");
    expect(order).toEqual(["attempt", "smtp", "accepted", "sent-copy"]);
  });

  it("still reports acceptance when the Sent copy fails", async () => {
    const journal = {
      recordAttempt: vi.fn(),
      recordAcceptance: vi.fn(),
      hasAcceptance: vi.fn().mockResolvedValue(false),
      hasAttempt: vi.fn().mockResolvedValue(false),
    };
    const provider = new SmtpImapMailProvider(
      {
        moveToSent: vi.fn().mockRejectedValue(new Error("IMAP down")),
      } as never,
      { submit: vi.fn() } as never,
      "mbx-1",
      "boite@d.tld",
      journal as never,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(journal.recordAcceptance).toHaveBeenCalledTimes(1);
  });

  it("never submits twice when acceptance is already recorded", async () => {
    const smtp = { submit: vi.fn() };
    const journal = {
      recordAttempt: vi.fn(),
      recordAcceptance: vi.fn(),
      hasAcceptance: vi.fn().mockResolvedValue(true),
      hasAttempt: vi.fn().mockResolvedValue(true),
    };
    const provider = new SmtpImapMailProvider(
      { moveToSent: vi.fn() } as never,
      smtp as never,
      "mbx-1",
      "boite@d.tld",
      journal as never,
    );

    await provider.sendDraft({
      draftId: "7:13",
      outreachId: "outreach-42",
      mailboxId: "mbx-1",
    });

    expect(smtp.submit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-provider-send`
Expected: FAIL — `sendDraft` n'existe pas encore.

- [ ] **Step 3: Implémenter**

Séquence normative :

1. si `hasAcceptance` → retourner `{ status: "accepted" }` sans rien soumettre ;
2. `recordAttempt` ;
3. `smtp.submit` ;
4. `recordAcceptance` **immédiatement** après le `250` ;
5. `moveToSent` en best-effort, dans un `try/catch` qui avale l'erreur.

Le journal s'appuie sur `workflowEvents` avec `onConflictDoNothing`, exactement comme `DatabaseMockMailProvider.sendDraft` (`mock-mail-provider.ts:145-160`).

- [ ] **Step 4: Vérifier**

Run: `npm test -- smtp-imap-provider-send`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/mailboxes/smtp-imap-mail-provider.ts tests/unit/smtp-imap-provider-send.test.ts
git commit -m "feat: ajoute l'envoi smtp avec journal d'acceptation local"
```

---

## Task 10 : Réconciliation et précédence

**Files:**

- Modify: `src/modules/mailboxes/smtp-imap-mail-provider.ts`
- Modify: `src/modules/mailboxes/provider-registry.ts`
- Test: `tests/unit/smtp-imap-provider-reconcile.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-provider-reconcile.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SmtpImapMailProvider } =
  await import("@/modules/mailboxes/smtp-imap-mail-provider");

function build(
  journal: Record<string, unknown>,
  imap: Record<string, unknown>,
) {
  return new SmtpImapMailProvider(
    imap as never,
    {} as never,
    "mbx-1",
    "boite@d.tld",
    journal as never,
  );
}

describe("smtp_imap reconcile precedence", () => {
  it("reports sent from the local journal even when the Sent copy is missing", async () => {
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(true),
        hasAttempt: vi.fn().mockResolvedValue(true),
      },
      { findByMessageId: vi.fn().mockResolvedValue(null) },
    );
    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: "7:13",
      mailboxId: "mbx-1",
    });
    expect(result?.status).toBe("sent");
  });

  it("reports drafted when nothing was ever attempted", async () => {
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(false),
        hasAttempt: vi.fn().mockResolvedValue(false),
      },
      {
        findByMessageId: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 13 }),
      },
    );
    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: null,
      mailboxId: "mbx-1",
    });
    expect(result).toEqual({ status: "drafted", draftId: "7:13" });
  });

  it("never reports drafted when an attempt has no recorded outcome", async () => {
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(false),
        hasAttempt: vi.fn().mockResolvedValue(true),
      },
      {
        findByMessageId: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 13 }),
      },
    );
    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: "7:13",
      mailboxId: "mbx-1",
    });
    expect(result?.status).not.toBe("drafted");
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-provider-reconcile`
Expected: FAIL.

- [ ] **Step 3: Implémenter la précédence**

Ordre strict :

1. `hasAcceptance` → `{ status: "sent", ... }`, et réparation best-effort de la copie Sent ;
2. sinon `hasAttempt` → **ne jamais** retourner `drafted` ; retourner `{ status: "accepted", draftId }`, ce que `send-service` traduit en `delivery_uncertain` ;
3. sinon recherche du `Message-ID` dans Sent → `sent` ; dans Drafts → `drafted` ; nulle part → `null`.

Le troisième test est le garde-fou contre le double envoi : il doit échouer si quelqu'un simplifie la précédence.

- [ ] **Step 4: Enregistrer le provider**

Brancher la fabrique `smtp_imap` dans le registre de Task 2 : elle lit la boîte, déchiffre le mot de passe via `decryptSecret`, lit le transport via `readTransport`, et construit `SmtpImapMailProvider`.

- [ ] **Step 5: Vérifier**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/mailboxes tests/unit/smtp-imap-provider-reconcile.test.ts
git commit -m "feat: ajoute la reconciliation smtp/imap avec precedence du journal local"
```

---

## Task 11 : Source entrante IMAP

**Files:**

- Create: `src/modules/mailboxes/smtp-imap-inbound-source.ts`
- Modify: `src/modules/mailboxes/inbound-source-registry.ts`
- Test: `tests/unit/smtp-imap-inbound-source.test.ts`

**Interfaces:**

- Consumes: `InboundMailSource` (Task 3), `ImapClient` (Task 7).
- Produces: curseur au format `` `${uidValidity}:${lastProcessedUid}` ``.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-inbound-source.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SmtpImapInboundSource } =
  await import("@/modules/mailboxes/smtp-imap-inbound-source");

describe("imap inbound source", () => {
  // L'orchestrateur fournit ingestPage ; la source pousse chaque page au fil de l'eau.
  const collect = () => {
    const seen: unknown[] = [];
    const ingestPage = async (messages: unknown[]) => {
      seen.push(...messages);
      return messages.length;
    };
    return { seen, ingestPage };
  };

  it("starts from the first uid when there is no cursor", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      // fetchRange est un generateur asynchrone pagine, pas une promesse de tableau.
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const result = await source.fetchSince(null, collect().ingestPage);
    expect(imap.fetchRange).toHaveBeenCalledWith("1:*");
    expect(result.rebaselined).toBe(false);
  });

  it("resumes after the last processed uid", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      // fetchRange est un generateur asynchrone pagine, pas une promesse de tableau.
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    await source.fetchSince("7:41", collect().ingestPage);
    expect(imap.fetchRange).toHaveBeenCalledWith("42:*");
  });

  it("rebaselines when uidvalidity changed", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 9 }),
      // fetchRange est un generateur asynchrone pagine, pas une promesse de tableau.
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const result = await source.fetchSince("7:41", collect().ingestPage);
    expect(result.rebaselined).toBe(true);
    expect(imap.fetchRange).toHaveBeenCalledWith("1:*");
  });

  it("advances the cursor to the highest fetched uid", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
        yield [
          {
            uid: 45,
            envelope: {
              messageId: "<b@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    const result = await source.fetchSince("7:41", ingestPage);
    expect(result.nextCursor).toBe("7:45");
    expect(seen).toHaveLength(2);
  });

  it("keeps an earlier page ingested when a later page throws", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
        throw new Error("IMAP a coupe en pleine pagination");
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await expect(source.fetchSince("7:41", ingestPage)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-inbound-source`
Expected: FAIL.

- [ ] **Step 3: Implémenter**

`fetchSince` lit l'`UIDVALIDITY` courant. S'il diffère de celui du curseur, il repart de `1:*` et signale `rebaselined: true` — l'exact analogue du `410`/`syncStateNotFound` de Graph. Chaque message est projeté vers la forme attendue par `inboundSchema` : `providerMessageId` = `` `imap:${uidValidity}:${uid}` ``, plus `internetMessageId`, `inReplyTo`, `references`, `sender`, `recipient`, `subject`, `body`, `receivedAt`.

**Analyse MIME du courrier entrant — ajout au périmètre initial.** L'extraction de corps livrée en
tâche 7 est une séparation en-têtes/corps avec décodage base64 conditionnel. Elle suffit pour les
messages que l'application produit elle-même, mais **pas** pour du courrier entrant réel : une
réponse écrite depuis Outlook, Gmail ou un téléphone arrive en `multipart/alternative`, souvent en
`quoted-printable`, avec une partie HTML. Une séparation naïve livrerait au classifieur un corps
truffé de délimiteurs MIME et de `=E9`.

L'enjeu est direct : ce corps est l'entrée du classifieur de réponses. Un corps illisible produit
une classification fausse, donc une séquence arrêtée à tort ou poursuivie à tort.

Ajouter `mailparser` (`npm install mailparser` et `@types/mailparser` en dev) et l'utiliser pour
extraire le texte des messages entrants : préférer `text`, retomber sur `html` converti en texte.
Ne pas l'utiliser côté sortant, où `buildMime` reste maître.

Test obligatoire : un message `multipart/alternative` en `quoted-printable` contenant des accents
doit produire un corps texte propre, sans délimiteur MIME ni séquence `=XX`.

Enregistrer la source dans le registre entrant.

- [ ] **Step 4: Vérifier**

Run: `npm test -- smtp-imap-inbound-source && npm test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/mailboxes tests/unit/smtp-imap-inbound-source.test.ts
git commit -m "feat: ajoute la source entrante imap avec curseur uidvalidity"
```

---

## Task 12 : Connexion vérifiée d'une boîte

**Files:**

- Create: `src/modules/mailboxes/smtp-imap-connection-service.ts`
- Modify: `src/app/api/operator/commands/[command]/route.ts`
- Test: `tests/unit/smtp-imap-connection-service.test.ts`

**Interfaces:**

- Produces: `connectSmtpImapMailbox(db, input, deps)` retournant `{ ok: true, mailbox } | { ok: false, code }`.

Exigence validée : la boîte ne passe `available` qu'après **preuve** de bout en bout.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/unit/smtp-imap-connection-service.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { verifyTransport } =
  await import("@/modules/mailboxes/smtp-imap-connection-service");

const transport = {
  username: "corentin.sacazes",
  imap: { host: "h", port: 993, security: "tls" as const },
  smtp: { host: "h", port: 587, security: "starttls" as const },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};

describe("connection verification", () => {
  it("fails with IMAP_AUTH_FAILED before touching SMTP", async () => {
    const smtpVerify = vi.fn();
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi.fn().mockRejectedValue(new Error("no")),
      smtpVerify,
    });
    expect(result).toEqual({ ok: false, code: "IMAP_AUTH_FAILED" });
    expect(smtpVerify).not.toHaveBeenCalled();
  });

  it("fails with SMTP_AUTH_FAILED when only SMTP rejects", async () => {
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi
        .fn()
        .mockResolvedValue({ drafts: "Drafts", sent: "Sent", inbox: "INBOX" }),
      smtpVerify: vi.fn().mockRejectedValue(new Error("no")),
    });
    expect(result).toEqual({ ok: false, code: "SMTP_AUTH_FAILED" });
  });

  it("returns the discovered folders on success", async () => {
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi.fn().mockResolvedValue({
        drafts: "Brouillons",
        sent: "Envoyes",
        inbox: "INBOX",
      }),
      smtpVerify: vi.fn().mockResolvedValue(undefined),
    });
    expect(result).toEqual({
      ok: true,
      folders: { drafts: "Brouillons", sent: "Envoyes", inbox: "INBOX" },
    });
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npm test -- smtp-imap-connection-service`
Expected: FAIL.

- [ ] **Step 3: Implémenter**

`verifyTransport` est pur vis-à-vis du réseau : il reçoit ses vérificateurs en dépendance, donc il se teste sans serveur. Ordre : IMAP d'abord (authentification + découverte des dossiers), SMTP ensuite (STARTTLS + `AUTH`, **sans envoi**).

**Deux exigences héritées de la tâche 10-bis, à traiter ici — c'est leur domicile naturel.**

La tâche 10-bis a introduit la révocation automatique d'une boîte sur échec d'authentification, pour
empêcher une boucle de tentatives qui verrouillerait le compte chez le fournisseur. Elle a laissé
deux dettes que cette tâche doit solder, faute de quoi une boîte devient irrécupérable.

**1. Resserrer la classification des échecs d'authentification.** Aujourd'hui un échec _transitoire_
révoque la boîte comme un mauvais mot de passe :

- côté SMTP, `nodemailer` pose `code: 'EAUTH'` pour **toute** réponse AUTH non-2xx ; un
  `454 4.7.0 Temporary authentication failure` — émis par Postfix quand le backend SASL est
  momentanément indisponible — révoque donc à tort. Restreindre à `EAUTH && responseCode >= 500`.
- côté IMAP, `imapflow` pose `serverResponseCode` **avant** de réassigner `response` : le
  discriminateur est présent sur l'objet et simplement ignoré. Exclure les codes RFC 5530
  transitoires `UNAVAILABLE`, `SERVERBUG`, `INUSE` — mais **pas** `EXPIRED`, qui est un vrai
  problème d'identifiants.

**2. `connectSmtpImapMailbox` doit pouvoir ressusciter une boîte révoquée.** C'est aujourd'hui le
seul chemin qui écrirait `status: "available"` pour un provider `smtp_imap` : `updateMailboxStatus`
(`lifecycle-service.ts:20`) n'a aucun appelant hors tests, et aucune commande opérateur ne rétablit
une boîte. Si cette commande se contente d'insérer, une boîte révoquée par une faute de frappe reste
morte pour toujours — l'index unique `(provider, normalized_email)` refusant l'insertion.

La commande doit donc **mettre à jour la ligne existante** après vérification réussie : `status` à
`available`, nouveau mot de passe chiffré, transport et dossiers redécouverts, cause d'échec effacée.
Test obligatoire : une boîte en `revoked` reconnectée avec des identifiants valides doit redevenir
`available` et redevenir utilisable pour l'envoi.

`connectSmtpImapMailbox` n'écrit la ligne qu'après succès : `status: "available"`, `encryptedPassword` chiffré par `encryptSecret`, `settings.transport` avec les dossiers **découverts**, et `lastSyncedAt = now - 5 minutes` — la même ancre que `microsoft-oauth-service.ts:280`, sans quoi la première synchronisation échouerait.

En cas d'échec, la boîte reste `pending` avec la cause. Ajouter la commande `connect-smtp-mailbox` dans le routeur, protégée par la session opérateur et le CSRF comme ses voisines.

- [ ] **Step 4: Vérifier**

Run: `npm test -- smtp-imap-connection-service && npm test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/mailboxes/smtp-imap-connection-service.ts src/app/api/operator/commands tests/unit/smtp-imap-connection-service.test.ts
git commit -m "feat: ajoute la connexion verifiee d'une boite smtp/imap"
```

---

## Task 13 : Formulaire Settings

**Files:**

- Modify: `src/app/(operator)/settings/page.tsx:120-200`
- Test: `tests/e2e/operator-ui-browser.spec.ts`

- [ ] **Step 1: Ajouter le formulaire**

Sous le bouton « Connect Microsoft 365 », ajouter un formulaire `POST /api/operator/commands/connect-smtp-mailbox` avec le jeton CSRF (`value={session.csrfToken}`) et les champs : `email`, `username`, `imapHost`, `imapPort` (défaut 993), `smtpHost`, `smtpPort` (défaut 587), `password` en `type="password"`.

- [ ] **Step 2: Étendre l'affichage des boîtes**

Le tableau teste `mailbox.provider === "microsoft_graph"` pour décider d'afficher « Sync now » et « Disconnect » (`page.tsx:156`). Remplacer par `mailbox.provider !== "mock"` afin que les deux providers réels aient les mêmes actions.

- [ ] **Step 3: Vérifier**

Run: `npm run lint && npm run typecheck && npm run test:e2e`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(operator)/settings/page.tsx" tests/e2e
git commit -m "feat: ajoute le formulaire de connexion smtp/imap dans les reglages"
```

---

## Task 14 : Suite de contrat partagée et intégration

**Files:**

- Create: `tests/unit/mail-provider-contract.test.ts`
- Create: `tests/integration/smtp-imap-round-trip.test.ts`
- Modify: `docker-compose.yml`

**Interfaces:**

- Consumes: les trois providers.

- [ ] **Step 1: Écrire la suite de contrat**

Une seule `describe.each` sur les trois providers. Chaque cas est un triplet
`[name, makeProvider, deliveryCount]` où `makeProvider` construit le provider avec ses doublures et
`deliveryCount` retourne le nombre de livraisons réellement effectuées par la doublure de transport :

```ts
const providerCases: Array<
  [MailProviderKind, () => Promise<MailProvider>, () => number]
> = [
  ["mock", async () => new MockMailProvider(), () => mockDeliveries.length],
  [
    "microsoft_graph",
    async () => makeGraphProviderWithFakeClient(),
    () => graphSendCalls.length,
  ],
  [
    "smtp_imap",
    async () => makeSmtpProviderWithFakeTransport(),
    () => smtpSubmissions.length,
  ],
];
```

Propriétés vérifiées, identiques pour tous :

```ts
describe.each(providerCases)(
  "%s satisfies the mail provider contract",
  (name, makeProvider) => {
    it("returns a stable draft id across repeated createDraft calls", async () => {
      const provider = await makeProvider();
      const first = await provider.createDraft(draftInput);
      const second = await provider.createDraft(draftInput);
      expect(second.draftId).toBe(first.draftId);
    });

    it("never produces a second delivery on a repeated send", async () => {
      const provider = await makeProvider();
      const { draftId } = await provider.createDraft(draftInput);
      const send = () =>
        provider.sendDraft({
          draftId,
          outreachId: draftInput.outreachId,
          mailboxId: draftInput.mailboxId,
        });

      await send();
      // Graph n'a aucune garde d'idempotence dans le provider : la protection vit
      // dans send-service via les claims, et un second POST /send est rejete par
      // le serveur. mock et smtp_imap absorbent l'appel sans re-livrer.
      if (name === "microsoft_graph") {
        await expect(send()).rejects.toThrow();
      } else {
        await expect(send()).resolves.toEqual({ status: "accepted" });
      }

      expect(
        await provider.reconcile({
          outreachId: draftInput.outreachId,
          draftId,
          mailboxId: draftInput.mailboxId,
        }),
      ).toMatchObject({ status: "sent" });
      expect(deliveryCount()).toBe(1);
    });

    it("honours an aborted signal", async () => {
      const provider = await makeProvider();
      const controller = new AbortController();
      controller.abort();
      await expect(
        provider.createDraft({ ...draftInput, signal: controller.signal }),
      ).rejects.toThrow();
    });
  },
);
```

- [ ] **Step 2: Ajouter le serveur de test**

Dans `docker-compose.yml`, ajouter un service `greenmail` (image `greenmail/standalone`) exposant IMAP 3993 et SMTP 3587, sur des ports distincts de tout service existant.

- [ ] **Step 3: Écrire le test d'aller-retour**

`tests/integration/smtp-imap-round-trip.test.ts` : connecter une boîte via `connectSmtpImapMailbox`, créer un brouillon, l'envoyer, vérifier sa présence dans Sent, injecter une réponse portant `In-Reply-To`, lancer `reconcileInboundMailbox`, et vérifier qu'une ligne `replies` est créée et rattachée au message d'origine.

- [ ] **Step 4: Vérifier**

Run: `npm test && npm run test:integration && npm run lint && npm run typecheck`
Expected: PASS sur l'ensemble.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/mail-provider-contract.test.ts tests/integration/smtp-imap-round-trip.test.ts docker-compose.yml
git commit -m "test: ajoute la suite de contrat partagee et l'aller-retour smtp/imap"
```

---

## Self-Review

**Couverture du spec :**

| Exigence du spec                          | Tâche            |
| ----------------------------------------- | ---------------- |
| §2 provider `smtp_imap` symétrique        | 8, 9, 10         |
| §3.1 état des dossiers non autoritaire    | 9, 10            |
| §3.2 journal d'acceptation                | 9                |
| §3.3 Message-ID déterministe              | 6, 8             |
| §4.2 `InboundMailSource` et orchestrateur | 3                |
| §4.3 résolution par boîte                 | 4                |
| §5 registre                               | 2, 4, 10         |
| §6 migration et modèle de données         | 1, 5             |
| §7 connexion prouvée                      | 12               |
| §8 gestion d'erreurs                      | 9, 10, 12        |
| §9 tests                                  | 14, et par tâche |
| §11 dépendances                           | 7                |

**Cohérence des types :** `draftId` est partout `` `${uidValidity}:${uid}` `` ; le curseur est partout `` `${uidValidity}:${lastProcessedUid}` `` ; `MailProviderKind` est l'unique union.

**Point d'attention pour l'exécutant :** en Task 1, si `drizzle-kit` génère un `DROP COLUMN`/`ADD COLUMN` au lieu d'un `RENAME`, éditer le SQL à la main. Un `DROP` perdrait le `delta_link` de la boîte Graph existante.

---

## Execution Handoff

Plan complet et sauvegardé. Deux options d'exécution :

1. **Subagent-Driven (recommandé)** — un sous-agent neuf par tâche, revue entre chaque, itération rapide.
2. **Inline Execution** — exécution dans cette session avec points de contrôle.
