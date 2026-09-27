#!/usr/bin/env node
// Test de non-regression pour l'export B_PLU.CSV (bouton "Exporter" + export ZIP).
//
// Contexte du bug corrige : buildBalancePluCsvText() doit reproduire le format natif attendu
// par la balance HELMAC HSM Pro (verifie octet pour octet sur un export pris directement sur la
// balance, 468 lignes) :
//   - separateur POINT-VIRGULE (buildCsvText(), gardee pour l'export Excel, utilise la virgule)
//   - 19 colonnes a largeur FIXE et connue (BALANCE_COL_SPECS), pas la largeur auto-detectee
//     depuis les donnees deja chargees (colMeta) qui se trompe des qu'une colonne technique ne
//     contient que des "0" par defaut
//   - colonnes numeriques (PLU, Prix, Categorie, compteurs internes...) zero-paddees a gauche
//     (ex. "1" -> "01"), y compris quand la valeur est vide/non numerique (traitee comme 0),
//     sauf le PLU qui n'est jamais fabrique a partir de rien
//   - colonnes texte (Nom, codes fixes...) paddees a droite avec des espaces ET tronquees si
//     elles depassent la largeur (un champ trop long decale toutes les colonnes suivantes)
//   - casse du nom preservee telle que saisie (pas forcee en majuscules)
//   - un champ vide traînant en fin de ligne, avant le retour a la ligne
//
// Ce test extrait les fonctions/constantes reellement expediees dans
// editeur-csv-largeur-fixe.html (pas une reimplementation a part) pour garantir qu'il verifie
// le code qui part vraiment sur la balance. Aucune dependance externe :
// `node test-export-balance-plu.js`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, 'editeur-csv-largeur-fixe.html');

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`Fonction ${name}() introuvable dans le fichier — a-t-elle ete renommee ?`);
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`Accolades non equilibrees en extrayant ${name}()`);
  return src.slice(start, i + 1);
}

function extractConst(src, name) {
  const marker = `const ${name} =`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`Constante ${name} introuvable dans le fichier — a-t-elle ete renommee ?`);
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '[' || src[i] === '{') depth++;
    else if (src[i] === ']' || src[i] === '}') depth--;
    else if (src[i] === ';' && depth === 0) break;
  }
  if (depth !== 0) throw new Error(`Crochets/accolades non equilibres en extrayant ${name}`);
  return src.slice(start, i + 1);
}

// Charge buildBalancePluCsvText() et ses dependances (BALANCE_COL_SPECS, rowsSortedByPlu())
// directement depuis le HTML, dans un contexte vm ou `state` est fourni comme variable libre —
// exactement comme dans le fichier source, ou `state` est declare une fois en haut du script
// principal.
function loadRealFunctions(stateValue) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const mainScript = scripts.find(s => s.includes('function buildBalancePluCsvText'));
  if (!mainScript) throw new Error('Script principal (avec buildBalancePluCsvText) introuvable dans le HTML');

  const src = [
    extractConst(mainScript, 'BALANCE_COL_SPECS'),
    extractFunction(mainScript, 'rowsSortedByPlu'),
    extractFunction(mainScript, 'buildBalancePluCsvText'),
    '\nmodule.exports = { BALANCE_COL_SPECS, rowsSortedByPlu, buildBalancePluCsvText };'
  ].join('\n\n');

  const sandbox = { state: stateValue, module: { exports: {} }, require };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'buildBalancePluCsvText-extrait.js' });
  return sandbox.module.exports;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}\n  attendu : ${JSON.stringify(expected)}\n  obtenu  : ${JSON.stringify(actual)}`);
  }
}

function run() {
  // Ligne volontairement "mal remplie" comme un vrai import Dolibarr/creation manuelle, pour
  // couvrir tous les cas corriges :
  //  - PLU sur 1 chiffre ("6")                    -> zero-paddé "0006"
  //  - Nom en casse mixte ET trop long (40 car.)   -> casse preservee, tronque a 26
  //  - Prix sur 3 chiffres ("150")                 -> zero-paddé a gauche "000150" (largeur 6)
  //  - Categorie sur 1 chiffre ("1")               -> zero-paddée a gauche "01" (largeur 2)
  //  - Champ 7 VIDE (jamais renseigne)             -> traite comme 0, zero-paddé "000" (largeur 3)
  const longName = "Divers d'alimentaire en vrac tres complet"; // 42 caracteres
  const row = ['6', longName, '', 'P', '150', '1', '', '0', '0', '0', '0', '1', 'B000', 'P1', 'D0', 'O0', '0', '', 'D0'];
  while (row.length < 19) row.push('');

  const state = { rows: [row], lineEnding: '\r\n', trailingNewline: true };

  const { BALANCE_COL_SPECS, buildBalancePluCsvText } = loadRealFunctions(state);
  const csv = buildBalancePluCsvText();

  assertEqual(csv.endsWith('\r\n'), true, 'Fin de ligne CRLF');
  const lines = csv.slice(0, -2).split('\r\n');
  assertEqual(lines.length, 1, 'Nombre de lignes generees');

  const fields = lines[0].split(';');
  assertEqual(fields.length, 20, 'Nombre de champs par ligne (19 colonnes balance + 1 champ vide traînant)');

  // Largeur EXACTE de chacune des 19 colonnes, quelle que soit la donnee source — c'est le coeur
  // du bug corrige (l'ancienne detection auto via colMeta se trompait des qu'une colonne
  // technique ne contenait que des "0").
  BALANCE_COL_SPECS.forEach((spec, i) => {
    assertEqual(fields[i].length, spec.width, `Colonne ${i} : largeur fixe exacte`);
  });

  assertEqual(fields[0], '0006', 'PLU zero-paddé sur 4 chiffres (bug corrige : ne doit plus etre depaddé en "6")');
  assertEqual(fields[1], longName.slice(0, 26), 'Nom tronqué à 26 caractères (bug corrige : ne doit plus déborder), casse préservée');
  assertEqual(fields[4], '000150', 'Prix zero-paddé à gauche sur 6 caractères (bug corrige : ne doit plus rester "150")');
  assertEqual(fields[5], '01', 'Catégorie zero-paddée à gauche sur 2 caractères (bug corrige : ne doit plus rester "1")');
  assertEqual(fields[6], '000', 'Colonne numérique vide traitée comme 0 plutôt que laissée à largeur variable');
  assertEqual(fields[19], '', 'Champ vide traînant en fin de ligne (avant le retour a la ligne)');
  if (lines[0].includes(',')) throw new Error('Le point-virgule attendu a ete remplace par une virgule quelque part');

  console.log('OK — buildBalancePluCsvText() produit bien le format natif (point-virgule, largeurs fixes exactes, PLU "0006", nom tronqué/casse préservée, champ vide traînant).');
}

try {
  run();
} catch (err) {
  console.error('ECHEC —', err.message);
  process.exit(1);
}
