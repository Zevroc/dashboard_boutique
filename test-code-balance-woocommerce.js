#!/usr/bin/env node
// Test end-to-end (Playwright, navigateur headless réel) pour la fonctionnalité "Code balance"
// (extrafield Dolibarr qui regroupe plusieurs articles sous un même code sur la balance) et le
// filtre "WooCommerce" (articles du site web exclus des étiquettes/catalogue).
//
// Charge la vraie page dans Chromium headless et pilote les hooks de test exposés sur `window`
// (voir "Hooks de test dédiés au code balance / WooCommerce" dans editeur-csv-largeur-fixe.html)
// plutôt que de réimplémenter la logique : on teste le code qui tourne réellement dans le
// navigateur, y compris le vrai `confirm()` natif (intercepté via l'API dialog de Playwright).
//
// Aucune dépendance à installer séparément si `playwright` est déjà disponible globalement sur
// la machine (vérifier avec `npx playwright --version`) : Node ne le résout alors que si
// NODE_PATH pointe vers les modules globaux. Lancer avec :
//   NODE_PATH=$(npm root -g) node test-code-balance-woocommerce.js
// (Si playwright n'est pas installé du tout : `npm install -g playwright` d'abord, ou adapter
// la commande ci-dessus à une installation locale classique avec un package.json.)

const path = require('path');
const { chromium } = require('playwright');

const HTML_PATH = path.join(__dirname, 'editeur-csv-largeur-fixe.html');
const FILE_URL = 'file://' + HTML_PATH;

let failures = 0;
function assert(cond, label) {
  if (!cond) {
    failures++;
    console.error('ECHEC —', label);
  } else {
    console.log('OK —', label);
  }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)})`);
}

// Construit une ligne complète (PLU + 19 colonnes balance + colonnes métier), toutes vides par
// défaut, avec les champs utiles à ce test renseignés — même forme que `new
// Array(19+BIZ_COL_COUNT).fill('')` côté app (voir applyDolibarrImportData).
function makeRow(bizcol, totalCols, { plu, nom, prix, codeBalance, woo }) {
  const row = new Array(totalCols).fill('');
  row[0] = plu;
  row[1] = nom;
  row[3] = 'P';
  row[4] = String(prix);
  row[5] = '1';
  if (codeBalance) row[bizcol.CODE_BALANCE] = codeBalance;
  if (woo) row[bizcol.WOOCOMMERCE] = '1';
  return row;
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Les <script src=cdnjs...> (jsPDF/JSZip/xlsx) ne sont pas nécessaires pour ce test (aucun
  // clic sur Exporter/Catalogue/ZIP, uniquement les hooks de test) — un éventuel échec réseau
  // sur ces libs ne doit pas faire échouer le chargement de la page.
  page.on('pageerror', err => console.error('Erreur JS page :', err.message));

  await page.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__opevSetRowsForTest === 'function');

  const { bizcol, totalCols } = await page.evaluate(() => ({
    bizcol: window.__opevBIZCOL,
    totalCols: 19 + window.__opevBIZ_COL_COUNT
  }));

  // ---------- Scénario 1 : même code balance, même prix -> une seule ligne export, code sur les 2 ----------
  {
    const rowA = makeRow(bizcol, totalCols, { plu: '0011', nom: 'Coquillettes', prix: 400, codeBalance: '0100' });
    const rowB = makeRow(bizcol, totalCols, { plu: '0012', nom: 'Tubes',        prix: 400, codeBalance: '0100' });
    await page.evaluate(rows => window.__opevSetRowsForTest(rows), [rowA, rowB]);

    const codes = await page.evaluate(() => {
      const rows = window.__opevGetRowsForTest();
      return rows.map(r => window.__opevCodeAfficheForTest(r));
    });
    assert(codes.every(c => c === '0100'), 'Scénario 1 : les 2 articles au même code balance affichent "0100" (étiquettes/catalogue)');

    const csv = await page.evaluate(() => window.__opevBuildBalancePluCsvTextForTest());
    const lines = csv.split('\r\n').filter(l => l !== '');
    assertEqual(lines.length, 1, 'Scénario 1 : une seule ligne dans l\'export balance pour le groupe');
    assert(lines[0].startsWith('0100;'), 'Scénario 1 : la ligne exportée utilise le code balance "0100" comme PLU');
    assert(lines[0].includes('000400'), 'Scénario 1 : le prix (400 centimes) est bien celui du groupe');
  }

  // ---------- Scénario 2 : même code balance, prix différents -> confirm() ----------
  {
    const rowE = makeRow(bizcol, totalCols, { plu: '0021', nom: 'Pâtes A', prix: 500, codeBalance: '0200' });
    const rowF = makeRow(bizcol, totalCols, { plu: '0022', nom: 'Pâtes B', prix: 600, codeBalance: '0200' });
    await page.evaluate(rows => window.__opevSetRowsForTest(rows), [rowE, rowF]);

    // 2a. L'utilisateur annule l'avertissement -> export abandonné (null).
    let dialogSeen = false;
    const onDismiss = dialog => { dialogSeen = true; dialog.dismiss(); };
    page.on('dialog', onDismiss);
    const resultCancelled = await page.evaluate(() => window.__opevBuildBalancePluCsvTextForTest());
    page.off('dialog', onDismiss);
    assert(dialogSeen, 'Scénario 2a : un avertissement (confirm) est bien déclenché pour un prix incohérent');
    assertEqual(resultCancelled, null, 'Scénario 2a : annuler l\'avertissement abandonne l\'export (null)');

    // 2b. L'utilisateur continue quand même -> une ligne, prix du premier article (plus petit PLU).
    const onAccept = dialog => dialog.accept();
    page.on('dialog', onAccept);
    const csv = await page.evaluate(() => window.__opevBuildBalancePluCsvTextForTest());
    page.off('dialog', onAccept);
    assert(csv !== null, 'Scénario 2b : continuer quand même produit un export (non null)');
    const lines = csv.split('\r\n').filter(l => l !== '');
    assertEqual(lines.length, 1, 'Scénario 2b : une seule ligne malgré le prix incohérent');
    assert(lines[0].startsWith('0200;'), 'Scénario 2b : la ligne exportée utilise le code balance "0200"');
    assert(lines[0].includes('000500'), 'Scénario 2b : le prix retenu est celui du premier article (PLU 0021, 500)');
  }

  // ---------- Scénario 3 : pas de code balance -> garde son PLU propre ----------
  {
    const rowG = makeRow(bizcol, totalCols, { plu: '0031', nom: 'Article seul', prix: 700 });
    await page.evaluate(rows => window.__opevSetRowsForTest(rows), [rowG]);

    const code = await page.evaluate(() => {
      const rows = window.__opevGetRowsForTest();
      return window.__opevCodeAfficheForTest(rows[0]);
    });
    assertEqual(code, '0031', 'Scénario 3 : sans code balance, codeAffiche = PLU propre de l\'article');

    const csv = await page.evaluate(() => window.__opevBuildBalancePluCsvTextForTest());
    const lines = csv.split('\r\n').filter(l => l !== '');
    assertEqual(lines.length, 1, 'Scénario 3 : une ligne export pour l\'article seul');
    assert(lines[0].startsWith('0031;'), 'Scénario 3 : la ligne exportée utilise le PLU propre "0031"');
  }

  // ---------- Scénario 4 : catégorie WooCommerce -> exclu étiquettes + catalogue ----------
  {
    const rowH = makeRow(bizcol, totalCols, { plu: '0041', nom: 'Produit web', prix: 999, woo: true });
    const rowI = makeRow(bizcol, totalCols, { plu: '0042', nom: 'Produit boutique', prix: 999 });
    await page.evaluate(rows => window.__opevSetRowsForTest(rows), [rowH, rowI]);

    const catalog = await page.evaluate(() => window.__opevCatalogFilteredRowsForTest());
    assert(!catalog.some(r => r.plu === '0041'), 'Scénario 4 : l\'article WooCommerce est absent du catalogue');
    assert(catalog.some(r => r.plu === '0042'), 'Scénario 4 : l\'article boutique normal reste dans le catalogue');

    // La case à cocher "étiquette" doit être désactivée sur la ligne WooCommerce dans la grille réelle.
    const checkboxState = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#bodyRows tr'));
      const result = {};
      rows.forEach(tr => {
        const firstCellText = tr.querySelector('td')?.textContent?.trim();
        const cb = tr.querySelector('.label-select-cb');
        if (firstCellText && cb) result[firstCellText] = { disabled: cb.disabled };
      });
      return result;
    });
    assert(checkboxState['0041'] && checkboxState['0041'].disabled === true, 'Scénario 4 : case à cocher étiquette désactivée pour l\'article WooCommerce');
    assert(checkboxState['0042'] && checkboxState['0042'].disabled === false, 'Scénario 4 : case à cocher étiquette active pour l\'article boutique normal');
  }

  // ---------- Scénario 5 : import Dolibarr réel — colonne "Code balance" au nom variable
  // (ex. "options_code_balance", pas l'intitulé exact) + WooCommerce via une SOUS-catégorie ----------
  {
    page.once('dialog', dialog => dialog.accept()); // alert() de fin d'import

    const productRows = [
      { 'Réf.': '0051', 'Libellé': 'Sirop web', 'Prix unitaire TTC': '9,90', 'En vente': '1', 'options_code_balance': '0300 – Regroupement sirop' },
      { 'Réf.': '0052', 'Libellé': 'Sirop shop', 'Prix unitaire TTC': '9,90', 'En vente': '1', 'options_code_balance': '' }
    ];
    const categoryListRows = [
      { 'ID du(de la) tag/catégorie': '900', 'Libellé': 'WooCommerce', 'ID du tag/catégorie parent': '', 'Libellé du tag/catégorie parent': '' },
      { 'ID du(de la) tag/catégorie': '901', 'Libellé': 'WooCommerce Sub', 'ID du tag/catégorie parent': '900', 'Libellé du tag/catégorie parent': 'WooCommerce' }
    ];
    // 0051 est tagué avec la SOUS-catégorie (901), pas directement "WooCommerce" (900) : teste
    // la détection récursive (isUnderWooCommerce). 0052 n'a aucune catégorie WooCommerce.
    const categoryRows = [
      { 'Réf.': '0051', 'ID du(de la) tag/catégorie': '901', 'Libellé': '' }
    ];

    await page.evaluate(([p, cl, c]) => window.__opevApplyDolibarrImportDataForTest(p, cl, c, 'file', []), [productRows, categoryListRows, categoryRows]);

    const rowsByPlu = await page.evaluate(() => {
      const rows = window.__opevGetRowsForTest();
      const bizcol = window.__opevBIZCOL;
      const out = {};
      rows.forEach(r => { out[(r[0]||'').trim()] = { codeBalance: r[bizcol.CODE_BALANCE], woo: r[bizcol.WOOCOMMERCE] }; });
      return out;
    });
    assertEqual(rowsByPlu['0051'].codeBalance, '0300', 'Scénario 5 : "Code balance" trouvé via une clé au nom variable (options_code_balance) et code extrait ("0300 – ..." -> "0300")');
    assertEqual(rowsByPlu['0051'].woo, '1', 'Scénario 5 : WooCommerce détecté via une SOUS-catégorie de "WooCommerce" (récursif)');
    assertEqual(rowsByPlu['0052'].codeBalance, '', 'Scénario 5 : "Code balance" vide -> pas de regroupement (chaîne vide)');
    assertEqual(rowsByPlu['0052'].woo, '0', 'Scénario 5 : article non tagué WooCommerce -> woo = "0"');

    // 5b. Aucune colonne "code"+"balance" du tout dans l'export -> avertissement clair, pas d'échec silencieux.
    let warned = false;
    page.once('dialog', dialog => { warned = /code balance/i.test(dialog.message()); dialog.accept(); });
    const productRowsNoCol = [{ 'Réf.': '0061', 'Libellé': 'Sans colonne code balance', 'Prix unitaire TTC': '1,00', 'En vente': '1' }];
    await page.evaluate(([p]) => window.__opevApplyDolibarrImportDataForTest(p, [], [], 'file', []), [productRowsNoCol]);
    assert(warned, 'Scénario 5b : avertissement clair (pas d\'échec silencieux) quand aucune colonne "Code balance" n\'existe dans l\'export');
  }

  await browser.close();

  console.log('\n' + (failures === 0 ? `TOUT OK (0 echec).` : `${failures} ECHEC(S).`));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Erreur inattendue :', err);
  process.exit(1);
});
