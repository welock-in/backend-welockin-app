# Architecture du backend WeLockIn

Référence de lecture : `origin/main`, commit `88e6409be22d637415f0e8206f986532cae3a32c`, récupéré le 3 octobre 2026. La version du paquet est `0.1.0` ; elle ne décrit pas la version installée des applications ni l'état de production.

## Responsabilité et points d'entrée

Ce dépôt fournit l'API commune aux clients Windows, macOS et mobile, au site et à la console admin. Il stocke les comptes, appareils, snapshots de configuration, événements de focus, droits d'accès, achats, salles partagées et journaux de livraison. Le blocage des applications/sites est effectué par les clients : une ligne serveur ne prouve pas que le système a effectivement bloqué une application.

`src/app.ts` compose Express et ses routes. `src/index.ts` lance le serveur local et ferme le serveur puis Prisma sur SIGINT/SIGTERM. `api/index.ts` exporte la même application pour Vercel. `vercel.json` envoie toutes les requêtes à cette unique fonction ; les tâches récurrentes passent par des routes HTTP, sans worker permanent dans ce dépôt.

| Emplacement | Rôle et point de départ |
| --- | --- |
| `src/routes/` | Contrats HTTP et orchestration ; tests de routes adjacents. |
| `src/validation/schemas.ts` | Formes, plafonds et validation Zod des entrées. |
| `src/middleware/` | JWT utilisateur/admin, fraîcheur de session, vérification email, App Attest et erreurs. |
| `src/lib/` | Configuration, accès Prisma, paiements, entitlement, essais, signature des reçus et services externes. |
| `src/services/` | Calculs focus/analytics, politique sync et pipeline notifications. |
| `prisma/schema.prisma` | Modèles MongoDB ; les index partiels et TTL peuvent aussi être définis par les scripts. |
| `tests/mongo/` | Contrats nécessitant transactions, index et concurrence sur un replica set jetable. |
| `scripts/` | Maintenance de données, scénarios de développement et opérations de publication explicitement séparées. |
| `data/` | Données de départ de la protection. |
| `src/admin/page.ts` | Ancienne interface du feedback sous `/admin`, distincte de la console admin externe. |

## Authentification et erreurs

Helmet et CORS précèdent le parseur JSON limité à 5 Mo. Celui-ci conserve les octets originaux dans `rawBody` pour la signature Lemon Squeezy ; signer un JSON reconstitué ne valide pas le message reçu.

Les routes `/api/auth`, contact, referrals, funnel, health et updates ont leurs propres règles publiques. Le montage `friendFocusReportRouter` permet aux extensions Screen Time de signaler une tentative avec une capacité de membre de salle, sans JWT de l'application. Le reste de `friend-focus` nécessite le JWT utilisateur.

`requireAuth` vérifie la signature ; `requireCurrentSession` vérifie que le compte existe et que le token n'est pas antérieur au changement de mot de passe. `requireVerifiedAccount` ajoute la vérification email lorsque son flag est activé. Les routes d'onboarding, entitlement, billing, purchases, attest et protection restent accessibles avec une session actuelle sans exiger cette vérification : consulter la raison du blocage ou enregistrer un paiement déjà pris doit rester possible. Les montages exacts sont dans `src/app.ts`.

La console utilise un JWT admin issu de `/api/admin/login`, avec les identifiants d'environnement du backend. `User.isAdmin` sert au feedback et ne remplace pas cette authentification. Les crons exigent `CRON_SECRET` ; son absence retourne 503 et désactive le travail.

`src/middleware/error.ts` produit `{ error }`, éventuellement `code` et détails : validation 400, conflit unique 409, identifiant Mongo malformé 400, ligne disparue 404, autre erreur 500 sans détails internes. Les clients doivent traiter les codes de métier, pas déduire un état d'accès du texte du message.

## Flux et invariants partagés

### Configuration et focus

`/api/sync/push` remplace un snapshot par dernière écriture lorsqu'il porte une configuration complète. `shouldReplaceSnapshot` conserve la compatibilité des anciens clients mobiles qui envoient uniquement des événements : leur rejeu ne doit pas restaurer une vieille configuration desktop. `/api/sync/pull` retourne des tableaux vides et revision 0 avant le premier snapshot. Il n'existe pas de fusion générale des changements concurrents par champ.

Les flux v2 `/api/sync/events/v2` et `/api/focus-events/v2` stockent des durées mesurées et des identifiants stables, indépendamment des snapshots. Le premier contenu enregistré pour `(userId, clientEventId)` est immuable ; un rejeu incompatible retourne `FOCUS_EVENT_CONFLICT`. Un lot n'est pas intégralement atomique : conserver les identifiants acquittés et rejouer le même contenu après interruption. Un appareil inconnu/étranger produit une quarantaine. Le rejeu v2 ne la modifie pas ; cependant `creditPendingEvents` dans `routes/devices.ts` peut la lever à l'enregistrement de l'appareil, sans filtre de version. La garantie de quarantaine immuable après enregistrement n'est donc pas établie par cette source. [FOCUS-EVENTS-V2.md](../FOCUS-EVENTS-V2.md) décrit entrées, acquittements et erreurs avec cette limite.

`src/services/focus-duration.ts` est la règle commune des agrégats : v2 valide = mesuré ; ancien événement avec budget = estimation bornée ; contenu invalide/inconnu = indisponible. Les documents historiques sans champ `quarantined` restent créditables ; seule la valeur explicite `true` les exclut. Les historiques admin restent consultables sans créditer les lignes en quarantaine.

`Device` est un inventaire : plusieurs téléphones sont autorisés. Les identifiants restent fournis par le client ; l'inventaire et l'attribution ne constituent pas une attestation matérielle. Les heartbeats `/api/sessions` alimentent `LiveSession`, dont la visibilité dépend de la fraîcheur et des rapports des clients. `forceEnd` est une demande serveur que le client doit consommer.

### Droits et facturation

`src/routes/entitlement.ts` rassemble les entrées puis appelle le resolver de `src/lib/entitlement.ts` sur l'horloge serveur. Les champs miroir de `User` sont un cache, pas une preuve d'achat. Les droits sont qualifiés par plateforme ; Windows et macOS partagent le périmètre desktop, tandis que les offres de création iOS ont leur propre périmètre. Consulter [DESKTOP-LIFETIME.md](../DESKTOP-LIFETIME.md) et les tests desktop/signup avant toute évolution.

`SIGNUP_TRIAL_ENABLED` est désactivé par défaut : un compte neuf ne reçoit donc pas systématiquement un nouvel essai gratuit. Les anciennes fenêtres restent reconnues. `TrialClaim` et les signaux matériels empêchent de renouveler une fenêtre simplement en supprimant le compte ; leur fonctionnement dépend des index et du pepper stable. Les réservations lifetime sont prises à la création, puis qualifiées lors de la vérification email ou d'une identité Apple vérifiée. Désactiver une offre n'annule pas les réservations passées et ne résilie pas les abonnements.

Les identités d'achat sont indexées par fournisseur ET identifiant externe. Lemon Squeezy vérifie les octets/signatures et variantes ; RevenueCat authentifie le webhook puis relit le subscriber ; Apple vérifie le JWS et ses contraintes. Les flags de création d'achat et les filtres test/sandbox sont distincts : ne pas utiliser une offre desktop pour transférer la propriété d'une transaction Apple.

`CheckoutIntent`/`AcquisitionLock`, les transactions et les gardes conditionnelles encadrent les courses checkout/annulation. `BillingTask` garde les annulations dues au fournisseur après suppression de compte ou changement de droits. Une réponse HTTP réussie du drain n'implique pas que toutes les tâches sont réglées : lire `stillOwed` et les dead letters dans la console.

### Notifications et salles partagées

`FocusInvite` invite les autres appareils du même compte ; push mobile et consultation des invitations sont deux transports. L'intention contient la durée restante, pas les tokens opaques de sélection iOS. Le client cible choisit sa sélection et consomme l'invitation ; une ligne ou un ticket Expo ne prouve pas la réception.

Les Study Rooms réunissent plusieurs comptes. Les transitions et événements sont sérialisés contre la salle ; le curseur du flux est opaque, lié à la salle et avancé selon une séquence transactionnelle. La première consultation initialise un curseur sans rejouer les anciennes alertes. L'événement est conservé avant l'envoi Expo ; un échec du stockage push ne doit pas effacer ce signal. La capacité de tentative iOS n'est jamais exposée dans le feed. [STUDY-ROOM-EVENTS.md](STUDY-ROOM-EVENTS.md) détaille cooldown, rétention, curseurs, crash et limites de livraison.

Le pipeline `services/notifications/` résout audience/règles/templates, envoie et contrôle les reçus. `provider_confirmed` est une confirmation fournisseur ; le système de notification du téléphone reste à vérifier sur appareil. Un reçu d'une ancienne inscription n'invalide pas un token réinscrit plus récemment.

## Déploiement et limites

Les quatre crons déclarés sont notification-receipts (5 min), billing-tasks (15 min), trial-reminders (horaire), checkout-abandoned (6 h). Leur exécution effective dépend du scheduler et de sa configuration ; le fichier ne constitue pas une preuve de fonctionnement déployé.

App Attest est présent comme échafaudage et refuse l'enregistrement tant que le vérificateur natif n'est pas implémenté. Activer `ATTEST_REQUIRED` ne l'implémente pas. Les protections locales, push sur appareil, paiement réel, index de production et publication des binaires exigent leur propre validation.

Le dépôt ne contient pas de workflow `.github`. Une intégration Vercel configurée sur GitHub peut néanmoins construire/déployer lors d'un push : cette configuration externe n'est pas décrite par le seul arbre Git. Le hook de publication Windows `vercel-build` a été retiré ; build backend et publication Windows sont des opérations différentes. Les manifestes historiques sous `scripts/releases/` sont conservés avec leurs SHAs et rollout, sans être une invitation à republier.
