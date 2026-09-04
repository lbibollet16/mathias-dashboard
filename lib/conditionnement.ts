/**
 * Le conditionnement d'achat : combien d'unites de l'ERP dans un contenant.
 *
 * POURQUOI
 * Traction compte certains articles dans leur unite de VENTE, pas dans leur
 * unite d'ACHAT. L'huile Mercury « OIL 4CYCLE 55GL » vaut 7,84 $ l'unite et
 * s'est vendue 846 fois en douze mois : l'unite est le litre, et le stock est
 * fractionnaire (79,07). On achete pourtant des futs de 55 gallons, soit
 * 208 litres.
 *
 * Le moteur de booking proposait donc « 783 » pour ce qui devrait s'ecrire
 * « 4 futs ». Le MONTANT etait juste — 783 litres, c'est 3,76 futs — mais la
 * quantite etait inutilisable telle quelle sur un bon de commande.
 *
 * PRUDENCE
 * Une detection fausse fait arrondir a un multiple errone. L'erreur reste
 * petite — au pire un contenant de trop — mais on ne devine que sur des
 * motifs sans ambiguite, et toute detection est enregistree pour qu'un humain
 * puisse la corriger une fois pour toutes.
 */

const LITRES_PAR_GALLON_US = 3.785411784

export interface Conditionnement {
  /** Unites de l'ERP contenues dans un contenant d'achat. */
  unites: number
  /** Ce qu'on commande : « fut de 208 L », « caisse de 12 ». */
  libelle: string
  /** Sur quel motif la detection s'appuie, pour pouvoir la contester. */
  motif: string
}

/**
 * Reconnait un conditionnement dans le libelle d'une piece.
 *
 * On ne retient que les contenants assez gros pour que l'unite de l'ERP soit
 * forcement une sous-unite. Un « 4L » peut aussi bien designer un bidon vendu
 * a l'unite : on ne s'en mele pas.
 */
export function detecterConditionnement(description: string | null | undefined): Conditionnement | null {
  const d = String(description || '').toUpperCase()
  if (!d) return null

  // « 12X1L », « 4X4L » : une caisse de N contenants. L'unite de l'ERP est le
  // contenant, le conditionnement est la caisse.
  const caisse = d.match(/\b(\d{1,2})\s*X\s*(\d{1,3}(?:[.,]\d+)?)\s*L\b/)
  if (caisse) {
    const n = Number(caisse[1])
    if (n >= 2 && n <= 48) {
      return {
        unites: n,
        libelle: `caisse de ${n} × ${caisse[2].replace(',', '.')} L`,
        motif: `« ${caisse[0]} » dans le libelle`,
      }
    }
  }

  // « 55GL », « 55 GAL » : un fut en gallons. En deca de 20 gallons on ne
  // presume rien — un bidon de 5 gallons se vend souvent tel quel.
  const gallons = d.match(/\b(\d{2,3})\s*(?:GL|GAL|GALLON)S?\b/)
  if (gallons) {
    const g = Number(gallons[1])
    if (g >= 20 && g <= 300) {
      const litres = Math.round(g * LITRES_PAR_GALLON_US * 10) / 10
      return {
        unites: litres,
        libelle: `fut de ${g} gallons (${litres} L)`,
        motif: `« ${gallons[0]} » dans le libelle`,
      }
    }
  }

  // « 208.2L », « 205L » : un fut annonce directement en litres.
  //
  // Ce motif est le plus dangereux des trois, pour deux raisons apprises sur
  // les vraies descriptions du catalogue :
  //
  //   « 10W40 3.78L SYNT »        la fin d'un nombre decimal se lisait
  //                               « 78 L ». D'ou le refus d'un chiffre, d'un
  //                               point ou d'une virgule juste avant.
  //   « CHAINE 520ERT3-120L »     120 MAILLONS, pas 120 litres. Un « L » colle
  //                               a un nombre ne veut pas dire litre.
  //
  // On exige donc que le libelle parle d'un fluide. Les gallons n'ont pas
  // besoin de cette precaution : au-dela de vingt gallons, c'est un liquide.
  const FLUIDE = /HUILE|OIL|LUBE|FLUID|ANTIFREEZE|ANTIGEL|COOLANT|GREASE|GRAISSE|KPO/
  if (FLUIDE.test(d)) {
    const litres = d.match(/(?<![\d.,])(\d{2,4}(?:[.,]\d)?)\s*L\b/)
    if (litres) {
      const v = Number(litres[1].replace(',', '.'))
      if (v >= 50 && v <= 1200) {
        return {
          unites: v,
          libelle: `fut de ${v} L`,
          motif: `« ${litres[0]} » dans le libelle, avec mention d'un fluide`,
        }
      }
    }
  }

  return null
}

/**
 * Arrondit une quantite au contenant superieur.
 *
 * Toujours vers le HAUT : commander 3,8 futs n'existe pas, et descendre a 3
 * laisserait la periode a decouvert — ce que le calcul de besoin cherchait
 * precisement a eviter.
 */
export function arrondirAuContenant(qte: number, c: Conditionnement | null): {
  qte: number; contenants: number
} {
  if (!c || c.unites <= 1 || qte <= 0) return { qte, contenants: 0 }
  const contenants = Math.max(1, Math.ceil(qte / c.unites - 1e-9))
  return { qte: Math.round(contenants * c.unites * 100) / 100, contenants }
}
