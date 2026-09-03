// Reception, extraction et validation des programmes de booking.
//
// GET                     la file d'attente : ce qui est a valider, a relire, en erreur
// POST  (multipart)       televerse un ou plusieurs documents et les analyse
// PATCH { id, action }    'valider' promeut l'extraction en programme actif
//                         'rejeter' classe sans suite
//                         'fournisseur' corrige le rapprochement et le memorise
// DELETE ?id=             supprime une ligne d'import

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { dernierRun, lireTout } from '@/lib/supply-chain-db'
import { extraireProgramme, ProgrammeExtrait } from '@/lib/booking-extraction'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const TYPES_PDF = ['application/pdf']
const TYPES_TABLEUR = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]

/** Les noms de fournisseurs de l'ERP, pour que le modele rapproche juste. */
async function nomsFournisseurs(): Promise<string[]> {
  const run = await dernierRun()
  if (!run) return []
  const g = await lireTout<any>('sc_analyse_groupes', 'cle, valeur_stock', q =>
    q.eq('run_id', run.run_id).eq('dimension', 'fournisseur')
     .order('valeur_stock', { ascending: false }).limit(120))
  return g.map(x => x.cle)
}

/** Un tableur devient du texte : Claude lit tres bien un CSV, mal un .xlsx binaire. */
async function tableurEnTexte(data: Uint8Array, nom: string): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(data, { type: 'array' })
  const morceaux: string[] = []
  for (const feuille of wb.SheetNames.slice(0, 8)) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[feuille], { blankrows: false })
    if (!csv.trim()) continue
    // Une feuille de 8 000 lignes de references ne porte pas la grille
    // commerciale : elle la noierait. On garde de quoi la reconnaitre.
    morceaux.push(`──── Feuille « ${feuille} » ────\n${csv.slice(0, 40_000)}`)
  }
  return `Fichier ${nom}\n\n${morceaux.join('\n\n')}`
}

export async function GET(req: NextRequest) {
  try {
    const statut = req.nextUrl.searchParams.get('statut')
    const imports = await lireTout<any>('sc_booking_imports', '*', q => {
      let r = q.order('recu_le', { ascending: false, nullsFirst: false })
               .order('cree_le', { ascending: false })
      if (statut) r = r.in('statut', statut.split(','))
      return r
    })

    return NextResponse.json({
      imports,
      totaux: {
        a_valider:      imports.filter(i => i.statut === 'a_valider').length,
        lien_seulement: imports.filter(i => i.statut === 'lien_seulement').length,
        erreur:         imports.filter(i => i.statut === 'erreur').length,
        valides:        imports.filter(i => i.statut === 'valide').length,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const fichiers = form.getAll('fichiers').filter(f => f instanceof File) as File[]
    const email = String(form.get('user_email') || '') || null
    if (!fichiers.length) {
      return NextResponse.json({ erreur: 'Aucun fichier recu' }, { status: 400 })
    }

    const fournisseurs = await nomsFournisseurs()
    const resultats: any[] = []

    for (const f of fichiers) {
      const octets = new Uint8Array(await f.arrayBuffer())
      const ligne: any = {
        source: 'televerse',
        nom_fichier: f.name,
        type_fichier: f.type || null,
        taille_octets: octets.byteLength,
        recu_le: new Date().toISOString(),
        statut: 'nouveau',
        traite_par: email,
      }

      const { data: cree, error } = await supabaseAdmin
        .from('sc_booking_imports').insert(ligne).select().single()
      if (error) throw new Error(error.message)

      // Le PDF part en vision native ; un tableur passe d'abord en CSV.
      const estPdf = TYPES_PDF.includes(f.type) || /\.pdf$/i.test(f.name)
      const estTableur = TYPES_TABLEUR.includes(f.type) || /\.(xlsx|xlsm|xls|csv)$/i.test(f.name)

      let res
      if (estPdf) {
        res = await extraireProgramme({
          data: octets, mediaType: 'application/pdf', nomFichier: f.name, fournisseurs,
        })
      } else if (estTableur) {
        res = await extraireProgramme({ texte: await tableurEnTexte(octets, f.name), fournisseurs })
      } else {
        res = await extraireProgramme({
          texte: new TextDecoder().decode(octets).slice(0, 200_000), fournisseurs,
        })
      }

      const patch = versPatch(res)
      const { data: maj } = await supabaseAdmin.from('sc_booking_imports')
        .update({ ...patch, maj_le: new Date().toISOString() })
        .eq('id', cree.id).select().single()
      resultats.push(maj)
    }

    return NextResponse.json({ success: true, imports: resultats })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

/** Traduit un resultat d'extraction en colonnes de sc_booking_imports. */
function versPatch(res: Awaited<ReturnType<typeof extraireProgramme>>): any {
  if (!res.success || !res.programme) {
    return { statut: 'erreur', erreur: res.erreur || 'Extraction sans resultat', duree_ms: res.duree_ms }
  }
  const p = res.programme

  // Un document qui ne fait que pointer vers un portail concessionnaire n'a
  // pas de grille a extraire : eBiz, K-Web et DEX demandent un login. On le
  // classe a part plutot que de le compter en echec.
  if (!p.est_un_programme && p.liens_portail?.length) {
    return {
      statut: 'lien_seulement',
      extraction: p,
      liens_portail: p.liens_portail,
      modele: res.modele, duree_ms: res.duree_ms,
      commentaire: 'Le programme est derriere un portail concessionnaire : depose le fichier a la main.',
    }
  }
  if (!p.est_un_programme) {
    return {
      statut: 'rejete', extraction: p, modele: res.modele, duree_ms: res.duree_ms,
      commentaire: 'Ce document n\'est pas un programme de reservation.',
    }
  }

  return {
    statut: 'a_valider',
    extraction: p,
    confiance: p.confiance ?? null,
    incertitudes: p.incertitudes || [],
    liens_portail: p.liens_portail || [],
    fournisseur_annonce: p.fournisseur_annonce || null,
    fournisseur_traction: p.fournisseur_traction || null,
    modele: res.modele,
    duree_ms: res.duree_ms,
    erreur: null,
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, action, fournisseur_traction, corrections, user_email } = await req.json()
    if (!id || !action) return NextResponse.json({ erreur: 'id et action requis' }, { status: 400 })

    const { data: imp } = await supabaseAdmin
      .from('sc_booking_imports').select('*').eq('id', id).single()
    if (!imp) return NextResponse.json({ erreur: 'Import introuvable' }, { status: 404 })

    if (action === 'rejeter') {
      const { data } = await supabaseAdmin.from('sc_booking_imports')
        .update({ statut: 'rejete', maj_le: new Date().toISOString(), traite_par: user_email || null })
        .eq('id', id).select().single()
      return NextResponse.json({ success: true, import: data })
    }

    if (action === 'fournisseur') {
      if (!fournisseur_traction) {
        return NextResponse.json({ erreur: 'fournisseur_traction requis' }, { status: 400 })
      }
      // On retient le rapprochement : la question ne se reposera plus pour ce
      // fournisseur, quel que soit le nom qu'il se donne l'an prochain.
      const alias = String(imp.fournisseur_annonce || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
      if (alias) {
        await supabaseAdmin.from('sc_booking_alias_fournisseurs').upsert({
          alias, fournisseur_traction, origine: 'manuel', cree_par: user_email || null,
        }, { onConflict: 'alias' })
      }
      const { data } = await supabaseAdmin.from('sc_booking_imports')
        .update({ fournisseur_traction, maj_le: new Date().toISOString() })
        .eq('id', id).select().single()
      return NextResponse.json({ success: true, import: data })
    }

    if (action !== 'valider') {
      return NextResponse.json({ erreur: `action inconnue : ${action}` }, { status: 400 })
    }

    // ── La promotion en programme actif ────────────────────────────
    // `corrections` est l'extraction telle que le relecteur l'a amendee a
    // l'ecran. C'est elle qui fait foi, pas la sortie brute du modele.
    const p: ProgrammeExtrait = corrections || imp.extraction
    if (!p) return NextResponse.json({ erreur: 'Aucune extraction a promouvoir' }, { status: 400 })

    const fournisseur = fournisseur_traction || imp.fournisseur_traction || p.fournisseur_traction
    if (!fournisseur) {
      return NextResponse.json({
        erreur: 'Le fournisseur ERP n\'est pas renseigne. Rapproche-le avant de valider : ' +
                'sans lui, le programme ne trouvera aucune piece.',
      }, { status: 400 })
    }

    const { data: prog, error: e1 } = await supabaseAdmin.from('sc_booking_programmes').insert({
      nom: p.nom || 'Programme sans nom',
      fournisseur,
      saison: p.saison ?? null,
      ouvre_le: p.ouvre_le ?? null,
      ferme_le: p.ferme_le ?? null,
      livraison_debut: p.livraison_debut ?? null,
      livraison_fin: p.livraison_fin ?? null,
      couvre_debut: p.couvre_debut ?? null,
      couvre_fin: p.couvre_fin ?? null,
      perimetre_lignes: p.perimetre_lignes || [],
      perimetre_marques: p.perimetre_marques || [],
      perimetre_categories: p.perimetre_categories || [],
      exclus_codes: p.exclus_codes || [],
      min_commande: p.min_commande ?? null,
      min_reappro: p.min_reappro ?? null,
      franco_seuil: p.franco_seuil ?? null,
      retour_pct: p.retour_pct ?? null,
      baremes_exclusifs: !!p.baremes_exclusifs,
      notes: p.notes ?? null,
      source_fichier: imp.nom_fichier || imp.objet || `import #${imp.id}`,
      maj_par: user_email || null,
    }).select().single()
    if (e1) throw new Error(e1.message)

    if (p.paliers?.length) {
      const { error: e2 } = await supabaseAdmin.from('sc_booking_paliers').insert(
        p.paliers.map(pl => ({
          programme_id: prog.id,
          bareme: pl.bareme || 'global',
          axe: pl.axe || 'tout',
          cible: pl.cible || [],
          rang: pl.rang ?? 1,
          niveau: pl.niveau ?? null,
          seuil_montant: pl.seuil_montant ?? 0,
          seuil_qte: pl.seuil_qte ?? null,
          seuil_sur: pl.seuil_sur || 'groupe',
          escompte_pct: pl.escompte_pct ?? 0,
          sous_minimums: pl.sous_minimums || [],
          echeancier: pl.echeancier || [],
          franco_port: !!pl.franco_port,
          notes: pl.notes ?? null,
        })))
      if (e2) throw new Error(e2.message)
    }

    if (p.bonus?.length) {
      const { error: e3 } = await supabaseAdmin.from('sc_booking_bonus').insert(
        p.bonus.map(b => ({
          programme_id: prog.id,
          type: b.type,
          groupe: b.groupe || 'defaut',
          libelle: b.libelle || b.type,
          valeur_pct: b.valeur_pct ?? 0,
          avant_le: b.avant_le ?? null,
          jours: b.jours ?? null,
          axe: b.axe || 'tout',
          cible: b.cible || [],
          notes: b.notes ?? null,
        })))
      if (e3) throw new Error(e3.message)
    }

    const { data: maj } = await supabaseAdmin.from('sc_booking_imports').update({
      statut: 'valide',
      programme_id: prog.id,
      fournisseur_traction: fournisseur,
      extraction: p,
      maj_le: new Date().toISOString(),
      traite_par: user_email || null,
    }).eq('id', id).select().single()

    return NextResponse.json({
      success: true,
      import: maj,
      programme: prog,
      nb_paliers: p.paliers?.length || 0,
      nb_bonus: p.bonus?.length || 0,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('sc_booking_imports').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
