# Provider mail SMTP/IMAP et unification du chemin entrant

Date : 2026-08-12
Statut : implémenté et vérifié

## 1. Contexte

L'application ne sait envoyer que par `microsoft_graph` ou par le provider `mock`. L'opérateur doit
envoyer depuis `corentin.sacazes@polytechnique.edu`, dont la boîte est hébergée sur un **Zimbra**
(`zimbra.polytechnique.fr`) et non sur Exchange Online. Microsoft Graph est donc structurellement
inutilisable pour cette boîte : même avec un consentement administrateur du tenant Entra
`f6a47dbc-7ff5-4503-9eb2-bf1e861c18e6`, les appels `/me/messages` échoueraient faute de boîte
Exchange.

Capacités du serveur, relevées par sonde TLS directe :

- SMTP `webmail.polytechnique.fr:587`, STARTTLS, `AUTH PLAIN LOGIN`, taille max 20 Mo
- IMAP `webmail.polytechnique.fr:993`, TLS implicite, `IMAP4rev1`
- Annoncées avant authentification : `UIDPLUS`, `CONDSTORE`, `QRESYNC`, `XLIST`, `IDLE`,
  `MULTIAPPEND`, `LITERAL+`, `SASL-IR`, `ESEARCH`, `NAMESPACE`

Ces capacités sont annoncées par un **proxy IMAP avant authentification**. Le design ne s'appuie sur
aucune d'entre elles : elles sont traitées comme des optimisations éventuelles, découvertes à
l'exécution.

## 2. Décision

Ajouter un provider `smtp_imap` **structurellement symétrique** de `microsoft_graph`, et unifier au
passage le chemin entrant, aujourd'hui monolithique et spécifique à Graph.

Correspondance des concepts :

| Concept                  | `microsoft_graph`           | `smtp_imap`                    |
| ------------------------ | --------------------------- | ------------------------------ |
| Brouillon côté serveur   | `POST /me/messages`         | `APPEND` dans Drafts           |
| Identifiant de brouillon | id de message Graph         | `UIDVALIDITY:UID`              |
| Envoi                    | `POST /messages/{id}/send`  | soumission SMTP 587 STARTTLS   |
| Copie dans Sent          | implicite                   | `APPEND` explicite, réparable  |
| Réconciliation           | `GET /me/messages/{id}`     | événement local + état IMAP    |
| Curseur entrant          | `deltaLink`                 | `UIDVALIDITY:lastProcessedUid` |
| Rebaseline               | `410` / `syncStateNotFound` | changement d'`UIDVALIDITY`     |
| Ingestion des réponses   | `ingestInboundMessage`      | identique, inchangé            |

### Non-objectifs

- Pas d'IMAP `IDLE`. Une réconciliation durable et bornée balaie les boîtes
  SMTP/IMAP disponibles chaque minute ; « Sync now » reste un raccourci opérateur.
- Pas de suppression du code Microsoft Graph : le registre le rend gratuit à conserver.
- Pas de refonte des souscriptions ni des webhooks Graph : ils restent spécifiques à Graph.
- Pas de support multi-comptes Zimbra au-delà de ce que le modèle de données permet naturellement.

## 3. Envoi et réconciliation

### 3.1 Le problème que la symétrie seule ne résout pas

L'envoi Graph est **une** opération atomique. L'envoi SMTP suivi de la copie dans Sent en fait
**deux**. Si le processus meurt entre le `250` SMTP et l'`APPEND`, l'état serveur devient
« brouillon encore dans Drafts, Message-ID absent de Sent » — indiscernable d'un envoi jamais
tenté. Interpréter cet état comme « non envoyé » provoquerait un **double envoi** au prospect.

**L'état des dossiers IMAP n'est donc jamais autoritaire pour le statut d'envoi.**

### 3.2 Journal local d'acceptation

Le provider réutilise le mécanisme déjà établi par `DatabaseMockMailProvider` : une ligne
`workflowEvents` avec clé d'idempotence.

1. `createDraft` — construit le MIME, génère et persiste le `Message-ID`, `APPEND` dans Drafts avec
   le drapeau `\Draft`, retourne `UIDVALIDITY:UID`.
2. `sendDraft` — écrit `smtp.send_attempted`, soumet en SMTP, puis **immédiatement après le `250`**
   écrit `smtp.accepted`. Le déplacement Drafts → Sent est effectué ensuite, en best-effort.
3. `reconcile` — précédence stricte :
   - `smtp.accepted` présent → `sent` ; la copie Sent manquante est réparée en best-effort ;
   - sinon, état serveur exploitable → `drafted` ;
   - sinon, `smtp.send_attempted` sans issue enregistrée → **incertain**, jamais `drafted`.

### 3.3 Message-ID déterministe

`sendApprovedMessage` appelle `reconcile` **avant** `createDraft` et ne crée un brouillon que si
`providerDraftId` est absent (`send-service.ts:1081`, `:1192`). Une panne entre l'`APPEND` et la
persistance de l'identifiant laisserait donc un brouillon orphelin, irretrouvable si son `Message-ID`
était aléatoire.

Le `Message-ID` est en conséquence **dérivé de l'`outreachId`**, comme le fait déjà
`DatabaseMockMailProvider` avec `<{outreachId}@mock.hyperoutreach>`. Il est donc reconstructible sans
aucun état local.

Conséquences :

- `createDraft` est idempotent par construction : il cherche d'abord le `Message-ID` dans Drafts et
  réutilise le brouillon existant au lieu d'en créer un second ;
- `reconcile` retrouve un brouillon ou un envoi orphelin même avec `draftId` à `null` ;
- la recherche `SEARCH HEADER Message-Id` dans Sent sert à la fois à réparer la copie manquante et à
  détecter que le serveur a déjà classé l'envoi lui-même — auquel cas aucune copie n'est ajoutée.

Le provider s'auto-corrige au lieu de dupliquer.

`delivery_uncertain` conserve exactement sa sémantique actuelle : aucun renvoi automatique.

## 4. Chemin entrant unifié

### 4.1 Constat

`reconcileGraphDelta` (`microsoft-graph-sync-service.ts:572-655`) est **entièrement agnostique du
provider** : verrous, événement de santé `workflowEvents`, try/catch, planification de reprise. Seul
`reconcileGraphDeltaLocked` contient la pagination spécifique à Graph. Environ 170 lignes
d'orchestration seraient dupliquées par un second service IMAP écrit à côté.

Le reste du fichier — souscriptions, webhooks, quarantaine, cycle de vie — est authentiquement
spécifique à Graph et n'est pas concerné.

### 4.2 Abstraction

```ts
interface InboundMailSource {
  readonly kind: MailProviderKind;
  fetchSince(
    cursor: string | null,
    ingestPage: (messages: unknown[]) => Promise<number>,
  ): Promise<{ nextCursor: string; rebaselined: boolean }>;
}
```

La source **pousse** les messages page par page via `ingestPage` au lieu de les retourner en bloc.
Retourner un tableau accumulerait tout le backlog en mémoire lors d'une première synchronisation,
et surtout un échec sur la page N annulerait l'ingestion des pages 1..N-1 : une seule page
malformée gèlerait définitivement la détection des réponses. Le streaming reproduit le comportement
de l'implémentation Graph d'origine.

Un orchestrateur unique `reconcileInboundMailbox(db, source, classifier, mailboxId)` reprend
l'orchestration existante, avec les noms d'événements dérivés de `source.kind`. Graph et IMAP en
deviennent deux implémentations.

Contrat du curseur, identique pour les deux :

- opaque pour l'orchestrateur ;
- `rebaselined: true` signale une perte de synchronisation côté serveur — `410` /
  `syncStateNotFound` pour Graph, changement d'`UIDVALIDITY` pour IMAP ;
- après rebaseline, l'ancre est reculée de 5 minutes, comme aujourd'hui.

L'implémentation IMAP utilise `UID FETCH lastUid+1:*`. `QRESYNC` et `CONDSTORE` ne sont pas requis.

### 4.3 Correction d'incohérence

Les tâches entrantes sont aujourd'hui conditionnées à la variable **globale** `MAIL_PROVIDER`
(`service-factory.ts:204`, `:231`, `:243`), alors que le sortant résout le provider **par boîte**
via `createMailProviderForMailbox`. Une boîte Zimbra serait ignorée dès que `MAIL_PROVIDER` vaut
autre chose.

La tâche `reconcile-graph-delta` devient `reconcile-inbound-mailbox` et résout la source depuis le
provider **de la boîte concernée**. Les tâches de souscription et de webhook restent gouvernées par
Graph, puisqu'elles n'ont pas d'équivalent IMAP.

Impact : renommage dans `task-contracts.ts`, `runtime.ts`, `trigger/tasks.ts:40` et le handler
`sync-mailbox`. Les clés d'idempotence changeant de préfixe, les tâches en vol au moment du
déploiement sont sans objet ici (`WORKFLOW_PROVIDER=mock`, exécution inline).

### 4.4 Les noms d'événements de Graph sont load-bearing

Découvert à l'implémentation : `send-service.ts:601-604` conditionne l'autorisation d'envoi à
`workflowName IN ("graph_lifecycle_reconciliation", "graph_delta_health")`, et un test d'intégration
dépend de la clé d'idempotence `graph:delta-health:<mailboxId>`.

Dériver ces noms de `source.kind` — comme ce document le prévoyait initialement — aurait fait que la
garde ne matche plus jamais : l'application aurait continué d'envoyer alors que la synchronisation
entrante est en échec, sans aucun signal.

**Graph conserve donc ses littéraux historiques**, passés en paramètres à l'orchestrateur. Les noms
dérivés existent sous `defaultInboundNaming` et servent de défaut aux nouveaux providers.

Conséquence à trancher pour `smtp_imap` : avec `workflowName: "inbound_reconciliation"`, il ne
bénéficie d'aucune garde d'envoi sur défaillance entrante. Soit on ajoute son nom à la liste de
`send-service.ts`, soit on assume l'absence de garde. **Décision : l'ajouter** — la garde protège
contre l'envoi à l'aveugle quand on ne sait plus lire les réponses, ce qui vaut pour tout provider.

## 5. Registre de providers

`createMailProviderForMailbox` enchaîne des `if` sur le type de provider et exige un
`microsoftConfig` même quand il est inutile. Il devient un registre indexé par `MailProviderKind`,
côté sortant comme entrant, chaque entrée résolvant **paresseusement** sa propre configuration :
`microsoft_graph` exige la config Microsoft, `smtp_imap` n'exige rien d'autre que la boîte,
`mock` rien du tout.

Ajouter un provider se réduit alors à ajouter une entrée.

`MailProviderKind` devient la source unique du type. L'union dupliquée en dur à
`send-service.ts:107` en est dérivée.

## 6. Modèle de données

Migration :

- enum `mailbox_provider` : ajout de `smtp_imap` ;
- `mailbox_connections.delta_link` renommée `sync_cursor`, partagée par les deux providers ;
- `mailbox_connections.encrypted_password`, nullable ;
- `settings` jsonb : bloc de transport typé et validé par zod.

```jsonc
{
  "transport": {
    "username": "corentin.sacazes",
    "imap": {
      "host": "webmail.polytechnique.fr",
      "port": 993,
      "security": "tls",
    },
    "smtp": {
      "host": "webmail.polytechnique.fr",
      "port": 587,
      "security": "starttls",
    },
    "folders": { "drafts": "Drafts", "sent": "Sent", "inbox": "INBOX" },
  },
}
```

Le **nom d'utilisateur est distinct de l'adresse email** : Zimbra attend `corentin.sacazes`, pas
`corentin.sacazes@polytechnique.edu`. Les noms de dossiers sont découverts à l'exécution par `XLIST`
ou `LIST`, avec repli sur les noms conventionnels, puis persistés.

Le mot de passe est chiffré avec `encryptSecret` et le keyring `TOKEN_ENCRYPTION_KEYS` déjà utilisés
pour les jetons Graph — même mécanisme, aucun code de chiffrement nouveau.

## 7. Ajout d'une boîte

Commande opérateur `connect-smtp-mailbox`, symétrique du rappel OAuth Microsoft. Avant de passer la
boîte en `status = available`, elle **prouve** la configuration :

1. connexion IMAP et authentification ;
2. découverte et résolution des dossiers Drafts et Sent ;
3. connexion SMTP, STARTTLS et authentification, sans envoi.

Un échec laisse la boîte en `pending` avec la cause. Ceci évite l'équivalent du problème identifié
sur le chemin Graph : une ligne de boîte présentant tous les signes de validité mais inutilisable au
premier envoi réel.

`Disconnect` efface le mot de passe chiffré, le curseur et le transport, exactement comme la
déconnexion Microsoft.

## 8. Gestion d'erreurs

- Les échecs d'authentification passent la boîte en `unavailable` avec la cause ; ils ne sont pas
  réessayés en boucle.
- Les échecs réseau transitoires remontent à l'orchestrateur, qui applique la planification de
  reprise existante.
- Un rejet SMTP permanent (`5xx`) est une erreur de provider et n'est pas rejoué.
- Un `4xx` SMTP est transitoire et laisse le message réclamable.
- L'échec de la seule copie dans Sent n'affecte jamais le statut d'envoi.

## 9. Tests

**Suite de contrat partagée.** Une unique suite exécutée contre les trois providers (`mock`,
`microsoft_graph`, `smtp_imap`) : idempotence de `createDraft`, acceptation unique, précédence de
`reconcile`, comportement sur abandon. Un provider qui passe le contrat est interopérable par
construction.

**Panne entre acceptation et copie.** Test dédié : `250` reçu puis interruption avant `APPEND` ;
`reconcile` doit répondre `sent`, jamais `drafted`. C'est le test qui garantit l'absence de double
envoi.

**Brouillon orphelin.** `APPEND` réussi puis interruption avant persistance du `providerDraftId` :
`reconcile` avec `draftId` à `null` doit retrouver le brouillon par son `Message-ID`, et
`createDraft` doit le réutiliser au lieu d'en créer un second.

**Suite de contrat entrante.** Même principe pour `InboundMailSource` : progression du curseur,
rebaseline, absence de double ingestion.

**Intégration.** Serveur IMAP/SMTP en conteneur, jamais le serveur de l'école. Les noms de dossiers
et les capacités sont découverts, jamais supposés.

**Non-régression.** Les suites Graph et les tests de politique d'envoi existants doivent passer
inchangés ; la politique d'envoi et la liste de suppression sont au-dessus du provider et ne sont
pas touchées.

## 10. Risques

| Risque                             | Traitement                                                          |
| ---------------------------------- | ------------------------------------------------------------------- |
| Double envoi sur panne partielle   | Journal d'acceptation local, testé explicitement                    |
| Zimbra classe déjà dans Sent       | Recherche par `Message-ID` avant toute copie                        |
| Capacités IMAP réelles ≠ annoncées | Aucune dépendance à `QRESYNC` ; découverte à l'exécution            |
| Renommage de tâche                 | Exécution inline aujourd'hui, aucune tâche en vol                   |
| Mot de passe principal de l'école  | Recommander un mot de passe d'application si Zimbra en propose      |
| Élargissement du périmètre         | Refactor borné : 170 lignes d'orchestration, 14 références externes |

## 11. Dépendances

`nodemailer` pour SMTP, `imapflow` pour IMAP. Aucune dépendance de chiffrement nouvelle.
