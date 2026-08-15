V0.3.0.1 Global Beta — hotfix cumulatif

Ce ZIP est volontairement cumulatif et s'ouvre directement sur les chemins du projet.
Remplacer tous les fichiers présents en conservant leurs chemins.

Correction principale :
- lib/search-engine.ts est bien la version V0.3 et renseigne candidateStationCount dans SearchResponse.

Le log Vercel précédent montrait que lib/types.ts était en V0.3 mais que lib/search-engine.ts était encore l'ancien fichier V0.2.x.

Après déploiement, l'interface doit afficher : 🌍 V0.3.0.1 Global Beta
