// lib/parsers/parseRapportVentePiece.ts
//
// Parse "rapport_vente_piece.xlsx" — ventes de pièces par commis, par client.
//
// ⚠️ L'en-tête de ce fichier est décalé/corrompu (même symptôme que les
// anciens rapports PDF mécanique) : la ligne d'en-tête annonce "Date | Coût
// des | $ | % | Nb | #Client | Nom | ..." mais les valeurs réelles des
// lignes de données ne correspondent PAS à cet ordre. Plutôt que de suivre
// l'en-tête, le mapping de colonnes ci-dessous a été RECONSTRUIT et VALIDÉ
// par cohérence arithmétique sur un vrai fichier :
//   ventes - coût = profit          (colonne C - colonne D = colonne E)
//   profit / ventes * 100 = profit% (colonne E / colonne C * 100 = colonne F)
//   ventes / nb_factures = moyenne  (colonne C / colonne G = colonne H)
//   profit * 1% = commission        (colonne E * 0.01 = colonne I)
// Ces quatre identités tombaient exactement juste sur l'échantillon
// disponible — si un futur fichier ne vérifie plus ces identités (à peu de
// centimes près), c'est le signal que le format a changé et qu'il faut
// recalibrer.

import * as XLSX from "xlsx";

export interface ParsedVenteCommis {
  clerkId: string;
  clerkNom: string;
  clientNo: string | null;
  clientNom: string;
  ventes: number;
  cout: number;
  profit: number;
  profitPct: number | null;
  nbFactures: number;
  moyenneFacture: number | null;
  commission: number | null;
  estTotalCommis: boolean; // ligne "Total Commis :" plutôt qu'une ligne client
}

export interface ParseRapportVentePieceResult {
  ventes: ParsedVenteCommis[];
  warnings: string[];
}

function toNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export async function parseRapportVentePiece(buffer: Buffer): Promise<ParseRapportVentePieceResult> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const ventes: ParsedVenteCommis[] = [];
  const warnings: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    let currentClerkId: string | null = null;
    let currentClerkNom: string | null = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const a = row[0];

      // "Commis : NN Nom, Prénom"
      if (typeof a === "string" && a.startsWith("Commis :")) {
        const m = a.match(/Commis\s*:\s*(\d+)\s+(.+)$/);
        if (m) {
          currentClerkId = m[1];
          currentClerkNom = m[2].trim();
        } else {
          warnings.push(`Ligne "Commis :" non reconnue : "${a}"`);
        }
        continue;
      }

      // Ligne d'en-tête ou "Département(s)" -> ignorée
      if (typeof a === "string" && (a === "Date" || a.startsWith("Département"))) continue;

      // Ligne "Total Commis :" — résumé du commis courant
      if (typeof a === "string" && a.startsWith("Total Commis")) {
        if (!currentClerkId) {
          warnings.push(`Ligne "Total Commis :" rencontrée sans commis courant connu (ligne ${i + 1}).`);
          continue;
        }
        const ventesVal = toNum(row[1]);
        const coutVal = toNum(row[2]);
        const profitVal = toNum(row[3]);
        const profitPctVal = toNum(row[4]);
        const nbFacturesVal = toNum(row[5]);
        const moyenneVal = toNum(row[6]);
        const commissionVal = toNum(row[7]);
        if (ventesVal === null) continue;
        ventes.push({
          clerkId: currentClerkId,
          clerkNom: currentClerkNom ?? `Commis #${currentClerkId}`,
          clientNo: null,
          clientNom: "Total",
          ventes: ventesVal,
          cout: coutVal ?? 0,
          profit: profitVal ?? 0,
          profitPct: profitPctVal,
          nbFactures: nbFacturesVal ?? 0,
          moyenneFacture: moyenneVal,
          commission: commissionVal,
          estTotalCommis: true,
        });
        continue;
      }

      // Ligne client normale : A=#Client, B=Nom, C=Ventes, D=Coût, E=Profit,
      // F=Profit%, G=NbFactures, H=Moyenne, I=Commission
      if (typeof a === "number" && currentClerkId) {
        const clientNo = String(a);
        const clientNom = typeof row[1] === "string" ? row[1] : "";
        const ventesVal = toNum(row[2]);
        const coutVal = toNum(row[3]);
        const profitVal = toNum(row[4]);
        const profitPctVal = toNum(row[5]);
        const nbFacturesVal = toNum(row[6]);
        const moyenneVal = toNum(row[7]);
        const commissionVal = toNum(row[8]);

        if (ventesVal === null) {
          warnings.push(`Ligne client sans montant de ventes reconnu (ligne ${i + 1}) — ignorée.`);
          continue;
        }

        // Vérification de cohérence — si l'identité ventes-coût=profit ne
        // tient plus (à 0.05$ près), le format a peut-être changé.
        if (coutVal !== null && profitVal !== null) {
          const attendu = Math.round((ventesVal - coutVal) * 100) / 100;
          if (Math.abs(attendu - profitVal) > 0.05) {
            warnings.push(
              `Ligne ${i + 1} (client ${clientNo}) : ventes-coût (${attendu}) ne correspond pas au profit lu (${profitVal}) — mapping de colonnes à valider pour ce fichier.`
            );
          }
        }

        ventes.push({
          clerkId: currentClerkId,
          clerkNom: currentClerkNom ?? `Commis #${currentClerkId}`,
          clientNo,
          clientNom,
          ventes: ventesVal,
          cout: coutVal ?? 0,
          profit: profitVal ?? 0,
          profitPct: profitPctVal,
          nbFactures: nbFacturesVal ?? 0,
          moyenneFacture: moyenneVal,
          commission: commissionVal,
          estTotalCommis: false,
        });
      }
    }
  }

  return { ventes, warnings };
}
