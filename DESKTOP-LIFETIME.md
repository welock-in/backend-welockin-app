# Lifetime offert à l’inscription

Deux offres indépendantes sont pilotées depuis l’admin : iOS/iPadOS et
Windows/macOS. Elles commencent **OFF**. Seuls les nouveaux comptes créés pendant
une offre ON réservent un cadeau ; une connexion, une association Apple ou la
vérification tardive d’un ancien compte ne l’inscrit pas à l’offre.

## Réservation et activation

La création enregistre `User.signupPlatform` et `signupLifetimeOffer` (`ios`,
`desktop` ou null) avec le compte. La réservation seule n’accorde aucun accès.
Après validation du code email, la même transaction marque le compte vérifié et
enregistre `iosLifetimeGrantedAt` ou `desktopLifetimeGrantedAt`. Les répétitions
ne changent pas la date du premier cadeau. Un nouveau compte Apple dont l’adresse
est vérifiée par Apple reçoit le cadeau dans son écriture de création.

Le réglage est lu à la création, pas lors de la vérification : repasser OFF
arrête les réservations pour les inscriptions suivantes et honore celles déjà
enregistrées. Les lifetimes déjà accordés sont permanents. Les anciens timestamps
desktop restent valides, même si cette ancienne version les écrivait avant la
vérification de l’email.

Une réservation remplace l’éventuel essai gratuit à l’inscription. Sans
réservation, `SIGNUP_TRIAL_ENABLED` et les règles d’essai habituelles conservent
leur comportement. Aucun essai existant n’est effacé.

## Portée et paiements

- L’origine d’inscription décide du cadeau réservé. La plateforme de la requête
  courante décide si ce cadeau s’applique. Les clients iOS transmettent
  `X-WeLockIn-Platform: ios` ou `ipados` ; les identifiants desktop `win-…`/`mac-…`
  restent compatibles. Ces informations identifient le client sans constituer
  une attestation matérielle. Une plateforme inconnue n’est jamais supposée iOS.
- Le droit desktop suit le compte entre Windows et Mac ; le droit iOS suit le
  compte entre iPhone et iPad. Aucun cadeau ne se propage à l’autre portée ou
  dans le cache global `User.plan`/`isProCached`.
- La réponse standard est `status=active`, `isPro=true`, `plan=lifetime`,
  `validUntil=null`, `complimentaryLifetime=ios|desktop`. `billingProvider=NONE`
  lorsqu’aucun achat lifetime réel ne prend la priorité.
- `hasApplePurchaseAccess` indique séparément une licence Apple non remboursée
  ou un abonnement Apple qui accorde encore l’accès. Le cadeau seul ne prouve
  pas la réussite d’une restauration d’achat Apple.
- Aucun `Purchase`, abonnement ou comp manuel n’est créé. Les trois nouvelles
  offres d’achat sont refusées sur la portée offerte avec `LIFETIME_ALREADY_OWNED`.
  Un achat déjà engagé reste traitable par les chemins habituels.
- Les webhooks, restaurations, remboursements et portails restent actifs.
  `manageableSubscription` reste fourni même si un cadeau donne aussi accès :
  les prélèvements existants ne sont ni annulés ni remboursés automatiquement.
- Les reçus signés restent liés au compte et à l’appareil ; leur renouvellement
  offline habituel ne transforme pas le lifetime en droit temporaire.
  Une révocation admin reste prioritaire sur tout cadeau.

## Configuration admin

`GET /api/admin/signup-lifetime` et `PATCH /api/admin/signup-lifetime` utilisent
la session admin existante. Le corps PATCH contient un ou deux booléens :
`iosSignupLifetimeEnabled` et `desktopSignupLifetimeEnabled`.

La réponse est `{ settings: { iosSignupLifetimeEnabled,
desktopSignupLifetimeEnabled, updatedAt, updatedBy } }`. Le document singleton
`SignupLifetimeSettings` porte l’identifiant `signup-lifetime` ; son absence
signifie OFF/OFF. Une panne de lecture renvoie une erreur explicite, pas un état
OFF fictif. Les écritures partielles préservent l’autre réglage et consignent
l’ancien/nouvel état dans `AdminAuditLog`, dans la même transaction.

L’ancienne variable **`DESKTOP_LIFETIME_SIGNUP_ENABLED` n’est plus lue**. Aucun
autre réglage de paiement n’est changé. En particulier `ENTITLEMENT_ENFORCED`
reste indépendant : cette offre crée un droit, elle ne désactive pas les gates.

## Livraison et retour arrière

Régénérer Prisma et construire le backend. Les champs utilisateur ajoutés sont
optionnels ; aucun compte existant n’est migré ou automatiquement gratifié.
Le nouveau document singleton utilise son index primaire MongoDB et est créé
au premier enregistrement admin, sans initialisation ON.

Déployer d’abord le backend compatible et l’admin avec OFF/OFF, puis la version
iOS qui transmet la plateforme et attend les droits après vérification. Les
clients desktop actuels utilisent déjà les préfixes nécessaires. Contrôler la
configuration effective d’enforcement avant de promettre un retour du paywall
desktop ; ne pas la changer globalement comme effet secondaire de cette offre.

Pour interrompre l’offre, remettre les switches OFF. Un retour à un ancien
backend pourrait rétablir l’ancien défaut desktop ON et ignorer les nouveaux
cadeaux iOS : préférer OFF et une correction compatible aux retours aveugles.

Les tests de logique et HTTP utilisent des dépendances simulées. Les tests
Mongo séparés démarrent une base temporaire locale. Une inscription et un achat
sandbox sur les applications installées restent nécessaires avant publication.
