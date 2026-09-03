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
import { messageErreurIA, pannePassagere, type Fournisseur } from '@/lib/ia-gateway'

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

export type { Fournisseur } from '@/lib/ia-gateway'

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
    f === 'anthropic'
      ? !!nettoyerCleApi(process.env.ANTHROPIC_API_KEY)
      : !!process.env.AI_GATEWAY_API_KEY)
}

/** Ce qui est configure, pour l'afficher a l'ecran sans reveler les cles. */
export function etatFournisseurs() {
  const dispo = fournisseursDisponibles()
  return {
    anthropic: !!nettoyerCleApi(process.env.ANTHROPIC_API_KEY),
    gateway: !!process.env.AI_GATEWAY_API_KEY,
    ordre: dispo,
    pret: dispo.length > 0,
    // Ce qui cloche dans la cle Anthropic, s'il y a lieu. Affiche par le
    // diagnostic « Verifier l'acces » : mieux vaut le savoir avant de lancer
    // une releve que de le decouvrir sur soixante-dix-huit echecs.
    souci_anthropic: process.env.ANTHROPIC_API_KEY
      ? diagnostiquerCleApi(process.env.ANTHROPIC_API_KEY)
      : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// L'API Anthropic en direct
// ═══════════════════════════════════════════════════════════════════════

/**
 * La cle, debarrassee de ce qui se colle avec elle.
 *
 * Meme lecon que la cle privee Gmail : une valeur copiee depuis un site ou un
 * gestionnaire de mots de passe arrive avec des guillemets, une espace, ou un
 * retour a la ligne. Le SDK les envoie tels quels dans l'entete, Anthropic
 * repond 401, et le message parle de cle « invalide » sans dire qu'elle est
 * seulement mal emballee.
 */
export function nettoyerCleApi(brut: string | undefined): string | undefined {
  if (!brut) return undefined
  let k = brut.trim()
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim()
  }
  // Une cle d'API n'a ni espace ni saut de ligne a l'interieur.
  return k.replace(/\s+/g, '')
}

/** Ce qui cloche dans la cle, sans jamais la reveler. */
export function diagnostiquerCleApi(brut: string | undefined): string | null {
  const k = nettoyerCleApi(brut)
  if (!k) return 'ANTHROPIC_API_KEY est absente.'
  if (!k.startsWith('sk-ant-')) {
    return `ANTHROPIC_API_KEY ne commence pas par « sk-ant- » (elle commence par ` +
           `« ${k.slice(0, 7)} »). Ce n'est probablement pas une cle d'API Anthropic — ` +
           `verifie que tu n'as pas colle un identifiant d'organisation ou une cle d'un autre service.`
  }
  if (k.length < 40) {
    return `ANTHROPIC_API_KEY ne fait que ${k.length} caracteres : elle a ete tronquee au collage.`
  }
  return null
}

async function viaAnthropic<T extends z.ZodTypeAny>(d: DemandeJSON<T>): Promise<z.infer<T>> {
  const souci = diagnostiquerCleApi(process.env.ANTHROPIC_API_KEY)
  if (souci) throw new Error(souci)

  // On passe la cle explicitement plutot que de laisser le SDK lire l'env :
  // c'est le seul moyen de lui donner la version nettoyee.
  const client = new Anthropic({ apiKey: nettoyerCleApi(process.env.ANTHROPIC_API_KEY) })
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

  // EN STREAMING, TOUJOURS.
  //
  // Le SDK refuse un appel non streame des que `max_tokens` laisse presager
  // plus de dix minutes : « Streaming is required for operations that may take
  // longer than 10 minutes ». C'est exactement ce qui a fait echouer les 23
  // premiers documents cote Anthropic. On pourrait baisser le plafond sous le
  // seuil, mais il faudrait le deviner, et une grosse grille serait tronquee.
  // Streamer leve la contrainte sans rien sacrifier.
  const flux = client.messages.stream({
    model: modele,
    max_tokens: d.maxTokens ?? 24000,
    system: d.system,
    messages: [{ role: 'user', content: contenu }],
    output_config: { format: zodOutputFormat(d.schema as any) },
  })
  const reponse = await flux.finalMessage()

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
  // `finalMessage()` rend un Message brut, pas le `parsed_output` du helper
  // `parse()`. La sortie structuree garantit un JSON conforme au schema : on
  // le lit dans les blocs de texte, en ecartant les blocs de raisonnement.
  const texte = reponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()

  if (!texte) {
    throw new Error('Claude a repondu sans contenu textuel exploitable.')
  }

  let brut: unknown
  try {
    brut = JSON.parse(texte)
  } catch {
    throw new Error('La reponse de Claude n\'est pas du JSON valide malgre la sortie structuree.')
  }

  const verif = d.schema.safeParse(brut)
  if (!verif.success) {
    // On dit QUEL champ cloche : « la sortie ne respecte pas le schema » tout
    // court ne mene nulle part quand le schema fait 40 champs imbriques.
    const premier = verif.error.issues[0]
    throw new Error(
      `La sortie ne respecte pas le schema attendu : ${premier?.path?.join('.') || '(racine)'} — ` +
      `${premier?.message || 'motif inconnu'}.`)
  }
  return verif.data as z.infer<T>
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
      // Nommer le fournisseur : sans lui, la traduction envoie corriger la
      // cle de l'autre chemin — c'est exactement ce qui s'est passe.
      tentatives.push({ fournisseur: f, erreur: messageErreurIA(brut, f) })

      // Un echec qui vient du DOCUMENT donnera le meme resultat en face :
      // basculer serait payer deux fois pour la meme reponse. On s'arrete.
      if (!pannePassagere(brut)) {
        return {
          success: false,
          duree_ms: Date.now() - t0,
          erreur: messageErreurIA(brut, f),
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
