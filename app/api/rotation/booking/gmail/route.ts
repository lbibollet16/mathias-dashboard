// Releve booking@mathiasms.com et depose les programmes trouves en file de
// validation.
//
// GET   cron quotidien, ou appel manuel depuis l'ecran
//         ?depuis=AAAA/MM/JJ   rattraper l'historique depuis une date
//         ?max=N               plafond de messages traites (defaut 15)
//         ?test=1              diagnostic seul : verifie l'acces, ne traite rien
//
// Chaque message analyse recoit le libelle « Booking traite » dans Gmail, et
// son id est unique en base : ni le cron ni un rattrapage ne peuvent creer un
// doublon.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { dernierRun, lireTout } from '@/lib/supply-chain-db'
import { extraireProgramme } from '@/lib/booking-extraction'
import {
  lireConfigGmail, jetonAcces, idLibelleTraite, listerMessages, lireMessage,
  telechargerPiece, marquerTraite, requeteRecherche, MessageBooking,
} from '@/lib/gmail-booking'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const EXT_PDF = /\.pdf$/i
const EXT_TABLEUR = /\.(xlsx|xlsm|xls|csv)$/i

async function nomsFournisseurs(): Promise<string[]> {
  const run = await dernierRun()
  if (!run) return []
  const g = await lireTout<any>('sc_analyse_groupes', 'cle, valeur_stock', q =>
    q.eq('run_id', run.run_id).eq('dimension', 'fournisseur')
     .order('valeur_stock', { ascending: false }).limit(120))
  return g.map(x => x.cle)
}

async function tableurEnTexte(data: Uint8Array, nom: string): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(data, { type: 'array' })
  const morceaux: string[] = []
  for (const feuille of wb.SheetNames.slice(0, 8)) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[feuille], { blankrows: false })
    if (csv.trim()) morceaux.push(`──── Feuille « ${feuille} » ────\n${csv.slice(0, 40_000)}`)
  }
  return `Fichier ${nom}\n\n${morceaux.join('\n\n')}`
}

export async function GET(req: NextRequest) {
  const cfg = lireConfigGmail()
  if (!cfg) {
    return NextResponse.json({
      erreur: 'Gmail n\'est pas configure.',
      manque: ['GMAIL_SA_EMAIL', 'GMAIL_SA_PRIVATE_KEY'].filter(k => !process.env[k]),
      aide: 'Ajoute ces variables dans Vercel > Settings > Environment Variables, ' +
            'puis redeploie. GMAIL_SA_PRIVATE_KEY est le champ private_key du fichier JSON ' +
            'du compte de service, colle tel quel.',
    }, { status: 409 })
  }

  const p = req.nextUrl.searchParams
  const depuis = p.get('depuis') || undefined
  const max = Math.min(60, Math.max(1, parseInt(p.get('max') || '15', 10)))
  const test = p.get('test') === '1'

  try {
    const jeton = await jetonAcces(cfg)

    // Le diagnostic : verifie l'acces sans rien consommer. C'est le premier
    // appel a faire apres avoir branche les cles.
    if (test) {
      const requete = requeteRecherche(depuis)
      const trouves = await listerMessages(cfg, jeton, requete, 10)
      return NextResponse.json({
        success: true,
        boite: cfg.boite,
        acces: 'ok',
        requete,
        nb_messages_en_attente: trouves.length,
        message: `Acces a ${cfg.boite} confirme. ${trouves.length} message(s) correspondent ` +
                 `a la recherche et ne sont pas encore traites.`,
      })
    }

    const idLibelle = await idLibelleTraite(cfg, jeton)
    const fournisseurs = await nomsFournisseurs()
    const aTraiter = await listerMessages(cfg, jeton, requeteRecherche(depuis), max)

    const journal: any[] = []
    for (const { id } of aTraiter) {
      let msg: MessageBooking | null = null
      try {
        msg = await lireMessage(cfg, jeton, id)
        journal.push(...await traiterMessage(cfg, jeton, msg, fournisseurs))
        await marquerTraite(cfg, jeton, id, idLibelle)
      } catch (e: any) {
        // Un message qui echoue est journalise et marque quand meme : sinon le
        // cron rebutera dessus tous les jours et n'avancera jamais.
        await supabaseAdmin.from('sc_booking_imports').insert({
          source: 'courriel',
          gmail_message_id: id,
          expediteur: msg?.expediteur ?? null,
          objet: msg?.objet ?? null,
          recu_le: msg?.recuLe ?? new Date().toISOString(),
          statut: 'erreur',
          erreur: e?.message || String(e),
        })
        try { await marquerTraite(cfg, jeton, id, idLibelle) } catch { /* deja signale */ }
        journal.push({ gmail_message_id: id, statut: 'erreur', erreur: e?.message })
      }
    }

    return NextResponse.json({
      success: true,
      boite: cfg.boite,
      nb_messages: aTraiter.length,
      nb_documents: journal.length,
      a_valider: journal.filter(j => j.statut === 'a_valider').length,
      journal,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

/**
 * Un message peut porter plusieurs programmes (Polaris envoie ses quatre
 * programmes mensuels en un seul courriel), ou aucun — juste un lien vers un
 * portail. Chaque piece jointe fait donc sa propre ligne d'import.
 */
async function traiterMessage(
  cfg: ReturnType<typeof lireConfigGmail> & object,
  jeton: string,
  msg: MessageBooking,
  fournisseurs: string[],
): Promise<any[]> {
  const commun = {
    source: 'courriel' as const,
    gmail_message_id: msg.id,
    gmail_thread_id: msg.threadId,
    expediteur: msg.expediteur,
    destinataire: msg.destinataire,
    objet: msg.objet,
    recu_le: msg.recuLe,
  }
  const contexte = `De : ${msg.expediteur}\nObjet : ${msg.objet}\nRecu le : ${msg.recuLe.slice(0, 10)}`
  const resultats: any[] = []

  const analysables = msg.pieces.filter(
    pj => EXT_PDF.test(pj.nomFichier) || EXT_TABLEUR.test(pj.nomFichier))

  for (const pj of analysables) {
    // Une piece jointe de plus de 30 Mo n'est pas un programme : c'est un
    // catalogue ou un fichier de references.
    if (pj.taille > 30_000_000) {
      resultats.push(await enregistrer({
        ...commun, nom_fichier: pj.nomFichier, type_fichier: pj.mimeType,
        taille_octets: pj.taille, statut: 'rejete',
        commentaire: 'Piece jointe trop volumineuse pour etre un programme (probablement un catalogue).',
      }))
      continue
    }

    const octets = await telechargerPiece(cfg as any, jeton, msg.id, pj.attachmentId)
    const res = EXT_PDF.test(pj.nomFichier)
      ? await extraireProgramme({
          data: octets, mediaType: 'application/pdf',
          nomFichier: pj.nomFichier, fournisseurs, contexte,
        })
      : await extraireProgramme({
          texte: await tableurEnTexte(octets, pj.nomFichier), fournisseurs, contexte,
        })

    resultats.push(await enregistrer({
      ...commun,
      nom_fichier: pj.nomFichier,
      type_fichier: pj.mimeType,
      taille_octets: pj.taille,
      corps_texte: msg.corps.slice(0, 20_000),
      ...versPatch(res, msg),
    }))
  }

  // Pas de piece jointe exploitable : le programme est peut-etre dans le corps
  // du message. Mercury arrive exactement comme ca.
  if (analysables.length === 0) {
    if (msg.corps.trim().length < 200) {
      resultats.push(await enregistrer({
        ...commun, statut: msg.liens.length ? 'lien_seulement' : 'rejete',
        liens_portail: msg.liens,
        corps_texte: msg.corps,
        commentaire: msg.liens.length
          ? 'Courriel sans piece jointe : le programme est derriere un portail concessionnaire.'
          : 'Courriel sans piece jointe ni contenu exploitable.',
      }))
    } else {
      const res = await extraireProgramme({ texte: msg.corps, fournisseurs, contexte })
      resultats.push(await enregistrer({
        ...commun,
        nom_fichier: null,
        type_fichier: 'message/rfc822',
        corps_texte: msg.corps.slice(0, 20_000),
        ...versPatch(res, msg),
      }))
    }
  }

  return resultats
}

function versPatch(res: Awaited<ReturnType<typeof extraireProgramme>>, msg: MessageBooking): any {
  if (!res.success || !res.programme) {
    return { statut: 'erreur', erreur: res.erreur || 'Extraction sans resultat', duree_ms: res.duree_ms }
  }
  const p = res.programme
  const liens = [...new Set([...(p.liens_portail || []), ...msg.liens])]

  if (!p.est_un_programme) {
    return liens.length
      ? {
          statut: 'lien_seulement', extraction: p, liens_portail: liens,
          modele: res.modele, duree_ms: res.duree_ms,
          commentaire: 'Le programme est derriere un portail concessionnaire : depose le fichier a la main.',
        }
      : {
          statut: 'rejete', extraction: p, modele: res.modele, duree_ms: res.duree_ms,
          commentaire: 'Ce document n\'est pas un programme de reservation.',
        }
  }

  return {
    statut: 'a_valider',
    extraction: p,
    confiance: p.confiance ?? null,
    incertitudes: p.incertitudes || [],
    liens_portail: liens,
    fournisseur_annonce: p.fournisseur_annonce || null,
    fournisseur_traction: p.fournisseur_traction || null,
    modele: res.modele,
    duree_ms: res.duree_ms,
  }
}

/**
 * L'insertion tolere le doublon : l'index unique (gmail_message_id,
 * nom_fichier) garantit qu'un rattrapage d'historique ne recree rien.
 */
async function enregistrer(ligne: any): Promise<any> {
  const { data, error } = await supabaseAdmin
    .from('sc_booking_imports').insert(ligne).select().single()
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      return { gmail_message_id: ligne.gmail_message_id, nom_fichier: ligne.nom_fichier, statut: 'deja_traite' }
    }
    throw new Error(error.message)
  }
  return {
    id: data.id,
    nom_fichier: data.nom_fichier,
    statut: data.statut,
    fournisseur: data.fournisseur_traction || data.fournisseur_annonce,
    nb_paliers: data.extraction?.paliers?.length ?? 0,
    incertitudes: (data.incertitudes || []).length,
  }
}
