// lib/meca-parser-rapport-aviseur.ts
//
// Parse l'export Excel (.xlsx) du "Rapport des Aviseurs Technique -
// Détaillée". Chaque valeur vit dans sa propre cellule, le nom de l'aviseur
// est dans une seule cellule fusionnée, et les catégories (Client/Interne/
// Garantie/Total/Autre) sont indiquées par des cellules fusionnées
// explicites — zéro ambiguïté d'alignement.
//
// Résultat stocké en jsonb (voir migration) avec des clés du type
// "Client|Pièce", "Garantie|Main d'oeuvre", "Autre", etc. — directement les
// libellés du fichier source.

import * as XLSX from "xlsx";

export interface ParsedPerformanceRow {
  advisor_nom: string;
  row_label: string;
  periode_type: string;
  valeurs: Record<string, number>;
}

export interface ParseRapportAviseurResult {
  rows: ParsedPerformanceRow[];
  warnings: string[];
}

const ROW_LABEL_MAP: Record<string, string> = {
  ventes: "ventes",
  "coûts": "couts",
  couts: "couts",
  profits: "profits",
  "profit (%)": "profit_pct",
  "nb. factures": "nb_factures",
  "nb. jobs": "nb_jobs",
  "moy. jobs / factures": "moy_jobs_factures",
  "moy. $ / factures": "moy_dollar_factures",
  "nb. heures / factures": "nb_heures_factures",
  "ratio pièces / main d'oeuvre": "ratio_pieces_mo",
  "nb heures facturées": "nb_heures_facturees",
  "taux effectif": "taux_effectif",
};

const PERIOD_MAP: Record<string, string> = {
  "période": "periode",
  "mois à date": "mtd",
  "mois à date (an passée)": "mtd_an_passee",
  "année à date": "ytd",
  "année à date (an passée)": "ytd_an_passee",
};

const CATEGORY_RE = /^(Client|Interne|Garantie|Gar\.\s*Prol\.?|Total|Autre)$/i;
const SUBHEADER_RE = /^Pi[eè]ce$|^Main\s*d'?oeuvre$/i;

function normalize(s: string): string {
  return s.toString().trim().toLowerCase().replace(/\s+/g, " ");
}

export async function parseRapportAviseur(buffer: Buffer): Promise<ParseRapportAviseurResult> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const rows: ParsedPerformanceRow[] = [];
  const warnings: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const merges = ws["!merges"] ?? [];

    const cellText = (r: number, c: number): string => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell || cell.v === undefined || cell.v === null) return "";
      return String(cell.v).trim();
    };
    const cellNumber = (r: number, c: number): number | null => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell || cell.v === undefined || cell.v === null || cell.v === "") return null;
      const n = typeof cell.v === "number" ? cell.v : parseFloat(String(cell.v).replace(",", "."));
      return Number.isFinite(n) ? n : null;
    };

    // 1) Trouver la ligne d'en-tête de catégories (contient "Client"/"Interne"/etc,
    //    avec éventuellement des espaces de mise en forme autour)
    let categoryRow = -1;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        if (CATEGORY_RE.test(normalize(cellText(r, c)).replace(/^\s+/, ""))) {
          categoryRow = r;
          break;
        }
      }
      if (categoryRow >= 0) break;
    }
    if (categoryRow < 0) {
      warnings.push(`Feuille "${sheetName}" : aucune ligne d'en-tête de catégories trouvée, ignorée.`);
      continue;
    }
    const subHeaderRow = categoryRow + 1;

    // 2) Construire colCategory à partir des cellules fusionnées de la ligne de catégories
    const colCategory = new Map<number, string>();
    for (const m of merges) {
      if (m.s.r !== categoryRow) continue;
      const label = cellText(categoryRow, m.s.c).trim();
      if (!CATEGORY_RE.test(label)) continue;
      for (let c = m.s.c; c <= m.e.c; c++) colCategory.set(c, label);
    }
    // Catégories non fusionnées (une seule sous-colonne, ex: "Autre" parfois seul)
    for (let c = range.s.c; c <= range.e.c; c++) {
      const label = cellText(categoryRow, c).trim();
      if (CATEGORY_RE.test(label) && !colCategory.has(c)) colCategory.set(c, label);
    }

    // 3) Construire les colonnes de valeurs à partir de la ligne "Pièce / Main d'oeuvre"
    const valueColumns = new Map<number, string>(); // colIndex -> "Client|Pièce" etc.
    for (let c = range.s.c; c <= range.e.c; c++) {
      const sub = cellText(subHeaderRow, c);
      if (!SUBHEADER_RE.test(sub)) continue;
      const category = colCategory.get(c);
      if (!category) {
        warnings.push(`Feuille "${sheetName}", colonne ${c} : sous-en-tête "${sub}" sans catégorie associée — ignorée.`);
        continue;
      }
      const subLabel = /^Main/i.test(sub) ? "Main d'oeuvre" : "Pièce";
      valueColumns.set(c, `${category}|${subLabel}`);
    }
    if (valueColumns.size === 0) {
      warnings.push(`Feuille "${sheetName}" : aucune colonne de valeur détectée, ignorée.`);
      continue;
    }

    // 4) Détecter dynamiquement les colonnes nom / row_label / période en
    //    cherchant, sur la première ligne de données, une cellule reconnue.
    const firstDataRow = subHeaderRow + 1;
    let nameCol = -1;
    let labelCol = -1;
    let periodCol = -1;
    for (let c = range.s.c; c < Math.min(...valueColumns.keys()); c++) {
      const text = normalize(cellText(firstDataRow, c));
      if (labelCol < 0 && ROW_LABEL_MAP[text]) labelCol = c;
      if (periodCol < 0 && PERIOD_MAP[text]) periodCol = c;
    }
    // Le nom d'aviseur est typiquement la première colonne non vide avant labelCol
    for (let c = range.s.c; c < labelCol; c++) {
      if (cellText(firstDataRow, c)) {
        nameCol = c;
        break;
      }
    }
    if (periodCol < 0) {
      // Repli : chercher la période sur les lignes suivantes si absente de la première
      for (let r = firstDataRow; r <= Math.min(firstDataRow + 5, range.e.r); r++) {
        for (let c = range.s.c; c < Math.min(...valueColumns.keys()); c++) {
          const text = normalize(cellText(r, c));
          if (PERIOD_MAP[text]) {
            periodCol = c;
            break;
          }
        }
        if (periodCol >= 0) break;
      }
    }
    if (labelCol < 0 || periodCol < 0) {
      warnings.push(`Feuille "${sheetName}" : impossible de localiser les colonnes row_label/période — feuille ignorée.`);
      continue;
    }

    // 5) Parcourir les lignes de données. Les cellules fusionnées verticalement
    //    (nom, row_label) ne contiennent une valeur QUE sur leur première ligne :
    //    on la porte en avant (carry-forward) tant qu'aucune nouvelle valeur
    //    n'apparaît.
    let currentAdvisorNom = "";
    let currentRowLabel = "";
    for (let r = firstDataRow; r <= range.e.r; r++) {
      const nameText = nameCol >= 0 ? cellText(r, nameCol) : "";
      if (nameText) currentAdvisorNom = nameText;

      const labelTextRaw = cellText(r, labelCol);
      if (labelTextRaw) {
        const mapped = ROW_LABEL_MAP[normalize(labelTextRaw)];
        if (mapped) {
          currentRowLabel = mapped;
        } else {
          warnings.push(`Feuille "${sheetName}", ligne ${r + 1} : row_label "${labelTextRaw}" non reconnu.`);
        }
      }

      const periodTextRaw = cellText(r, periodCol);
      if (!periodTextRaw) continue; // ligne vide / footer
      const periodMapped = PERIOD_MAP[normalize(periodTextRaw)];
      if (!periodMapped) continue; // ligne de pied de page ou autre texte, pas une ligne de données

      if (!currentAdvisorNom || !currentRowLabel) {
        warnings.push(`Feuille "${sheetName}", ligne ${r + 1} : période trouvée sans nom d'aviseur/row_label connu — ignorée.`);
        continue;
      }

      const valeurs: Record<string, number> = {};
      for (const [c, label] of valueColumns) {
        const n = cellNumber(r, c);
        if (n !== null) valeurs[label] = n;
      }
      if (Object.keys(valeurs).length === 0) continue; // période sans aucune donnée (normal, ex: MTD vide)

      rows.push({
        advisor_nom: currentAdvisorNom,
        row_label: currentRowLabel,
        periode_type: periodMapped,
        valeurs,
      });
    }
  }

  return { rows, warnings };
}
