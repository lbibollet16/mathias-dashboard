import { supabaseAdmin } from '@/lib/supabase'

// Journalise un changement de suivi (statut/note) dans suivi_historique.
// N'insère une entrée que si quelque chose a réellement changé, pour ne pas
// polluer l'historique quand un enregistrement re-sauve une valeur identique.
// L'entrée ne porte que le(s) champ(s) modifié(s).
export async function loggerSuivi(
  domaine: 'meca' | 'pieces',
  factureNo: string,
  o: { oldStatut: string | null, oldNote: string | null, newStatut: string | null, newNote: string | null, par: string | null }
) {
  const statutChange = (o.oldStatut || null) !== (o.newStatut || null)
  const noteChange   = (o.oldNote   || null) !== (o.newNote   || null)
  if (!statutChange && !noteChange) return
  const { error } = await supabaseAdmin.from('suivi_historique').insert({
    domaine,
    facture_no: factureNo,
    statut: statutChange ? (o.newStatut || null) : null,
    note:   noteChange   ? (o.newNote   || null) : null,
    par:    o.par,
  })
  // On ne fait pas échouer la sauvegarde du suivi si le journal échoue.
  if (error) console.error('[suivi-historique] insert échoué :', error.message)
}
