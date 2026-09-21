# Offre lifetime desktop

Les nouveaux comptes créés par email et mot de passe depuis les applications
Windows ou macOS reçoivent un accès desktop à vie. Le champ optionnel
`User.desktopLifetimeGrantedAt` est enregistré dans la même écriture que le compte.
Les applications actuelles transmettent déjà leur identifiant `win-…` ou `mac-…`.
Le préfixe identifie le client ; il ne constitue pas une attestation matérielle.

Le droit fonctionne sur les deux plateformes desktop, y compris après une
réinstallation ou sur un autre ordinateur connecté au même compte. Les comptes
existants ne sont pas convertis lors d'une connexion. L'inscription Apple mobile
reste inchangée ; les applications desktop actuelles utilisent email/mot de passe.

## Paiements et mobile

- Aucun achat, abonnement, paiement ou complément administrateur n'est créé.
- Sur desktop : `status=active`, `isPro=true`, `plan=lifetime`, aucune date de fin
  d'essai ou d'abonnement pour ce droit, `billingProvider=NONE` sans achat existant.
- Le même compte sur iOS conserve ses droits habituels. Le droit desktop n'entre
  jamais dans le cache global `User.isProCached`/`plan`.
- Les trois offres de paiement sont refusées aux bénéficiaires desktop avec le
  code existant `LIFETIME_ALREADY_OWNED`. Les intégrations, webhooks et portails
  de paiement restent en place. Un abonnement déjà présent reste consultable et
  gérable ; cette offre ne résilie ni ne rembourse un abonnement existant.
- Le reçu signé reste attaché à l'appareil et conserve le renouvellement hors
  ligne habituel de 30 jours. Le droit à vie n'expire pas avec ce reçu : une
  connexion au serveur permet de le renouveler. La révocation administrative
  reste prioritaire.

## Activer et fermer l'offre

`DESKTOP_LIFETIME_SIGNUP_ENABLED` vaut `true` par défaut dans cette version.
Le changement devient effectif à la publication du backend contenant ce code.
Les corrections des textes et raccourcis du profil nécessitent la publication
des nouvelles applications desktop.

Pour remettre le paiement en place pour les **futurs inscrits**, définir
`DESKTOP_LIFETIME_SIGNUP_ENABLED=false` dans l'environnement du backend puis le
redéployer. Les droits à vie déjà accordés restent acquis. Les anciens réglages
de paiement et d'essai conservent leur rôle ; cette option ne les modifie pas.

Le nouveau champ MongoDB est optionnel et sans index : régénérer Prisma avec
`npm run prisma:generate` lors de la construction suffit. Aucune migration de
données, aucun backfill et aucun `prisma db push` ne sont nécessaires.

## Validation locale

Les tests HTTP simulent les écritures Prisma et les prestataires : ils couvrent
l'inscription desktop/mobile, le réglage de fin d'offre, la non-conversion des
comptes existants, la persistance du droit, les reçus signés, les achats refusés
sur desktop, les droits mobiles et la gestion d'un abonnement existant.

Les tests d'interface vérifient les libellés anglais/français et l'absence
d'incitation à acheter pour le compte lifetime. Ces vérifications ne remplacent
pas une inscription sur les binaires installés après publication.

## Publication ponctuelle de Windows 0.3.46

La branche d'exploitation `ops/windows-release-0.3.46` ajoute un hook
`vercel-build` pour publier l'artefact Windows déjà construit et signé, depuis
l'environnement Vercel disposant des identifiants administrateur. Cette opération
ne modifie ni le paiement, ni les droits, ni le code métier du backend.

Sans `WINDOWS_RELEASE_VERSION`, le hook de publication ne lit aucun identifiant
et n'effectue aucun appel réseau. Son activation exige l'environnement production
et la valeur exacte `0.3.46`. Le manifeste commité sous `scripts/releases/` fixe
l'URL, les tailles, les empreintes SHA-256 de l'installeur et de sa signature,
ainsi que le commit des sources Windows. Son propre contenu est également vérifié.
La signature a déjà été vérifiée cryptographiquement lors de la construction ;
ce script compare les octets publiés avec ces empreintes approuvées.

Après revue, la commande ponctuelle depuis cette branche est :

```sh
vercel deploy --prod --skip-domain --build-env WINDOWS_RELEASE_VERSION=0.3.46
```

`--skip-domain` conserve l'alias du backend existant. Ne pas enregistrer ce
drapeau comme variable permanente du projet, ni fusionner cette branche pour
déclencher une publication automatique. Le script utilise seulement les routes
admin HTTPS existantes ; les identifiants et le jeton restent en mémoire sur
Vercel, sans export local ni affichage. Il ne se connecte pas directement à MongoDB.

L'opération vérifie les fichiers publics avant connexion, refuse toute collision
de métadonnées et toute version Windows plus récente déjà live, puis crée un draft
et relit immédiatement la liste avant de publier son ID à 100 %. Les notes du
registre conservent le commit des sources Windows. Un retry reprend seulement un draft strictement identique
ou confirme une version identique déjà live à 100 %, sans republier cette dernière.
Les statuts paused/superseded/rolled_back et les déploiements partiels sont refusés.

La publication intervient pendant le build : si la suite du déploiement échoue,
vérifier les releases et manifests publics avant toute relance. Les tests mockés
du script se lancent avec `npm run test:release` ; ils n'utilisent aucun secret
et ne contactent aucun service réel.
