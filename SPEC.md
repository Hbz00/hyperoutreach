# Architecture d’un outil agentique de prospection et customer discovery

> Note du 2026-08-15, sur la seule surface IA : ce document décrit l’API Responses
> d’OpenAI comme transport des agents. Ce n’est plus le cas. Toutes les tâches IA
> passent désormais par l’app ChatGPT desktop de l’opérateur ; l’adaptateur API a
> été supprimé et l’adaptateur Codex débranché. Les contrats d’agents, les schémas,
> les preuves et le reste de l’architecture décrits ici restent valables ; `README.md`
> fait foi pour le chemin IA courant. Le produit a evolue depuis et ce document peut 
> ne plus être 100% d'actualité. Le code source est la seule source de verité.

## 1. Conclusion d’architecture

L’architecture que je recommande est un monolithe modulaire TypeScript composé de :

- Next.js pour l’interface et les endpoints applicatifs ;
- PostgreSQL comme source de vérité ;
- Trigger.dev pour l’exécution durable des workflows ;
- OpenAI Responses API pour les tâches agentiques ;
- Microsoft Graph pour Outlook/Microsoft 365 ;
- DNS pour les vérifications simples de domaines ;
- des adaptateurs optionnels vers Apollo, Clay, LeadIQ, Hunter ou équivalents, uniquement en fallback.

Schéma général :

```text
                         ┌───────────────────────┐
                         │       Next.js UI      │
                         │                       │
                         │ Prospects / Campaigns │
                         │ Review / Replies      │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │      PostgreSQL       │
                         │   SOURCE OF TRUTH     │
                         └───────────┬───────────┘
                                     │
                               events / jobs
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │     Trigger.dev       │
                         │ durable workflows     │
                         └─────┬────────┬────────┘
                               │        │
                 ┌─────────────┘        └─────────────┐
                 ▼                                    ▼
       ┌───────────────────┐                 ┌──────────────────┐
       │ OpenAI Responses  │                 │ Microsoft Graph  │
       │                   │                 │                  │
       │ web search        │                 │ Send             │
       │ research          │                 │ Inbox            │
       │ extraction        │                 │ Replies          │
       │ classification    │                 │ Webhooks         │
       └─────────┬─────────┘                 └──────────────────┘
                 │
                 ▼
       ┌────────────────────┐
       │ Open web / DNS /   │
       │ optional providers │
       └────────────────────┘
```

Le principe architectural fondamental est :

> L’IA raisonne. Le workflow décide quand exécuter. La base de données sait ce qui s’est passé.

C’est beaucoup plus robuste qu’un « agent autonome » ayant accès directement à Outlook et exécutant une campagne de bout en bout.

---

# 2. Pourquoi cette architecture est adaptée

Ton workflow contient en réalité deux catégories de tâches très différentes.

### Tâches à forte composante de raisonnement

- trouver les entreprises correspondant à un ICP ;
- trouver les bonnes personnes ;
- déterminer si leur poste correspond réellement à la cible ;
- rechercher des informations pertinentes sur leur entreprise ;
- identifier des éléments de personnalisation ;
- inférer un format d’adresse email ;
- classifier une réponse.

Ici, l’agentic est très pertinent.

### Tâches déterministes

- savoir si quelqu’un a déjà été contacté ;
- savoir quand envoyer ;
- remplir un template ;
- empêcher deux envois ;
- envoyer un email ;
- attendre sept jours ;
- vérifier qu’aucune réponse n’est arrivée ;
- effectuer une relance ;
- arrêter la séquence en cas de réponse ;
- appliquer une suppression ;
- tracer les coûts et les actions.

Ici, utiliser un LLM serait une erreur architecturale.

La majorité de ton produit est donc un système de workflow classique, auquel on ajoute quelques nœuds agentiques très puissants.

---

# 3. Stack recommandée

## Frontend et backend : TypeScript + Next.js

Je garderais frontend et backend dans le même repository.

Pas besoin de créer :

- un backend Python séparé ;
- des microservices ;
- une API Gateway ;
- Kafka ;
- plusieurs workers maison.

Pour ce produit, cela ralentirait considérablement le développement sans apporter de valeur.

Structure typique :

```text
/apps/web
/src
  /modules
    /accounts
    /contacts
    /campaigns
    /research
    /email-resolution
    /mailboxes
    /messages
    /replies
    /suppression
  /lib
    /openai
    /microsoft
    /providers
/trigger
  discover-accounts.ts
  research-account.ts
  discover-contacts.ts
  resolve-email.ts
  generate-message.ts
  send-message.ts
  classify-reply.ts
  advance-sequence.ts
```

Je privilégierais PostgreSQL standard, éventuellement hébergé chez Supabase ou Neon. L’important est de rester sur du vrai PostgreSQL afin d’éviter un lock-in important.

---

# 4. Workflow engine : Trigger.dev plutôt que Temporal

C’est probablement le choix technique le plus important après PostgreSQL.

## Recommandation : Trigger.dev

Pour ce produit, je choisirais Trigger.dev.

Il fournit déjà :

- retries ;
- tâches longues ;
- attentes durables ;
- scheduling ;
- queues ;
- concurrence ;
- idempotence ;
- versioning des tâches ;
- observabilité ;
- human-in-the-loop ;
- exécution de Playwright/Puppeteer si nécessaire.

Un workflow peut donc conceptuellement faire :

```ts
sendFirstEmail();

await wait.until(followUpDate);

if (await shouldContinueSequence()) {
  sendFollowUp();
}
```

sans qu’un processus Node reste réellement actif pendant sept jours.

## Pourquoi pas Temporal au départ ?

Temporal est probablement plus puissant et plus rigoureux pour de très grandes architectures distribuées. Son Event History lui permet notamment de reconstruire exactement l’état d’un workflow après un crash.

Mais ce serait inutilement lourd ici :

- infrastructure supplémentaire ;
- courbe d’apprentissage ;
- concepts spécifiques Temporal ;
- davantage de code ;
- davantage d’opérations.

Je ne passerais à Temporal que si le produit devenait une vraie plateforme SaaS critique avec énormément de workflows simultanés.

## Alternative sérieuse : Inngest

Inngest est le concurrent que je considérerais vraiment.

Il dispose notamment d’un très bon système natif de throttling permettant par exemple :

```text
mailbox A → maximum X départs / période
mailbox B → maximum Y départs / période
```

avec mise en file d’attente automatique.

Donc :

**Trigger.dev : choix n°1 pour rapidité + agentic + DX.**

**Inngest : très bon choix si le contrôle événementiel/rate limiting devient central.**

**Temporal : trop lourd pour le MVP.**

**n8n : excellent pour prototyper, mauvais choix comme cœur du produit.**

---

# 5. OpenAI : utiliser plusieurs niveaux d’intelligence

Ton intuition sur Sol/Luna est bonne, avec une modification importante : je ne mettrais pas systématiquement Sol sur chaque prospect.

Les modèles GPT-5.6 sont actuellement séparés entre Sol, Terra et Luna, Luna étant explicitement destiné aux workloads importants et sensibles au coût.

Le Responses API peut directement donner au modèle accès au web avec :

```text
web_search
```

et retourner les sources utilisées.

Je créerais donc trois niveaux.

### Research agent

Sol ou éventuellement Terra.

Mission :

```text
company
↓
ICP validation
↓
relevant departments
↓
prospect identification
↓
web research
↓
structured evidence
```

### Extraction / normalization agent

Luna.

Mission :

```text
raw search results
↓
company name
person name
job title
domain
source URLs
confidence
```

### Outreach agent

Luna.

Mission :

```text
template
+
structured prospect data
+
company facts
↓
final message
```

Luna est particulièrement intéressant ici car il est aujourd’hui présenté comme le modèle GPT-5.6 optimisé pour le volume et le coût.

---

# 6. Ton hypothèse sur le coût du web search est plutôt solide

Le web search OpenAI coûte actuellement 10 $ pour 1 000 appels, auxquels s’ajoutent les tokens consommés par le modèle. Cela représente environ 0,01 $ de coût fixe par recherche web avant les tokens.

Mais il faut surtout changer l’unité de recherche.

Ne fais pas :

```text
Prospect 1 → recherche entreprise
Prospect 2 → recherche entreprise
Prospect 3 → recherche entreprise
```

Fais :

```text
Entreprise A
    ↓
research snapshot unique
    ↓
CEO
Head of Sales
VP Marketing
Head of Product
...
```

L’analyse d’une entreprise doit être mutualisée entre ses contacts.

Exemple :

```text
ACCOUNT_RESEARCH
Acme Corp

industry: industrial robotics
employees: 480
country: France

signals:
- opening German office
- hiring sales team
- launched product X

sources:
- URL 1
- URL 2
- URL 3

researched_at:
2026-08-11
```

Puis chacun des prospects réutilise ce snapshot.

---

# 7. Stress test : recherche de prospects

Ton hypothèse :

> GPT-5.6 peut trouver des personnes correspondant à une description précise.

Oui, mais cela ne doit jamais produire simplement :

```text
Jean Dupont
VP Sales
Acme
```

Le contrat de sortie devrait imposer :

```json
{
  "first_name": "Jean",
  "last_name": "Dupont",
  "job_title": "VP Sales",
  "company": "Acme",
  "evidence": [
    {
      "url": "...",
      "supports": ["employment", "job_title"]
    }
  ],
  "confidence": 0.94
}
```

Sinon tu obtiendras tôt ou tard :

- anciens salariés ;
- intitulés obsolètes ;
- homonymes ;
- personnes appartenant à une filiale différente ;
- hallucinations.

L’agent ne doit donc pas seulement « trouver un prospect ».

Il doit **produire un prospect accompagné de preuves**.

C’est un changement conceptuel très important.

---

# 8. Stress test : retrouver l'adresse email

C’est probablement le point sur lequel je modifierais le plus ton approche initiale.

Ton raisonnement est :

> une adresse connue chez l’entreprise suffit généralement à déterminer le pattern.

C’est souvent vrai.

Mais je ne ferais pas de LeadIQ ou Clay la source privilégiée.

Je ferais un `EmailResolver`.

## Étape 1 — identifier le domaine

```text
Acme SAS
→ acme.com
```

Éviter d’inférer :

```text
Acme SAS
→ acme.fr
```

sans source.

## Étape 2 — rechercher des emails publics existants

Requêtes possibles :

```text
"@acme.com"
site:acme.com "@acme.com"
"firstname.lastname@acme.com"
Acme email contact press
```

Recherche également dans :

- site corporate ;
- PDF ;
- communiqués ;
- documents presse ;
- pages recrutement ;
- conférences ;
- documents publics ;
- résultats provenant éventuellement de Clay/LeadIQ.

LeadIQ et Clay deviennent alors simplement deux sources possibles parmi beaucoup d’autres.

## Étape 3 — détecter les patterns

Exemples trouvés :

```text
marie.dupont@acme.com
john.smith@acme.com
```

Le moteur en déduit :

```text
{first}.{last}@acme.com
confidence = HIGH
```

## Étape 4 — générer l'adresse

```text
pierre.martin@acme.com
```

## Étape 5 — DNS

Vérifier :

```text
domain exists
MX records exist
```

C’est gratuit et déterministe.

Attention : cela confirme que `acme.com` reçoit des emails, pas que `pierre.martin@acme.com` existe.

## Étape 6 — score de confiance

Par exemple :

```text
1 email public compatible
→ confidence 0.75

2 emails publics compatibles
→ confidence 0.90

3+ emails compatibles
→ confidence 0.97

aucun email public
→ confidence 0.30
```

Les seuils exacts seront à calibrer avec tes données.

## Étape 7 — fallback externe

Uniquement si :

```text
confidence < threshold
```

appel éventuel à :

```text
ApolloAdapter
ClayAdapter
LeadIQAdapter
HunterAdapter
```

Ainsi, l’architecture ne dépend d’aucun de ces fournisseurs.

C’est exactement le type d’abstraction que je construirais :

```ts
interface EmailEnrichmentProvider {
  resolve(input: {
    firstName: string;
    lastName: string;
    companyDomain: string;
  }): Promise<EmailCandidate[]>;
}
```

---

# 9. Ce que je déconseille : SMTP mailbox probing

On pourrait être tenté de faire :

```text
RCPT TO: pierre.martin@acme.com
```

pour voir si le serveur répond que l'adresse existe.

Je n'en ferais pas une fonctionnalité du MVP.

Les serveurs modernes peuvent être :

- catch-all ;
- protégés contre ce type de probing ;
- soumis au greylisting ;
- volontairement opaques.

Le résultat produit souvent une illusion de validation.

MX + preuves publiques + fallback externe est une approche beaucoup plus simple.

---

# 10. Templates : encore moins d'IA que prévu

Tu as raison : remplir le nom, l’entreprise ou le rôle a très peu de valeur ajoutée.

Je n'utiliserais même pas forcément un LLM pour cela.

Template :

```text
Bonjour {{first_name}},

Je travaille actuellement sur {{value_proposition}}.

J’ai vu que {{company_relevance}}.

{{cta}}

Titouan
```

Interpolation déterministe :

```text
{{first_name}}
{{company}}
{{job_title}}
```

Puis Luna n’est utilisé que pour :

```text
{{company_relevance}}
```

ou éventuellement :

```text
{{personalized_opening}}
```

Cela réduit :

- les coûts ;
- les hallucinations ;
- les variations de style ;
- les mails trop longs ;
- les phrases absurdes.

Le LLM ne devrait pas réinventer le mail entier à chaque prospect si ton template fonctionne déjà.

---

# 11. Versionner les templates

Une campagne publiée devrait produire une version immuable.

Exemple :

```text
Campaign
Customer discovery CEOs

Version 1
step 0 → template A
step 1 → template B
step 2 → template C
```

Si tu modifies ensuite le template :

```text
Version 2
```

Les nouveaux prospects utilisent V2.

Les séquences déjà commencées restent en V1.

Cela évite qu’un changement effectué au milieu d’une campagne transforme de façon imprévisible les workflows déjà en attente.

---

# 12. Outlook : abandonner l'idée IMAP/SMTP comme intégration principale

Microsoft Graph doit être ton interface Outlook.

Graph permet :

- d’envoyer des messages ;
- de lire la mailbox ;
- de recevoir des notifications de changements ;
- de synchroniser les changements par delta queries.

Microsoft pousse par ailleurs les applications vers les mécanismes d’authentification modernes et retire progressivement l’authentification Basic historique utilisée notamment autour de SMTP AUTH.

Architecture :

```text
Microsoft OAuth
       ↓
access token
refresh token
       ↓
Microsoft Graph
       ↓
MailboxAdapter
```

Interface interne :

```ts
interface MailProvider {
  send(...): Promise<SentMessage>;
  getMessage(...): Promise<Message>;
  watchInbox(...): Promise<void>;
}
```

Cela permettra éventuellement plus tard :

```text
MicrosoftGraphProvider
GmailProvider
```

sans modifier la logique des campagnes.

---

# 13. Permissions Microsoft

Pour une première version capable seulement d’envoyer et de détecter les réponses :

```text
Mail.Send
Mail.Read
```

peuvent suffire conceptuellement.

Microsoft indique que `Mail.Send` permet l’envoi et que les notifications sur les messages nécessitent une permission de lecture.

Mais je préférerais probablement :

```text
Mail.Send
Mail.ReadWrite
```

pour implémenter une stratégie d’envoi plus robuste basée sur des brouillons.

---

# 14. Le problème subtil : éviter les doubles envois

C'est un des principaux risques du système.

Scénario :

```text
Trigger.dev
    ↓
Graph send
    ↓
Microsoft accepte le mail
    ↓
connexion interrompue
    ↓
ton worker croit que l'envoi a échoué
    ↓
retry
    ↓
mail envoyé une seconde fois
```

Un simple :

```ts
await graph.sendMail(...)
```

n’offre donc pas une vraie garantie « exactly once ».

Je ferais plutôt :

```text
1. création d'un message DB
2. génération d'un outreach_message_id
3. création d'un draft Outlook
4. stockage graph_message_id
5. envoi du draft
6. confirmation Sent Items
7. message DB = SENT
```

Microsoft Graph permet de créer un brouillon puis de l’envoyer séparément, ainsi que d’ajouter des headers personnalisés au message.

Par exemple :

```text
X-Outreach-ID:
out_01J...
```

Je demanderais également les `ImmutableId` Graph afin que l’identifiant Outlook reste stable lorsque le message passe de Drafts à Sent Items. Microsoft documente précisément cette stratégie pour retrouver après envoi un message créé comme brouillon.

C’est une petite complexité qui vaut réellement la peine.

---

# 15. Source de vérité : PostgreSQL, pas Trigger.dev

Autre décision importante.

Ne fais pas :

```text
"Pour connaître l'état d'une campagne,
je vais regarder les workflows Trigger."
```

La DB doit contenir :

```text
contact
campaign
current_step
status
next_action_at
last_message_at
reply_status
stop_reason
```

Trigger.dev n’est que l’exécuteur.

Ainsi :

```text
DB = business state
Trigger = execution state
```

Cela facilite énormément :

- debugging ;
- modifications manuelles ;
- migration vers un autre moteur ;
- analytics ;
- reprise après erreur.

---

# 16. Modèle de données

Je partirais environ sur ces tables.

## accounts

```text
id
name
normalized_name
domain
website
industry
employee_range
country
research_status
research_snapshot
researched_at
```

## contacts

```text
id
account_id
first_name
last_name
full_name
job_title
linkedin_url
status
```

## evidence_sources

```text
id
account_id
contact_id
url
title
source_type
retrieved_at
supports
```

## email_candidates

```text
id
contact_id
email
pattern
confidence
source
status
```

## campaigns

```text
id
name
type
status
target_description
created_at
```

`type` :

```text
customer_discovery
commercial_outreach
other
```

## campaign_versions

```text
id
campaign_id
version
created_at
```

## sequence_steps

```text
id
campaign_version_id
step_index
delay
subject_template
body_template
```

## enrollments

```text
id
campaign_version_id
contact_id
mailbox_id
state
current_step
next_action_at
stop_reason
```

## messages

```text
id
enrollment_id
step_index
direction
subject
body
recipient
graph_message_id
internet_message_id
status
scheduled_at
sent_at
```

Contrainte essentielle :

```text
UNIQUE(enrollment_id, step_index)
```

Cela évite une grande partie des doubles envois.

## mailbox_connections

```text
id
provider
email
encrypted_refresh_token
status
```

## replies

```text
id
message_id
received_at
body
classification
confidence
```

## suppression_list

```text
id
email
domain
reason
created_at
```

## workflow_events

```text
id
entity_type
entity_id
event
payload
created_at
```

## agent_runs

```text
id
agent
model
prompt_version
input
output
sources
token_usage
cost
created_at
```

Cette dernière table devient extrêmement utile pour améliorer progressivement le produit.

---

# 17. State machine d’un prospect

Ne construis pas une collection de booléens comme :

```text
email_sent = true
followup1_sent = true
reply = false
bounce = false
...
```

Utilise une state machine.

Exemple :

```text
DISCOVERED
   ↓
RESEARCHED
   ↓
EMAIL_RESOLVED
   ↓
READY_FOR_REVIEW
   ↓
APPROVED
   ↓
ACTIVE_SEQUENCE
   ↓
REPLIED ──────────┐
BOUNCED ──────────┤
OPTED_OUT ────────┤
COMPLETED ────────┘
```

Avec des `stop_reason` :

```text
positive_reply
negative_reply
unsubscribe
bounce
manual_stop
sequence_complete
company_suppressed
```

---

# 18. Workflow complet de découverte

```text
User creates ICP
      ↓
Research agent searches accounts
      ↓
Accounts inserted
      ↓
DEDUPLICATION
      ↓
Research account
      ↓
Store account research snapshot + sources
      ↓
Discover matching contacts
      ↓
Store contact + evidence
      ↓
DEDUPLICATION
      ↓
Resolve email
      ↓
Confidence scoring
      ↓
Generate outreach
      ↓
Quality gate
      ↓
Review or automatic approval
```

À chaque étape :

```text
input structuré
↓
output structuré
↓
persist DB
```

Évite de transmettre un gigantesque historique conversationnel entre agents.

---

# 19. Déduplication : fonctionnalité beaucoup plus importante qu’elle n’en a l’air

C’est précisément une limite que tu rencontres aujourd’hui avec ChatGPT.

Avant toute nouvelle prospection :

```text
company domain
↓
existing account?
```

Puis :

```text
person
↓
existing contact?
```

Puis :

```text
contact
↓
already contacted?
```

Mais je distinguerais :

```text
déjà contacté dans cette campagne
déjà contacté dans une autre campagne
contacté récemment
a répondu négativement
a demandé à ne plus être contacté
entreprise supprimée
```

La réponse à :

> « Puis-je contacter cette personne ? »

devient alors une fonction déterministe :

```ts
evaluateContactPolicy(contact, campaign);
```

et absolument pas une décision du LLM.

---

# 20. Envoi et relances

Pour chaque enrollment :

```text
READY
 ↓
schedule step 0
 ↓
policy check
 ↓
send
 ↓
WAIT
 ↓
policy check
 ↓
step 1
 ↓
WAIT
 ↓
policy check
 ↓
step 2
 ↓
...
```

La règle critique :

> On ne suppose jamais qu’une relance prévue il y a sept jours est encore valide aujourd’hui.

Immédiatement avant chaque envoi :

```text
has replied?
has bounced?
opted out?
manual stop?
mailbox healthy?
campaign paused?
contact still eligible?
```

Puis seulement :

```text
SEND
```

---

# 21. Réception des réponses

Microsoft Graph permet de recevoir des notifications lorsqu’un message change ou arrive dans la mailbox.

Workflow :

```text
New inbox event
      ↓
fetch message
      ↓
match outreach conversation
      ↓
classify
      ↓
update enrollment
      ↓
cancel future follow-ups
      ↓
show in UI
```

Classification Luna :

```text
POSITIVE
NEGATIVE
QUESTION
REFERRAL
OUT_OF_OFFICE
UNSUBSCRIBE
BOUNCE
AUTOMATED
UNKNOWN
```

Pour :

```text
POSITIVE
NEGATIVE
QUESTION
REFERRAL
UNSUBSCRIBE
```

la campagne s’arrête immédiatement.

Pour :

```text
OUT_OF_OFFICE
```

on peut éventuellement extraire :

```text
return_date
alternative_contact
```

et proposer une action.

---

# 22. Webhook + synchronisation de secours

Je ne dépendrais pas exclusivement des webhooks.

Architecture :

```text
Graph webhook
    ↓
fast reaction
```

plus périodiquement :

```text
Graph delta sync
    ↓
reconciliation
```

Microsoft Graph fournit justement des delta queries permettant de récupérer uniquement les changements intervenus depuis la dernière synchronisation.

Ainsi, même si :

```text
webhook perdu
serveur indisponible
subscription expirée
```

le système finit par retrouver la réponse.

C’est un excellent exemple de workflow durable bien conçu.

---

# 23. Human-in-the-loop

Au début, je ne lancerais absolument pas le système en autonomie complète.

Je créerais trois modes.

> Note du 2026-08-16 : les trois modes n'ont jamais été construits. Le réglage
> `reviewMode` était enregistré, affiché dans un menu à une seule valeur, et lu
> par aucune décision — la campagne de l'incident du 2026-08-14 portait
> `"manual"` sans que cela change quoi que ce soit. Il a été supprimé. Ce qu'il
> prétendait configurer est désormais un **invariant appliqué** : aucun premier
> envoi ne peut être d'origine système, et le schéma de configuration rejette
> explicitement la clé. Le mode « assisté » supposait par ailleurs une variance
> par message qui n'existe pas tant que le texte est un gabarit à quatre
> variables. Le réglage reviendra le jour où il aura deux comportements réels à
> départager, et le tableau de bord affiche déjà le seul signal empirique qui
> puisse le justifier : le nombre d'approbations consécutives sans réécriture,
> par version de campagne.

### Manual

```text
research
↓
generate
↓
user approves every email
↓
send
```

### Assisted

```text
confidence > threshold
→ automatic

confidence < threshold
→ review
```

### Automatic

```text
full campaign automation
```

L’architecture doit permettre de passer de Manual à Automatic sans réécrire les workflows.

Trigger.dev dispose précisément de mécanismes permettant de suspendre un run dans l’attente d’une approbation humaine.

---

# 24. Quality gates

Avant chaque premier email, je calculerais quelque chose comme :

```text
prospect_confidence
role_confidence
email_confidence
personalization_confidence
```

Puis :

```text
overall_confidence
```

Exemple de policy :

```text
>= 0.90
auto

0.70 - 0.90
review

< 0.70
reject / enrich
```

Encore une fois : les valeurs exactes doivent être calibrées empiriquement.

---

# 25. Deliverability : ne pas confondre limite Microsoft et volume raisonnable

Exchange Online possède actuellement des limites techniques telles qu’un plafond de destinataires journalier et un message rate limit. Microsoft précise cependant explicitement que ces mécanismes existent notamment pour décourager les volumes de messages non sollicités et recommande aux usages véritablement bulk de passer par des fournisseurs spécialisés.

Donc surtout ne fais pas :

```text
Microsoft autorise 30 messages/minute
→ envoyons 30 messages/minute.
```

Les limites techniques ne sont pas des recommandations de prospection.

Ton système doit avoir sa propre couche :

```text
SendingPolicy
```

avec :

```text
mailbox pacing
daily cap
working hours
minimum delay
campaign cap
emergency pause
```

La délivrabilité doit être considérée comme une contrainte produit, pas comme une optimisation ultérieure.

---

# 26. SPF, DKIM, DMARC

Avant toute automatisation réelle :

```text
SPF
DKIM
DMARC
```

doivent être correctement configurés.

Microsoft recommande aujourd’hui leur utilisation conjointe, et précise notamment que pour les domaines personnalisés Microsoft 365, DKIM doit être configuré afin d’obtenir une authentification maximale.

Je créerais éventuellement plus tard une page :

```text
Mailbox Health

SPF        ✓
DKIM       ✓
DMARC      ✓
Graph      ✓
Webhook    ✓
Last sync  2 min
```

---

# 27. Bounces et suppression

> Note du 2026-08-18 : un hard bounce établit désormais **deux faits distincts**
> que ce document confondait — l'adresse est morte, la personne ne l'est pas. La
> suppression décrite ci-dessous reste inchangée et définitive ; ce qui change,
> c'est que le contact peut repartir sur l'adresse suivante que les preuves ont
> nommée pour lui, sans consommer d'étape et sans qu'aucun envoi ne soit
> d'origine système. Une échelle épuisée retombe exactement sur l'état terminal
> décrit ici. Voir « The address ladder » dans `README.md`, qui fait foi.

Les bounces doivent avoir un effet immédiat :

```text
HARD BOUNCE
→ email invalid
→ suppression

SOFT BOUNCE
→ retry policy / review
```

Et surtout :

```text
unsubscribe
```

doit produire une entrée permanente dans :

```text
suppression_list
```

Cette table doit être vérifiée avant chaque envoi, quelles que soient la campagne et la séquence.

---

# 28. RGPD / prospection B2B

> Note du 2026-08-17 : **décision assumée de l'opérateur.** Ce dépôt est un
> projet personnel, sans vocation commerciale ni diffusion. L'arbitrage retenu
> est la performance et l'efficacité, pas la conformité — en particulier, la
> recherche d'adresses publiques cite explicitement les bases de prospection
> comme sources, ce qui n'est pas compatible avec une lecture stricte de
> l'article 14. Ce n'est pas un oubli et il est inutile de le resoulever en
> revue. Ce que le produit conserve malgré tout, parce que c'est utile et non
> parce que c'est obligatoire : la provenance de chaque adresse est enregistrée
> avec le candidat, la suppression reste vérifiée avant chaque envoi, et un
> désabonnement est définitif.

Il faut prévoir cette contrainte directement dans le modèle de données.

La CNIL indique actuellement que la prospection B2B peut reposer sur l’intérêt légitime lorsque la sollicitation est liée à la profession du destinataire. La personne doit pouvoir s’opposer facilement aux nouvelles sollicitations et l’organisation émettrice doit être identifiable.

Cela renforce l’intérêt de stocker :

```text
source URL
source date
professional relevance
suppression status
```

et de rendre l’opposition triviale.

Cette distinction est notamment importante entre :

```text
Head of IT
← email concernant logiciel IT
```

et une prospection sans rapport avec son activité professionnelle.

La conformité ne doit donc pas être seulement un footer ajouté au mail : une partie peut être implémentée dans `evaluateContactPolicy()`.

---

# 29. Ce que je ne construirais pas dans le MVP

Pour éviter précisément le sur-engineering :

- pas de microservices ;
- pas de Kafka ;
- pas de vector database ;
- pas de RAG ;
- pas de LangGraph au départ ;
- pas de système multi-agent complexe ;
- pas de scraper LinkedIn maison ;
- pas de serveur SMTP maison ;
- pas de tracking des ouvertures ;
- pas de tracking de clic sophistiqué ;
- pas de CRM complet ;
- pas de machine learning custom ;
- pas de scoring prédictif ;
- pas de Temporal ;
- pas de cinq fournisseurs d’enrichment.

Le Responses API permet déjà au modèle d’effectuer du web search et des appels d’outils, ce qui suffit largement pour la première version agentique.

---

# 30. Pas de LangGraph pour commencer

Un point qui peut sembler contre-intuitif :

je ne mettrais probablement **aucun framework agentique supplémentaire** dans V1.

Pas besoin de :

```text
LangGraph
CrewAI
AutoGen
etc.
```

Tu peux simplement avoir :

```ts
async function researchAccount(account) {
  return openai.responses.create(...)
}
```

avec :

```text
structured output
web_search
tool calls
```

Puis le résultat revient dans ton workflow classique.

Si dans six mois tu constates réellement que :

```text
researcher agent
→ critic agent
→ email researcher
→ validation agent
```

apporte un gain mesurable, tu introduis alors un orchestrateur agentique.

Mais pas avant.

---

# 31. Architecture des agents

Je créerais simplement quelques services conceptuels.

```text
AccountDiscoveryAgent

AccountResearchAgent

ContactDiscoveryAgent

EmailPatternAgent

PersonalizationAgent

ReplyClassifier
```

Chacun :

```text
petit contexte
mission unique
JSON output
sources
confidence
```

Exemple :

```text
AccountResearchAgent
```

ne sait pas envoyer d’email.

```text
PersonalizationAgent
```

ne sait pas rechercher de nouveaux prospects.

```text
ReplyClassifier
```

ne sait pas modifier une campagne.

C’est de l’agentic fortement contraint.

Et c’est précisément ce qui est souhaitable.

---

# 32. Provenance des informations

Je considère cette fonctionnalité presque indispensable.

À côté de :

```text
Alice Dupont
Head of Partnerships
Acme
```

l’UI doit pouvoir afficher :

```text
Head of Partnerships
Source:
acme.com/team/alice
Fetched:
08/11/2026
Confidence:
96%
```

Pour la personnalisation :

```text
"Acme vient d'ouvrir son marché espagnol."
```

également :

```text
source
date
confidence
```

Cela évite l’un des pires problèmes du cold email automatisé :

> envoyer une personnalisation fausse avec énormément d’assurance.

---

# 33. UI minimale

Je construirais seulement six écrans.

### Prospects

```text
Company
Person
Role
Email
Confidence
Campaign
Status
```

### Prospect detail

```text
contact
company
research
sources
email inference
message history
```

### Campaign

```text
ICP
sequence
templates
settings
```

### Review queue

```text
Approve
Edit
Reject
Research again
```

### Inbox

```text
Positive
Questions
Negative
OOO
Unsubscribe
```

### Settings

```text
Microsoft connection
sending limits
suppression
AI models
```

C’est suffisant pour une première vraie version.

---

# 34. Workflow V1 concret

Je commencerais volontairement par l’envers de ton workflow actuel.

Pas par la recherche.

## Vertical slice n°1

Utilisateur crée manuellement :

```text
Jean Dupont
Acme
jean.dupont@acme.com
```

Puis le produit sait :

```text
generate email
↓
review
↓
Graph draft
↓
Graph send
↓
wait 3 days
↓
detect reply
↓
send / cancel follow-up
```

À ce stade, tu as déjà résolu le problème le plus difficile :

> l’automatisation fiable de la séquence.

---

# 35. V2 : prospect discovery

Ensuite seulement :

```text
ICP
↓
account search
↓
contact search
↓
sources
↓
dedupe
```

---

# 36. V3 : email resolver

Ensuite :

```text
domain resolution
↓
public email research
↓
pattern detection
↓
candidate generation
↓
confidence
↓
optional fallback
```

---

# 37. V4 : autonomie

Enfin :

```text
confidence-based approvals
auto sending
advanced reply handling
automatic research routing
```

Cette progression permet de tester indépendamment chaque hypothèse.

---

# 38. Evals à mettre en place très tôt

Tu dois pouvoir mesurer autre chose que :

```text
"ça a l'air de marcher"
```

Je constituerais environ 100 prospects manuellement vérifiés.

Pour chacun :

```text
correct company
correct person
correct role
correct email
relevant personalization
```

Puis mesure :

```text
account precision
contact precision
email accuracy
research support rate
personalization acceptance
```

L’objectif est de pouvoir comparer :

```text
Sol
vs
Terra
```

ou :

```text
prompt V4
vs
prompt V5
```

sans intuition subjective.

C’est comme cela que tu pourras progressivement remplacer Sol par des modèles moins coûteux là où cela fonctionne.

---

# 39. KPI du produit

Je suivrais surtout :

```text
% prospects correctly identified

% emails high-confidence

bounce rate

reply rate

positive reply rate

manual review acceptance rate

average manual time / prospect

AI cost / prospect

research cost / prospect

messages accidentally blocked by policy

duplicate emails prevented
```

Et beaucoup moins :

```text
open rate
```

Pour un outil de customer discovery, la métrique dominante est :

```text
replies / qualified prospects
```

et surtout :

```text
useful conversations / qualified prospects
```

---

# 40. Stress test final de tes hypothèses

## « La prospection suit toujours quasiment le même workflow »

**Validée.**

C’est précisément un bon cas d’usage pour un workflow engine.

---

## « L’IA devrait orchestrer ce workflow »

**Rejetée.**

Elle doit intervenir dans certains nœuds, mais le workflow lui-même doit être déterministe.

---

## « GPT peut faire la recherche de prospects »

**Validée avec conditions.**

Chaque fait critique doit avoir :

```text
source
freshness
confidence
```

---

## « Une recherche LeadIQ/Clay suffit généralement à déterminer un pattern »

**Partiellement validée.**

L’idée du pattern est excellente.

En revanche, je remplacerais :

```text
LeadIQ/Clay first
```

par :

```text
open web first
↓
infer pattern
↓
paid provider if uncertain
```

---

## « Éviter les dépendances aux services externes payants »

**Validée.**

Mais attention : OpenAI web search est déjà une dépendance externe.

Il faut donc rechercher non pas :

```text
zero dependency
```

mais :

```text
replaceable dependency
```

D’où les adapters.

---

## « Luna est adapté au remplissage/personnalisation »

**Validée.**

Mais une partie encore plus grande du mail peut être générée sans LLM avec du templating.

---

## « IMAP/SMTP suffit »

**Techniquement validée, architecturalement rejetée.**

Pour Microsoft 365, Graph est un bien meilleur contrat d’intégration.

---

## « Les relances sont totalement automatisables »

**Validée.**

Avec une nuance fondamentale :

chaque relance doit repasser par une policy check juste avant l’envoi.

---

## « Je peux faire un système complètement autonome »

**Techniquement oui.**

Mais je le construirais progressivement :

```text
Manual
↓
Assisted
↓
Autonomous
```

---

# 41. Architecture cible finale

```text
                           USER
                            │
                            ▼
                  ┌──────────────────┐
                  │     Next.js      │
                  └────────┬─────────┘
                           │
                ┌──────────▼──────────┐
                │     PostgreSQL      │
                │                     │
                │ accounts            │
                │ contacts            │
                │ campaigns           │
                │ enrollments         │
                │ messages            │
                │ evidence            │
                │ suppression         │
                └──────────┬──────────┘
                           │
                           ▼
                 ┌──────────────────┐
                 │   Trigger.dev    │
                 └───┬─────────┬────┘
                     │         │
             research│         │mail
                     │         │
                     ▼         ▼
           ┌─────────────┐ ┌─────────────┐
           │ OpenAI      │ │ MS Graph    │
           │ Responses   │ │             │
           │             │ │ Outlook     │
           │ Sol/Terra   │ │ OAuth       │
           │ Luna        │ │ Webhooks    │
           │ web_search  │ │ Delta       │
           └──────┬──────┘ └──────┬──────┘
                  │               │
                  ▼               │
           ┌──────────────┐       │
           │ Open web     │       │
           │ DNS          │       │
           │ optional     │       │
           │ enrichments  │       │
           └──────────────┘       │
                                  │
                       inbound replies
                                  │
                                  └──────► DB
```

---

# 42. Mon choix concret pour commencer le développement

Si je devais figer aujourd’hui la stack du repository :

```text
Language
TypeScript

Web
Next.js

Database
PostgreSQL

ORM
Drizzle

Workflow
Trigger.dev Cloud

AI
OpenAI Responses API

Research
OpenAI web_search

Research models
GPT-5.6 Sol/Terra

High-volume AI
GPT-5.6 Luna

Email
Microsoft Graph

Authentication
Microsoft OAuth + application auth

Deployment
Vercel + managed PostgreSQL + Trigger.dev

Monitoring
Trigger.dev logs
+ application event logs

External enrichment
None initially

Optional fallback
provider adapter
```

Et surtout :

```text
NO
microservices
agent framework
vector DB
custom queues
SMTP sending
LinkedIn scraping infrastructure
```

pour la première version.

---

# 43. Le véritable moat potentiel du produit

La partie intéressante n’est probablement pas :

> « l’IA peut écrire un cold email ».

Tout le monde peut faire ça.

La valeur du système se situe plutôt dans la boucle :

```text
ICP
↓
prospect discovery
↓
deduplication
↓
evidence
↓
email resolution
↓
personalization
↓
outreach
↓
reply
↓
classification
↓
learning
```

Autrement dit, ce n’est pas vraiment un « AI email sender ».

C’est plutôt un :

> **prospecting operating system utilisant des agents pour transformer un ICP en conversations qualifiées tout en gardant un état fiable de chaque relation.**

Et l’architecture proposée permet justement de commencer très simplement avec ton usage personnel tout en ayant une trajectoire crédible vers un produit plus large sans devoir réécrire le cœur du système.
