// lib/parsers/parseEstimeRapportVente.ts
//
// Parse "estimé_rapport_vente.xlsx" — apparie chaque estimé à la facture
// réelle qui en a résulté (le cas échéant). Colonnes reconstruites depuis
// les données réelles (l'en-tête du fichier est décalé, même symptôme que
// les autres rapports) :
//   [0]=#Estimé [1]=DateEstimé(série Excel) [2]=#Client [3]=NomClient
//   [4]=MontantEstimé [5]=#FactureRéelle(0 si non converti)
//   [6]=DateFactureRéelle(série Excel, 0 si non converti)
//   [7]=#Client(dupliqué) [8]=NomClient(dupliqué) [9]=MontantFactureRéel
//
// ⚠️ #FactureRéelle utilise une numérotation DIFFÉRENTE de celle de
// Liste_des_factures_de_pièces.xlsx (c'est la numérotation du système de
// pièces détaillé, liste_peice.xlsx) — ne pas essayer de la faire
// correspondre à parts_invoices.facture_no. Pour savoir QUI a fait
// l'estimé, on fait la jointure applicative sur #Estimé == #Facture dans
// Liste_des_factures_de_pièces.xlsx (vérifié empiriquement, ~84% de
// correspondance).

import * as XLSX from "xlsx";

export interface ParsedEstime {
  estimateNo: string;
  dateEstime: string | null; // YYYY-MM-DD
  clientNo: string | null;
  clientNom: string;
  montantEstime: number;
  factureReelleNo: string | null;
  dateFactureReelle: string | null;
  montantFactureReel: number | null;
  converti: boolean;
}

export interface ParseEstimeRapportVenteResult {
  estimes: ParsedEstime[];
  warnings: string[];
}

function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function parseEstimeRapportVente(buffer: Buffer): Promise<ParseEstimeRapportVenteResult> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const estimes: ParsedEstime[] = [];
  const warnings: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row[0] !== "number") continue; // saute les en-têtes/lignes vides

      const estimateNo = String(row[0]);
      const dateEstime = typeof row[1] === "number" && row[1] > 0 ? excelSerialToDate(row[1]) : null;
      const clientNo = row[2] != null ? String(row[2]) : null;
      const clientNom = typeof row[3] === "string" ? row[3] : "";
      const montantEstime = typeof row[4] === "number" ? row[4] : 0;

      const factureReelleNo = row[5] && row[5] !== 0 ? String(row[5]) : null;
      const dateFactureReelle = typeof row[6] === "number" && row[6] > 0 ? excelSerialToDate(row[6]) : null;
      const montantFactureReel = typeof row[9] === "number" && row[9] !== 0 ? row[9] : null;

      if (!clientNom) {
        warnings.push(`Estimé ${estimateNo} (ligne ${i + 1}) : aucun nom de client — ligne ignorée.`);
        continue;
      }

      estimes.push({
        estimateNo,
        dateEstime,
        clientNo,
        clientNom,
        montantEstime,
        factureReelleNo,
        dateFactureReelle,
        montantFactureReel,
        converti: factureReelleNo !== null,
      });
    }
  }

  return { estimes, warnings };
}
