/**
 * Un seul endroit pour demander a Claude un JSON structure, avec deux chemins
 * d'acces et une bascule automatique entre eux.
 *
 * POURQUOI DEUX CHEMINS
 * Le 3 septembre 2026, la premiere releve de booking@mathiasms.com a echoue
 * sur ses 23 documents en quelques secondes : le solde du Vercel AI Gateway
 * etait a zero. Aucun appel n'etait parti. Un unique intermediaire, c'est un
 * unique point de rupture — et il rompt sans prevenir, un dimanche soir, la
 * veille de la date limite d'un booking.
 *
 * On appelle donc :
 *   1. l'API Anthropic en direct, si ANTHROPIC_API_KEY existe
 *   2. le Vercel AI Gateway, si AI_GATEWAY_API_KEY existe
 * dans cet ordre par defaut, et l'echec de l'un fait essayer l'autre — mais
 * seulement quand l'echec vient du SERVICE. Un PDF chiffre echouera pareil
 * des deux cotes : le rejouer serait payer deux fois pour la meme reponse.
 *
 * L'ordre s'inverse avec IA_FOURNISSEUR_PREFERE=gateway.
 */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { generateText, Output } from 'ai'
import type { z } from 'zod'
import { messageErreurIA, pannePassagere } from '@/lib/ia-gateway'

/**
 * Le meme modele des deux cotes, pour que la bascule ne change pas la qualite
 * de lecture. Le gateway prefixe le nom du fournisseur, l'API directe non —
 * et le separateur de version differe aussi (`4-5` contre `4.5`).
 *
 * Deux niveaux, parce que toutes les lectures ne se valent pas. Le rapport
 * « Liste commande » de Traction est un tableau a colonnes fixes, toujours la
 * meme mise en page : Haiku le lit tres bien pour une fraction du prix, et ce
 * choix etait delibere dans le code d'origine. On le respecte plutot que de
 * gonfler la facture par effet de bord d'un changement de plomberie.
 *
 * Les programmes de booking, eux, valent Opus : 132 paliers sur 22 baremes,
 * des seuils tantot en dollars tantot en unites, et des dates calendaires a
 * convertir en jours.
 */
export const MODELES = {
  opus:  { direct: 'claude-opus-5',  gateway: 'anthropic/claude-opus-5' },
  haiku: { direct: 'claude-haiku-4-5', gateway: 'anthropic/claude-haiku-4.5' },
} as const

export type NiveauModele = keyof typeof MODELES

export type Fournisseur = 'anthropic' | 'gateway'

export interface DemandeJSON<T extends z.ZodTypeAny> {
  system: string
  /** La consigne, et le texte a analyser quand il n'y a pas de PDF. */
  consigne: string
  schema: T
  /** Un PDF a lire en vision native. La mise en page compte souvent autant que le texte. */
  pdf?: { data: Uint8Array; nomFichier?: string }
  /**
   * Une grille dense produit un gros JSON — 132 paliers chez Parts Canada.
   * Trop serrer tronque l'extraction en plein tableau.
   */
  maxTokens?: number
  /**
   * `opus` par defaut. `haiku` pour une mise en page reguliere et connue,
   * ou la capacite de raisonnement n'apporte rien.
   */
  niveau?: NiveauModele
}

export interface ResultatJSON<T> {
  success: boolean
  objet?: T
  /** Qui a repondu. Utile quand on cherche pourquoi une lecture differe. */
  fournisseur?: Fournisseur
  modele?: string
  duree_ms: number
  erreur?: string
  /** L'echec vient-il du service et non du document ? */
  panne_service?: boolean
  /** Ce qui a ete tente et pourquoi ca n'a pas marche, dans l'ordre. */
  tentatives?: { fournisseur: Fournisseur; erreur: string }[]
}

function fournisseursDisponibles(): Fournisseur[] {
  const ordre: Fournisseur[] = process.env.IA_FOURNISSEUR_PREFERE === 'gateway'
    ? ['gateway', 'anthropic']
    : ['anthropic', 'gateway']

  return ordre.filter(f =>
    f === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.AI_GATEWAY_API_KEY)
}

/** Ce qui est configure, pour l'afficher a l'ecran sans reveler les cles. */
export function etatFournisseurs() {
  const dispo = fournisseursDisponibles()
  return {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    gateway: !!process.env.AI_GATEWAY_API_KEY,
    ordre: dispo,
    pret: dispo.length > 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// L'API Anthropic en direct
// ═══════════════════════════════════════════════════════════════════════

async function viaAnthropic<T extends z.ZodTypeAny>(d: DemandeJSON<T>): Promise<z.infer<T>> {
  const client = new Anthropic()
  const modele = MODELES[d.niveau || 'opus'].direct

  const contenu: Anthropic.ContentBlockParam[] = []
  if (d.pdf) {
    // Le base64 ne doit contenir aucun saut de ligne, et le document se place
    // AVANT le texte : c'est ce que la doc de l'API demande.
    contenu.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from(d.pdf.data).toString('base64'),
      },
    })
  }
  contenu.push({ type: 'text', text: d.consigne })

  const reponse = await client.messages.parse({
    model: modele,
    max_tokens: d.maxTokens ?? 24000,
    system: d.system,
    messages: [{ role: 'user', content: contenu }],
    output_config: { format: zodOutputFormat(d.schema as any) },
  })

  // Les classificateurs de surete peuvent decliner : le refus arrive en 200,
  // avec un contenu vide. Sans ce controle on lirait `parsed_output` a null
  // et on conclurait a un document illisible.
  if (reponse.stop_reason === 'refusal') {
    throw new Error(
      `Claude a refuse de traiter ce document (${reponse.stop_details?.category ?? 'sans categorie'}).`)
  }
  if (reponse.stop_reason === 'max_tokens') {
    throw new Error(
      `La reponse a ete tronquee au plafond de ${d.maxTokens ?? 24000} jetons : le document ` +
      `contient probablement une grille plus grosse que prevu.`)
  }
  if (!reponse.parsed_output) {
    throw new Error('Claude a repondu mais la sortie ne respecte pas le schema attendu.')
  }
  return reponse.parsed_output as z.infer<T>
}

// ═══════════════════════════════════════════════════════════════════════
// Le Vercel AI Gateway
// ═══════════════════════════════════════════════════════════════════════

async function viaGateway<T extends z.ZodTypeAny>(d: DemandeJSON<T>): Promise<z.infer<T>> {
  const contenu: any[] = []
  if (d.pdf) {
    // Le SDK `ai` veut un Uint8Array pur, pas un Buffer Node.
    const src = d.pdf.data
    const ab = new ArrayBuffer(src.byteLength)
    const copie = new Uint8Array(ab)
    copie.set(src)
    contenu.push({
      type: 'file',
      mediaType: 'application/pdf',
      data: copie,
      filename: d.pdf.nomFichier || 'document.pdf',
    })
  }
  contenu.push({ type: 'text', text: d.consigne })

  const r = await generateText({
    model: MODELES[d.niveau || 'opus'].gateway,
    system: d.system,
    messages: [{ role: 'user', content: contenu }],
    output: Output.object({ schema: d.schema as any }),
    maxOutputTokens: d.maxTokens ?? 24000,
    temperature: 0,
  })
  return r.output as z.infer<T>
}

// ═══════════════════════════════════════════════════════════════════════
// La bascule
// ═══════════════════════════════════════════════════════════════════════

export async function extraireJSON<T extends z.ZodTypeAny>(
  d: DemandeJSON<T>,
): Promise<ResultatJSON<z.infer<T>>> {
  const t0 = Date.now()
  const dispo = fournisseursDisponibles()

  if (dispo.length === 0) {
    return {
      success: false,
      duree_ms: 0,
      panne_service: true,
      erreur: 'Aucun acces a Claude n\'est configure. Ajoute ANTHROPIC_API_KEY (facturation ' +
              'Anthropic, console.anthropic.com) ou AI_GATEWAY_API_KEY (facturation Vercel) ' +
              'dans Vercel > Settings > Environment Variables, puis redeploie.',
    }
  }

  const tentatives: { fournisseur: Fournisseur; erreur: string }[] = []

  for (const f of dispo) {
    try {
      const objet = f === 'anthropic' ? await viaAnthropic(d) : await viaGateway(d)
      const m = MODELES[d.niveau || 'opus']
      return {
        success: true,
        objet,
        fournisseur: f,
        modele: f === 'anthropic' ? m.direct : m.gateway,
        duree_ms: Date.now() - t0,
        tentatives: tentatives.length ? tentatives : undefined,
      }
    } catch (e: any) {
      const brut = e?.message || String(e)
      tentatives.push({ fournisseur: f, erreur: messageErreurIA(brut) })

      // Un echec qui vient du DOCUMENT donnera le meme resultat en face :
      // basculer serait payer deux fois pour la meme reponse. On s'arrete.
      if (!pannePassagere(brut)) {
        return {
          success: false,
          duree_ms: Date.now() - t0,
          erreur: messageErreurIA(brut),
          panne_service: false,
          tentatives,
        }
      }
      // Sinon on laisse la boucle essayer le suivant.
    }
  }

  // Tous les chemins ont bute sur une panne de service.
  const dernier = tentatives[tentatives.length - 1]
  return {
    success: false,
    duree_ms: Date.now() - t0,
    panne_service: true,
    erreur: tentatives.length > 1
      ? `Les ${tentatives.length} acces a Claude ont echoue. ` +
        tentatives.map(t => `${t.fournisseur} : ${t.erreur}`).join(' | ')
      : dernier?.erreur || 'Appel a Claude sans reponse.',
    tentatives,
  }
}
