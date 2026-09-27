#!/usr/bin/env node
// Test de non-regression pour l'export B_PLU.CSV (bouton "Exporter" + export ZIP).
//
// Contexte du bug corrige : buildBalancePluCsvText() doit reproduire le format natif attendu
// par la balance HELMAC HSM Pro (verifie sur un export pris directement sur la balance) :
//   - separateur POINT-VIRGULE (buildCsvText(), gardee pour l'export Excel, utilise la virgule)
//   - PLU zero-paddé sur 4 chiffres (ex. "6" -> "0006"), jamais depaddé
//   - un champ vide traînant en fin de ligne, avant le retour a la ligne
//
// Ce test extrait la fonction reellement expediee dans editeur-csv-largeur-fixe.html (pas une
// reimplementation a part) pour garantir qu'il verifie le code qui part vraiment sur la balance.
// Aucune dependance externe : `node test-export-balance-plu.js`.

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

// Charge buildBalancePluCsvText() (et sa dependance rowsSortedByPlu()) directement depuis le
// HTML dans un contexte vm ou `state` est fourni comme variable libre — exactement comme dans
// le fichier source, ou `state` est declare une fois en haut du script principal.
function loadRealFunctions(stateValue) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const mainScript = scripts.find(s => s.includes('function buildBalancePluCsvText'));
  if (!mainScript) throw new Error('Script principal (avec buildBalancePluCsvText) introuvable dans le HTML');

  const src = [
    extractFunction(mainScript, 'rowsSortedByPlu'),
    extractFunction(mainScript, 'buildBalancePluCsvText'),
    '\nmodule.exports = { rowsSortedByPlu, buildBalancePluCsvText };'
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
  // Ligne minimale : 19 colonnes balance. PLU volontairement sur 1 chiffre ("6") pour verifier
  // le zero-padding a 4 chiffres. Colonne 3 (Type) volontairement plus courte que sa largeur fixe
  // pour verifier que le padding espace (droite) des autres colonnes n'a pas ete casse.
  const row = ['6', 'divers alimentaire', '', 'P', '000150', '01', '0', '0', '0', '0', '0', '0', '0', '1', 'B000', 'P1', 'D0', 'O0', '0'];
  while (row.length < 19) row.push('');

  const state = {
    rows: [row],
    colMeta: row.map((v, ci) => ({ fixed: true, width: ci === 3 ? 5 : v.length })),
    lineEnding: '\r\n',
    trailingNewline: true
  };

  const { buildBalancePluCsvText } = loadRealFunctions(state);
  const csv = buildBalancePluCsvText();

  assertEqual(csv.endsWith('\r\n'), true, 'Fin de ligne CRLF');
  const lines = csv.slice(0, -2).split('\r\n');
  assertEqual(lines.length, 1, 'Nombre de lignes generees');

  const fields = lines[0].split(';');
  assertEqual(fields.length, 20, 'Nombre de champs par ligne (19 colonnes balance + 1 champ vide traînant)');
  assertEqual(fields[0], '0006', 'PLU zero-paddé sur 4 chiffres (bug corrige : ne doit plus etre depaddé en "6")');
  assertEqual(fields[1], 'DIVERS ALIMENTAIRE'.padEnd(26, ' '), 'Nom en majuscules, paddé a 26 caracteres');
  assertEqual(fields[3], 'P'.padEnd(5, ' '), 'Colonne a largeur fixe toujours paddée a droite avec des espaces');
  assertEqual(fields[19], '', 'Champ vide traînant en fin de ligne (avant le retour a la ligne)');
  if (lines[0].includes(',')) throw new Error('Le point-virgule attendu a ete remplace par une virgule quelque part');

  console.log('OK — buildBalancePluCsvText() produit bien le format natif (point-virgule, PLU "0006", champ vide traînant).');
}

try {
  run();
} catch (err) {
  console.error('ECHEC —', err.message);
  process.exit(1);
}
