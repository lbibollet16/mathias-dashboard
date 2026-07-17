// lib/parsers/parseListeFacturesPieces.ts
//
// Parse "Liste_des_factures_de_pièces.xlsx" — une ligne par facture, propre
// et sans ambiguïté : #Facture | Client ("id: nom") | Total pièces | Ouverture
// (date + heure, format "16/07/2026 15h48") | Employé ("id: nom").
//
// C'est aussi le point de jonction avec les estimés : #Facture ici == #Estimé
// dans estimé_rapport_vente.xlsx (vérifié empiriquement : ~84% de
// correspondance directe sur un échantillon réel).

import * as XLSX from "xlsx";

export interface ParsedFacturePiece {
  factureNo: string;
  clientNo: string | null;
  clientNom: string;
  totalPieces: number;
  dateOuverture: string; // ISO
  clerkId: string | null;
  clerkNom: string;
}

export interface ParseListeFacturesPiecesResult {
  factures: ParsedFacturePiece[];
  warnings: string[];
}

/** "259263: Sylvain Roy" -> { id: "259263", nom: "Sylvain Roy" } */
function splitIdNom(s: string | null): { id: string | null; nom: string } {
  if (!s) return { id: null, nom: "" };
  const m = String(s).match(/^(\d+)\s*:\s*(.+)$/);
  if (!m) return { id: null, nom: String(s).trim() };
  return { id: m[1], nom: m[2].trim() };
}

/** "16/07/2026 15h48" -> "2026-07-16T15:48:00" */
function parseDateHeure(s: string): string | null {
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2})h(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  return `${yyyy}-${mm}-${dd}T${hh.padStart(2, "0")}:${min}:00`;
}

export async function parseListeFacturesPieces(buffer: Buffer): Promise<ParseListeFacturesPiecesResult> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const factures: ParsedFacturePiece[] = [];
  const warnings: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row[0] == null) continue;

      const factureNo = String(row[0]);
      const client = splitIdNom(row[1]);
      const total = typeof row[2] === "number" ? row[2] : parseFloat(row[2] ?? "0");
      const dateIso = typeof row[3] === "string" ? parseDateHeure(row[3]) : null;
      const clerk = splitIdNom(row[4]);

      if (!dateIso) {
        warnings.push(`Facture ${factureNo} (ligne ${i + 1}) : date d'ouverture non reconnue ("${row[3]}") — ignorée.`);
        continue;
      }

      factures.push({
        factureNo,
        clientNo: client.id,
        clientNom: client.nom,
        totalPieces: Number.isFinite(total) ? total : 0,
        dateOuverture: dateIso,
        clerkId: clerk.id,
        clerkNom: clerk.nom,
      });
    }
  }

  return { factures, warnings };
}
