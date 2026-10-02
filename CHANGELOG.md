# Notes de version du backend

Sélection non exhaustive du journal Git atteignable depuis `origin/main` au 3 octobre 2026 (`88e6409`). Les dates sont celles des commits. Le paquet reste `0.1.0` : les versions Windows citées sont des manifestes/outils conservés dans ce dépôt. Un commit, y compris intitulé « publish », ne prouve pas à lui seul une publication, un déploiement ou une installation actuels.

## 2026-10-03 — documentation

- Ajout des guides architecture/développement, navigation et historique sourcé ; commentaires sur les invariants des flux. Aucun comportement exécutable, version de paquet ni configuration modifiés.

## 2026-09-26

- `88e6409` : manifeste Windows 0.3.51, sources épinglées et rollout nul pour transition manuelle ; `2c35cbc` conserve la même restriction pour 0.3.50.
- `64b8470` : mise à jour des dépendances Express et parseurs de requêtes.
- `804e8b6` : attente progressive des tentatives bornées d'annulation lorsque des transactions concurrentes sont en cours.
- `95879dd` : événements de focus mesurés v2, rejeu protégé, crédit cohérent des durées et garde de départ des salles ; contrat dans [FOCUS-EVENTS-V2.md](FOCUS-EVENTS-V2.md).
- `ea53609` : conservation des tentatives de salle déjà enregistrées pendant les indisponibilités de stockage push.
- `7845d49` : création iOS éligible sans transférer les achats Apple ; `a6539ba` rattache les fixtures Mongo de facturation à chaque scénario.
- `439b798` : réduction de latence des invitations aux appareils sélectionnés.
- `f167832` : consolidation du tooling de release Windows avec retrait du hook de déploiement/publication.

## 2026-09-24

- `0a422c0` : événements persistants de tentatives dans les salles entre plateformes, feed à curseur et notification ; contrat dans [docs/STUDY-ROOM-EVENTS.md](docs/STUDY-ROOM-EVENTS.md).
- `c466763` : record épinglé Windows 0.3.49 conservé dans l'historique de publication.

## 2026-09-23

- `dcb2c46` : sérialisation des transitions de salles de focus partagées.
- `72b45b1` : snapshot des changements lifetime ensuite intégré par merge ; les settings d'offres de création et leurs droits restent distincts des abonnements.
- `f21531e` : snapshot des changements backend locaux retenus pour l'intégration de production ; ce message de snapshot couvre un ensemble de fichiers, pas une version publique autonome.
- `bad4f44` : exclusion des sorties locales de validation du déploiement.
- `55324b6` : record de publication Windows 0.3.48 épinglé aux sources intégrées.

## 2026-09-20

- `cd1d719` : accès lifetime pour nouveaux comptes desktop, sans modifier la facturation mobile.

## 2026-09-13 et 2026-09-12

- 13 septembre, `4636285` : télémétrie du parcours d'onboarding iOS.
- 13 septembre, `872e9c0` : noms d'applications dans les alertes friend-focus historiques.
- 12 septembre, `eca59bc` : alertes aux pairs sur tentatives bloquées ; `f5c10c8` introduit les salles de focus partagées.

## 2026-09-07 à 2026-08-17

- 7 septembre, `70fd9ae` : création de comptes depuis la console admin ; `4d14c70` : rattachement email/compte sur le parcours funnel.
- 28 août, `502f18c` : télémétrie d'inscription par run ; `58ee385` ajoute la cible macOS x86_64 aux mises à jour.
- 24 août, `47f3e27` : réponses funnel-v2 (université et slugs de statut).
- 23 août, `0db8e47` : comptage des arrivées via campagne QR par jour.
- 17 août, `ac564d4` : accès admin requis pour le diagnostic `/health/config`.

Pour le détail complet : `git log --date=short --oneline`, puis `git show <sha>`. Les anciens manifestes, les guides de contrat et les SHAs doivent être lus dans leur contexte ; aucune migration ni publication n'est exécutée par ces notes.
