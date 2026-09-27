# dashboard_boutique

Outil web mono-fichier (`editeur-csv-largeur-fixe.html`), pas de build step.

## Consigne systématique

À chaque modification poussée sur `editeur-csv-largeur-fixe.html`, mettre à jour le badge de
version affiché en haut à droite de la page :

```js
const APP_VERSION = 'vAAAAMMJJ_N';
```

- Format `vAAAAMMJJ_N` (année-mois-jour + numéro incrémental).
- Utiliser la date du jour ; incrémenter `N` si plusieurs mises à jour ont déjà eu lieu le même
  jour (ex. `v20260927_1` puis `v20260927_2`).
- Ne jamais laisser le badge sur une ancienne date après un commit de changement fonctionnel —
  c'est le seul moyen pour l'utilisateur de vérifier qu'il a bien la dernière version en ligne.
