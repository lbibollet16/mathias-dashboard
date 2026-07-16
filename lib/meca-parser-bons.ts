// lib/meca-parser-bons.ts
//
// Parse l'export Excel (.xlsx) de la "Liste des Bons de Travail Ouverts".
// Chaque bon de travail tient sur une seule ligne (montants Garantie/
// Interne/Gar.Prol./Client inclus dans les mêmes colonnes) — pas de ligne
// séparée à recoller, pas d'ambiguïté #Série/#Stock.
//
// ⚠️ Ce fichier ne contient PAS le nom de l'aviseur (pas de colonne dédiée),
// seulement son numéro (colonne "# Aviseur", ex: "20/20"). Si aucun aviseur
// n'existe encore en base avec cet id, le nom restera "Aviseur #<id>" —
// importe d'abord le rapport aviseur (qui donne les noms), ou corrige
// manuellement dans l'onglet Aviseur Technique.

import * as XLSX from "xlsx";

export interface ParsedWorkOrder {
  facture_no: string;
  advisor_id: string;
  statut: string;
  client_no: string;
  client_nom: string;
  no_serie: string | null;
  no_stock: string | null;
  date_ouverture: string; // YYYY-MM-DD
  age_jours_source: number;
  montants: Record<string, number>;
}

export interface ParseBonsDeTravailResult {
  workOrders: ParsedWorkOrder[];
  warnings: string[];
}

const EXPECTED_HEADERS = ["# Facture", "Dépt", "Ouverture", "Client", "Statut", "#Client", "Nom", "# Aviseur", "Âge"];

const AMOUNT_LABEL_KEYS: { re: RegExp; key: string }[] = [
  { re: /^Total\s*Garantie\s*:?$/i, key: "Garantie" },
  { re: /^Interne\s*:?$/i, key: "Interne" },
  { re: /^Gar\.?\s*Prol\.?\s*:?$/i, key: "Gar.Prol." },
  { re: /^Client\s*:?$/i, key: "Client" },
];

/** Convertit un numéro de série Excel (jours depuis 1899-12-30) en YYYY-MM-DD. */
function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000); // 25569 = jours entre 1899-12-30 et 1970-01-01
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function parseBonsDeTravail(buffer: Buffer): Promise<ParseBonsDeTravailResult> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const workOrders: ParsedWorkOrder[] = [];
  const warnings: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);

    const cell = (r: number, c: number) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      return ws[addr];
    };
    const cellText = (r: number, c: number): string => {
      const cl = cell(r, c);
      return cl && cl.v !== undefined && cl.v !== null ? String(cl.v).trim() : "";
    };
    const cellNum = (r: number, c: number): number | null => {
      const cl = cell(r, c);
      if (!cl || cl.v === undefined || cl.v === null || cl.v === "") return null;
      const n = typeof cl.v === "number" ? cl.v : parseFloat(String(cl.v).replace(",", "."));
      return Number.isFinite(n) ? n : null;
    };

    // Vérifier que la première ligne ressemble bien aux en-têtes attendus
    const headerRowText = Array.from({ length: 11 }, (_, i) => cellText(range.s.r, range.s.c + i));
    const looksRight = EXPECTED_HEADERS.every((h) => headerRowText.some((t) => t.replace(/\s/g, "") === h.replace(/\s/g, "")));
    if (!looksRight) {
      warnings.push(`Feuille "${sheetName}" : en-têtes inattendus, ignorée (attendu: ${EXPECTED_HEADERS.join(", ")}).`);
      continue;
    }

    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const factureRaw = cellText(r, 0);
      if (!factureRaw || factureRaw === "Sous-Total") continue; // ligne vide ou sous-total, on ignore
      if (!/^\d+$/.test(factureRaw)) continue; // sécurité : pas un vrai numéro de facture

      const dateSerial = cellNum(r, 2); // colonne C = Ouverture
      if (dateSerial === null) {
        warnings.push(`Bon ${factureRaw} (ligne ${r + 1}) : date d'ouverture manquante ou invalide — ignoré.`);
        continue;
      }

      const aviseurRaw = cellText(r, 9); // colonne J = # Aviseur, ex "20/20"
      const advisorId = aviseurRaw.split("/")[0]?.trim();
      if (!advisorId) {
        warnings.push(`Bon ${factureRaw} (ligne ${r + 1}) : numéro d'aviseur manquant — ignoré.`);
        continue;
      }

      // Montants : colonnes L à S, labels et valeurs alternés sur la MÊME ligne
      const montants: Record<string, number> = {};
      for (let c = 11; c <= Math.min(range.e.c, 18); c++) {
        const labelText = cellText(r, c);
        const match = AMOUNT_LABEL_KEYS.find((a) => a.re.test(labelText));
        if (match) {
          const val = cellNum(r, c + 1);
          if (val !== null) montants[match.key] = val;
        }
      }

      workOrders.push({
        facture_no: factureRaw,
        advisor_id: advisorId,
        statut: cellText(r, 4), // E
        client_no: cellText(r, 5), // F
        client_nom: cellText(r, 6), // G
        no_serie: cellText(r, 7) || null, // H
        no_stock: cellText(r, 8) || null, // I
        date_ouverture: excelSerialToDate(dateSerial),
        age_jours_source: cellNum(r, 10) ?? 0, // K
        montants,
      });
    }
  }

  return { workOrders, warnings };
}
