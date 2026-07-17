// lib/parsers/parseFacturesPiecesOuvertes.ts
//
// Parse "liste_peice.xlsx" — mais UNIQUEMENT les lignes d'en-tête de facture
// (pas le détail ligne par ligne de chaque pièce vendue, qui reste hors
// scope pour l'instant). Sert au suivi d'âge des factures pièces encore
// ouvertes ("Statut" = "Fact.ouv.", par opposition à "Fact.impr." qui est
// imprimée/finalisée).
//
// Structure par bloc dans le fichier source :
//   ligne facture : #Facture | À Compt. | Statut | Commis | #Client | Nom | ...
//   ligne "Total Pièces:" (résumé taxes)
//   [optionnel] sous-en-tête + lignes de détail par pièce vendue
// On ne garde que la première ligne de chaque bloc.

import * as XLSX from "xlsx";

export interface ParsedFacturePieceOuverte {
  factureNo: string;
  statut: string;
  estOuverte: boolean; // statut === "Fact.ouv."
  clerkId: string | null;
  clientNo: string | null;
  clientNom: string;
  total: number;
  dateOuverture: string; // YYYY-MM-DD
}

export interface ParseFacturesPiecesOuvertesResult {
  factures: ParsedFacturePieceOuverte[];
  warnings: string[];
}

function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function parseFacturesPiecesOuvertes(buffer: Buffer): Promise<ParseFacturesPiecesOuvertesResult> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const factures: ParsedFacturePieceOuverte[] = [];
  const warnings: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row[0] !== "number") continue; // saute en-têtes / lignes de détail / totaux
      const statut = row[2];
      if (typeof statut !== "string" || !/^Fact\./i.test(statut)) continue; // pas une ligne facture

      const factureNo = String(row[0]);
      const dateSerial = row[1];
      const clerkId = row[3] != null ? String(row[3]) : null;
      const clientNo = row[4] != null ? String(row[4]) : null;
      const clientNom = typeof row[5] === "string" ? row[5] : "";
      const total = typeof row[9] === "number" ? row[9] : 0;

      if (typeof dateSerial !== "number" || dateSerial <= 0) {
        warnings.push(`Facture ${factureNo} (ligne ${i + 1}) : date "À Compt." manquante ou invalide — ignorée.`);
        continue;
      }

      factures.push({
        factureNo,
        statut,
        estOuverte: /^Fact\.ouv\.?$/i.test(statut.trim()),
        clerkId,
        clientNo,
        clientNom,
        total,
        dateOuverture: excelSerialToDate(dateSerial),
      });
    }
  }

  return { factures, warnings };
}
