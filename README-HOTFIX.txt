EcoRail Planner — V0.3.0 Global Beta
=====================================

Ce hotfix est cumulatif par rapport à la V0.2.8.1 actuellement déployée.
Remplacer / ajouter TOUS les fichiers présents dans l'archive en conservant leurs chemins.

Nouveau dans V0.3.0
-------------------
- Origine et destination libres : ville, adresse ou lieu.
- Géocodage dynamique via Transitous/MOTIS.
- Découverte dynamique des gares ferroviaires autour du départ et le long du corridor.
- Maximum 12 gares candidates réellement testées pour garder un calcul raisonnable.
- Transitous/MOTIS devient le moteur ferroviaire principal y compris en France.
- Navitia reste un fallback France seulement.
- Fuseau horaire du départ et de la destination détecté automatiquement.
- Les fonctions stables V0.2.8.1 sont conservées : Jour J / veille, Top 3 par critère,
  détails des correspondances, comparaison 100 % voiture, carte voiture + train.
- Pas de nouvelle clé API obligatoire.

Nouveau fichier à créer
-----------------------
lib/providers/transitous-locations.ts

Tests suggérés après déploiement
--------------------------------
1. Courlaoux -> Düsseldorf (régression de référence)
2. Brest -> Amsterdam
3. Marseille -> Milan
4. Lyon -> Genève
5. Tokyo -> Kyoto (test hors Europe, selon couverture Transitous)

Limites Global Beta
-------------------
- La couverture ferroviaire dépend des données publiques disponibles dans Transitous.
- Les trajets nécessitant une traversée maritime / sans itinéraire automobile direct peuvent
  ne pas être compatibles avec la comparaison 100 % voiture actuelle.
- Le géocodage est libre mais il n'y a pas encore d'autocomplétion pendant la saisie.

Validation locale effectuée
----------------------------
- Contrôle TypeScript du dossier lib/ : OK avec TypeScript 5.8.3.
- Transpilation syntaxique de tous les fichiers .ts/.tsx : OK.
- npm install complet non terminé dans l'environnement de génération ; Vercel reste le build final de référence.
