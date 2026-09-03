// Releve booking@mathiasms.com et depose les programmes trouves en file de
// validation.
//
// GET   cron quotidien, ou appel manuel depuis l'ecran
//         ?depuis=AAAA/MM/JJ   rattraper l'historique depuis une date
//         ?max=N               plafond de messages traites (defaut 15)
//         ?test=1              diagnostic seul : verifie l'acces, ne traite rien
//         ?relancer=1          rejoue les extractions en echec deja enregistrees
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
  telechargerPiece, marquerTraite, requeteRecherche, diagnostiquerCle, MessageBooking,
} from '@/lib/gmail-booking'
import { pannePassagere } from '@/lib/ia-gateway'
import { etatFournisseurs } from '@/lib/claude'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * De quoi reconnaitre ce qui a ete colle, sans jamais divulguer la cle. Ces
 * trois indices suffisent a diagnostiquer les quatre accidents de copier-coller.
 */
function formeCle(brut: string | undefined) {
  if (!brut) return null
  const t = brut.trim()
  return {
    longueur: t.length,
    commence_par: t.slice(0, 28),
    finit_par: t.slice(-26),
    contient_begin: t.includes('-----BEGIN'),
    contient_end: t.includes('-----END'),
    // Un PEM valide a des sauts de ligne REELS. S'il n'a que des \n
    // echappes, c'est normal — le code les convertit. S'il n'a ni l'un ni
    // l'autre, la cle est sur une seule ligne et il faut la recouper.
    sauts_de_ligne_reels: t.split('\n').length - 1,
    sauts_de_ligne_echappes: t.split('\\n').length - 1,
    // Sans le drapeau /s, indisponible sur la cible de compilation du projet :
    // [\s\S] traverse les sauts de ligne aussi bien que le point.
    guillemets_englobants: /^["'][\s\S]*["']$/.test(t),
    ressemble_a_du_json: t.startsWith('{'),
  }
}

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
  // Rejouer les extractions en echec, sans repasser par la recherche Gmail.
  const relancer = p.get('relancer') === '1'

  // La forme de la cle se verifie AVANT de tenter quoi que ce soit : une cle
  // malformee fait echouer la signature sur un message OpenSSL opaque
  // (« DECODER routines::unsupported ») qui ne dit pas ce qui cloche.
  // On ne renvoie jamais la cle, seulement ce qui lui manque.
  const soucisCle = diagnostiquerCle(process.env.GMAIL_SA_PRIVATE_KEY)
  if (soucisCle) {
    return NextResponse.json({
      erreur: `La cle privee est mal formee. ${soucisCle}`,
      ou: 'Vercel > Settings > Environment Variables > GMAIL_SA_PRIVATE_KEY, ' +
          'puis redeploie pour que la nouvelle valeur soit prise en compte.',
      forme_lue: formeCle(process.env.GMAIL_SA_PRIVATE_KEY),
    }, { status: 409 })
  }

  try {
    const jeton = await jetonAcces(cfg)

    // Le diagnostic : verifie l'acces sans rien consommer. C'est le premier
    // appel a faire apres avoir branche les cles.
    if (test) {
      const requete = requeteRecherche(depuis)
      const trouves = await listerMessages(cfg, jeton, requete, 10)
      // Verifier l'acces Gmail sans verifier l'acces a Claude, c'est valider
      // la moitie du tuyau : c'est exactement ce qui a laisse croire que tout
      // etait pret alors que l'extraction ne pouvait pas tourner.
      const ia = etatFournisseurs()
      const accesIA = ia.pret
        ? `Claude joignable par : ${ia.ordre.join(', puis ')}.`
        : "ATTENTION — aucun acces a Claude n'est configure : l'extraction ne pourra pas " +
          "tourner. Ajoute ANTHROPIC_API_KEY (facturation Anthropic) ou AI_GATEWAY_API_KEY " +
          "(facturation Vercel) dans Vercel, puis redeploie."

      return NextResponse.json({
        success: true,
        boite: cfg.boite,
        compte_de_service: cfg.email,
        acces: 'ok',
        ia,
        requete,
        nb_messages_en_attente: trouves.length,
        message: `Acces a ${cfg.boite} confirme. ${trouves.length} message(s) correspondent ` +
                 `a la recherche et ne sont pas encore traites. ${accesIA}`,
      })
    }

    const idLibelle = await idLibelleTraite(cfg, jeton)
    const fournisseurs = await nomsFournisseurs()

    // ── Relance des echecs deja enregistres ───────────────────────
    // Un message etiquete « traite » dans Gmail ne ressort plus de la
    // recherche. Sans ce mode, un incident d'environnement — un solde de
    // credits a zero, par exemple — rendrait ses documents definitivement
    // inaccessibles alors qu'ils n'ont jamais ete lus. On repart donc des
    // lignes en erreur et on retelecharge la piece jointe par son id Gmail.
    if (relancer) {
      const enErreur = await lireTout<any>('sc_booking_imports',
        'id, gmail_message_id, nom_fichier, erreur',
        q => q.eq('statut', 'erreur').not('gmail_message_id', 'is', null)
              .order('id', { ascending: true }))

      const journal: any[] = []
      // Un meme courriel peut porter plusieurs documents en echec : on ne le
      // telecharge qu'une fois.
      const parMessage = new Map<string, any[]>()
      for (const l of enErreur.slice(0, max * 3)) {
        parMessage.set(l.gmail_message_id, [...(parMessage.get(l.gmail_message_id) || []), l])
      }

      for (const [idMsg, lignes] of parMessage) {
        try {
          const msg = await lireMessage(cfg, jeton, idMsg)
          const contexte = `De : ${msg.expediteur}\nObjet : ${msg.objet}\nRecu le : ${msg.recuLe.slice(0, 10)}`

          for (const l of lignes) {
            const pj = l.nom_fichier
              ? msg.pieces.find(x => x.nomFichier === l.nom_fichier)
              : null

            let res
            if (pj) {
              const octets = await telechargerPiece(cfg, jeton, idMsg, pj.attachmentId)
              res = EXT_PDF.test(pj.nomFichier)
                ? await extraireProgramme({ data: octets, mediaType: 'application/pdf',
                    nomFichier: pj.nomFichier, fournisseurs, contexte })
                : await extraireProgramme({
                    texte: await tableurEnTexte(octets, pj.nomFichier), fournisseurs, contexte })
            } else if (msg.corps.trim().length >= 200) {
              res = await extraireProgramme({ texte: msg.corps, fournisseurs, contexte })
            } else {
              journal.push({ id: l.id, statut: 'inchange',
                note: 'Ni piece jointe retrouvee ni corps exploitable.' })
              continue
            }

            const patch = versPatch(res, msg)
            const { data } = await supabaseAdmin.from('sc_booking_imports')
              .update({ ...patch, maj_le: new Date().toISOString() })
              .eq('id', l.id).select().single()
            journal.push({
              id: l.id, nom_fichier: l.nom_fichier, statut: data?.statut,
              erreur: data?.erreur || undefined,
              nb_paliers: data?.extraction?.paliers?.length ?? 0,
              incertitudes: (data?.incertitudes || []).length,
            })
          }
        } catch (e: any) {
          journal.push({ gmail_message_id: idMsg, statut: 'erreur', erreur: e?.message })
        }
      }

      const panne = journal.find(j => pannePassagere(j.erreur))?.erreur
      return NextResponse.json({
        success: true,
        mode: 'relance',
        nb_repris: journal.length,
        a_valider: journal.filter(j => j.statut === 'a_valider').length,
        nb_erreurs: journal.filter(j => j.statut === 'erreur').length,
        panne: panne || null,
        panne_message: panne
          ? `L'extraction echoue toujours : ${panne}`
          : null,
        journal,
      })
    }

    const aTraiter = await listerMessages(cfg, jeton, requeteRecherche(depuis), max)

    const journal: any[] = []
    for (const { id } of aTraiter) {
      let msg: MessageBooking | null = null
      try {
        msg = await lireMessage(cfg, jeton, id)
        const lignes = await traiterMessage(cfg, jeton, msg, fournisseurs)
        journal.push(...lignes)

        // On n'etiquette pas un message dont un document a bute sur une panne
        // passagere : il doit rester en vue pour la prochaine releve. Les
        // documents deja extraits ne seront pas dupliques — l'index unique
        // (gmail_message_id, nom_fichier) s'en charge.
        const rejouable = lignes.some(l => pannePassagere(l.erreur))
        if (rejouable) {
          journal.push({ gmail_message_id: id, statut: 'a_rejouer',
            note: 'Message laisse non etiquete : l\'extraction n\'a pas pu tourner.' })
        } else {
          await marquerTraite(cfg, jeton, id, idLibelle)
        }
      } catch (e: any) {
        const erreur = e?.message || String(e)
        await supabaseAdmin.from('sc_booking_imports').insert({
          source: 'courriel',
          gmail_message_id: id,
          expediteur: msg?.expediteur ?? null,
          objet: msg?.objet ?? null,
          recu_le: msg?.recuLe ?? new Date().toISOString(),
          statut: 'erreur',
          erreur,
        })
        // Meme regle qu'au-dessus. Un message qui a bute sur un document
        // illisible est etiquete : sinon le cron rebute dessus tous les jours
        // et n'avance jamais. Mais un message tombe sur une panne d'environnement
        // reste en vue, sans quoi une coupure de service viderait la boite de
        // ses programmes sans que rien n'ait ete lu.
        if (!pannePassagere(erreur)) {
          try { await marquerTraite(cfg, jeton, id, idLibelle) } catch { /* deja signale */ }
        }
        journal.push({ gmail_message_id: id, statut: 'erreur', erreur })
      }
    }

    // Quand toute la releve echoue sur la meme panne, le dire UNE fois et en
    // clair vaut mieux que vingt-trois lignes identiques a l'ecran.
    const panne = journal.find(j => pannePassagere(j.erreur))?.erreur
    const nbErreurs = journal.filter(j => j.statut === 'erreur').length

    return NextResponse.json({
      success: true,
      boite: cfg.boite,
      nb_messages: aTraiter.length,
      nb_documents: journal.length,
      a_valider: journal.filter(j => j.statut === 'a_valider').length,
      nb_erreurs: nbErreurs,
      nb_a_rejouer: journal.filter(j => j.statut === 'a_rejouer').length,
      panne: panne || null,
      panne_message: panne
        ? `L'extraction n'a pas pu tourner : ${panne} — les messages concernes n'ont PAS ete ` +
          `etiquetes dans Gmail, relance la releve quand ce sera regle.`
        : null,
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
    erreur: data.erreur || undefined,
    fournisseur: data.fournisseur_traction || data.fournisseur_annonce,
    nb_paliers: data.extraction?.paliers?.length ?? 0,
    incertitudes: (data.incertitudes || []).length,
  }
}
