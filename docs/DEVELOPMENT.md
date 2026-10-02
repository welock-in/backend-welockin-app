# Développement et opérations du backend

Ce guide correspond à la source `88e6409`, relue le 3 octobre 2026. Utiliser le lockfile du dépôt ; `package.json` déclare Node `>=18`, sans certifier chaque runtime hôte. Le paquet privé reste `0.1.0`.

## Installation locale

Depuis ce dépôt, avec Node/npm disponibles :

```powershell
npm ci
Copy-Item .env.example .env
```

Configurer `.env` avec une base dédiée au développement et un secret local. `postinstall` génère Prisma Client ; cette génération n'applique pas le schéma. MongoDB doit être un replica set pour les transactions Prisma. Les exemples du README et de `.env.example` sont des valeurs de développement, jamais une configuration de production à recopier.

Sur une base **jetable** explicitement sélectionnée, `npm run prisma:push` prépare collections/indexes puis `npm run dev` sert `http://localhost:8787`. Pour raccorder l'admin, utiliser `BACKEND_API_URL=http://localhost:8787/api` dans son dépôt. Les clients desktop utilisent leur propre configuration d'URL : vérifier leur build avant d'interpréter un test croisé.

## Configuration à connaître

`src/lib/env.ts` est l'autorité sur les valeurs par défaut, validations et compatibilités ; `.env.example` décrit aussi les options. Ne pas enregistrer de valeurs de credentials dans les documents ou sorties partagées.

| Groupe | Noms principaux | Effet / attention |
| --- | --- | --- |
| Service | `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `NODE_ENV`, `CORS_ORIGIN` | Base, JWT, port et origines ; secrets fondamentaux obligatoires en production. |
| Admin | `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_JWT_SECRET`, `ADMIN_JWT_EXPIRES_IN`, `LIVE_SESSION_STALE_SECONDS` | Mot de passe vide = login admin désactivé ; JWT distinct de `User.isAdmin`. |
| Email | `RESEND_API_KEY`, `RESEND_FROM`, `PUBLIC_SITE_URL`, `AUTH_TOKEN_PEPPER`, `EMAIL_VERIFICATION_TTL_MINUTES`, `EMAIL_VERIFICATION_MAX_ATTEMPTS`, `PASSWORD_RESET_TTL_MINUTES`, `EMAIL_VERIFICATION_ENFORCED` | Liens/codes email et déploiement progressif de la vérification. |
| Essais / identité | `TRIAL_LEDGER_PEPPER`, `TRIAL_DAYS`, `TRIAL_DAYS_UNVERIFIED`, `SIGNUP_TRIAL_ENABLED`, `DEVICE_BINDING_ENFORCED`, `SIGNUP_PAYING_DEVICE_BLOCK` | Pepper stable ; essais existants distincts de création de nouveaux essais. |
| Entitlement | `ENTITLEMENT_ENFORCED`, `ENTITLEMENT_SIGNING_KEY` | Signal d'enforcement et reçus signés pour les clients. |
| Lemon Squeezy | `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `LEMONSQUEEZY_VARIANT_LIFETIME`, `LEMONSQUEEZY_VARIANT_MONTHLY`, `LEMONSQUEEZY_VARIANT_YEARLY`, `LEMONSQUEEZY_VARIANTS_GRANTING`, `LEMONSQUEEZY_API_BASE`, `LEMONSQUEEZY_ALLOW_TEST_MODE` | Configuration paiement cohérente ; conserver les anciennes variantes encore valides. `LEMON_API_KEY` est un alias historique. |
| RevenueCat | `REVENUECAT_WEBHOOK_AUTH_TOKEN`, `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_WEBHOOK_HMAC_SECRET`, `REVENUECAT_PROJECT_ID`, `REVENUECAT_EXPECTED_ENTITLEMENT`, `REVENUECAT_ALLOWED_APP_IDS`, `REVENUECAT_ALLOW_SANDBOX`, `REVENUECAT_SANDBOX_ALLOWED_USER_IDS`, `REVENUECAT_API_BASE` | Webhook + relecture API ; sandbox ne doit pas accorder des droits réels à tous les comptes. |
| Apple / attest | `APPLE_BUNDLE_ID`, `APPLE_ENVIRONMENT`, `APPLE_PURCHASES_ENABLED`, `ATTEST_REQUIRED`, `APP_ATTEST_ENV`, `APP_ATTEST_APP_ID` | Identité et transactions distinctes d'App Attest, dont le vérificateur reste à implémenter. |
| Notifications / cron / analytics | `EXPO_ACCESS_TOKEN`, `CRON_SECRET`, `POSTHOG_API_KEY`, `POSTHOG_HOST` | Livraison, tâches HTTP périodiques, événements analytics. |
| Tests | `AUTH_RATE_LIMIT_DISABLED` | Désactivation du rate limit réservée aux tests. |

La configuration paiement partielle peut désactiver le storefront en production ; hors production elle fait échouer l'initialisation. Vérifier le verdict dans les logs et `/api/health/config` avec authentification admin, plutôt que supposer qu'une variable ajoutée est visible dans un déploiement déjà construit.

## Commandes présentes

| Commande npm | Utilisation |
| --- | --- |
| `dev`, `build`, `start` | Surveillance TS, génération Prisma + compilation dans `dist/`, puis serveur compilé. |
| `typecheck` | Vérification TypeScript sans émission. |
| `test` | Suites unitaires/contrats `src/**/*.test.ts` ; méthodes Prisma simulées. |
| `test:billing:mongo` | Toutes les suites `tests/mongo/*.mongo.test.ts` : facturation et autres contrats Mongo présents, dont friend-focus. Le harness lance un replica set local jetable ; peut télécharger un binaire Mongo. |
| `test:release` | Tests isolés du publisher Windows et du preflight backend, avec frontières de service factices. |
| `prisma:generate`, `prisma:push` | Génération client seule / application de schéma à la base ciblée. |
| `reconcile:feedback`, `feedback:set-admin` | Recalcul compteurs feedback / attribution du rôle de modération. |
| `device:migrate`, `entitlement:migrate`, `auth:migrate`, `friend-focus:migrate` | Scripts de migration à lire avant exécution : certains modifient comptes, index ou doublons. |
| `protection:seed`, `notifications:seed` | Données de départ ; inspecter la cible et les règles de conservation. |
| `dev:scenario` | États d'accès fictifs sur base dont le nom est qualifié dev/test/local/staging/sandbox ; modifie des comptes. |

Autres scripts ne disposant pas d'alias npm : `scripts/friend-focus-events-migrate.ts` (sans `--apply`, affiche les index proposés sans connexion), `scripts/focus-duration-impact.ts` (rapport de recalcul), `scripts/verify-billing-indexes.mjs`, `scripts/gen-entitlement-key.mjs`, `scripts/verify-release-backend.mjs`, `scripts/publish-windows-release.mjs`. Ils ont des effets et arguments distincts ; leur présence ne les rend pas tous sûrs à lancer sur une base existante. Le script de clé produit du matériel privé, à conserver hors journaux partagés.

## Validation selon le changement

```powershell
npm run typecheck
npm test
npm run build
```

Pour un changement d'index, de transaction, de réservation ou de concurrence : ajouter la suite Mongo correspondante (`npm run test:billing:mongo`). Les tests simulés ne prouvent pas la garantie Mongo. Pour des opérations Windows : `npm run test:release` couvre le tooling sans publier. Un commentaire documentaire seul se vérifie par diff, absence de modification des tokens exécutables et `git diff --check`.

Ces résultats prouvent le code local testé. Ils ne prouvent ni paiement réel, ni production Mongo, ni livraison Expo à un appareil, ni fonctionnement du blocage natif. Ne pas importer une ancienne note de tests comme résultat de la version courante.

## Base existante et production

`prisma db push` vise toute la base et n'est pas une procédure générale de migration de production. Pour une base existante, inventorier les index/doublons puis choisir une opération ciblée revue, avec sauvegarde, qualification et lecture après opération. `device:migrate` supprime notamment les doublons d'appareils et l'ancien index téléphone unique. Le dry-run `entitlement:migrate -- --dry-run` vérifie et compte sans créer d'index ; ne pas déduire qu'il a préparé la base.

Le backend Vercel et le serveur Node utilisent la même application, mais le scheduler des crons est externe. Vérifier `/api/health` (processus) et `/api/health/db` (connexion DB) séparément ; `/api/health/config` admin aide à identifier le commit/configuration effectifs. Vérifier aussi les tâches dues/dead letters, plutôt que considérer un HTTP 200 de cron comme absence d'échecs.

Un push GitHub, une compilation, un déploiement backend et une publication Windows sont quatre événements distincts. Aucun workflow `.github` n'est versionné ici ; l'intégration d'hébergement Git peut toutefois déclencher un déploiement. Le build n'a plus de hook de publication Windows. Consulter [scripts/releases/README.md](../scripts/releases/README.md) avant toute opération de release ; ses manifests historiques et preflights sont volontairement épinglés à leurs propres sources.
