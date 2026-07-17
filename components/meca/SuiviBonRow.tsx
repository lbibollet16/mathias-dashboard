'use client'

// Une ligne de bon de travail avec son suivi.
//
// En mode éditable (onglet Aviseur) : statut, date planifiée et note se
// modifient sur place et s'enregistrent tout seuls (le statut et la date au
// changement, la note après une courte pause de frappe).
// En lecture seule (drill-down directeur) : le suivi s'affiche sans contrôles.

import { useEffect, useRef, useState } from 'react'
import { Theme, Badge, fmtArgent } from './MecaUI'
import { SUIVI_STATUTS, tonStatut } from '@/lib/meca-suivi'

function couleurTon(ton: ReturnType<typeof tonStatut>, C: Theme['C'], sub: string) {
  return ton === 'red' ? C.red : ton === 'yellow' ? C.yellow
       : ton === 'blue' ? C.blue : ton === 'green' ? C.green : sub
}

export default function SuiviBonRow({ bon, editable, moiNom, onSaved, ...t }:
  { bon: any, editable?: boolean, moiNom?: string, onSaved?: () => void } & Theme) {
  const [statut, setStatut] = useState<string>(bon.suiviStatut ?? '')
  const [date, setDate]     = useState<string>(bon.suiviDatePlanifiee ?? '')
  const [note, setNote]     = useState<string>(bon.suiviNote ?? '')
  const [etat, setEtat]     = useState<'' | 'saving' | 'saved' | 'err'>('')

  // Resynchronise si le parent recharge (ex. après un import).
  useEffect(() => {
    setStatut(bon.suiviStatut ?? ''); setDate(bon.suiviDatePlanifiee ?? ''); setNote(bon.suiviNote ?? '')
  }, [bon.suiviStatut, bon.suiviDatePlanifiee, bon.suiviNote])

  const enregistrer = async (patch: { statut?: string, datePlanifiee?: string, note?: string }) => {
    setEtat('saving')
    try {
      const r = await fetch('/api/meca/work-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          factureNo: bon.factureNo ?? bon.facture_no,
          suivi: {
            statut:        patch.statut        ?? statut,
            datePlanifiee: patch.datePlanifiee ?? date,
            note:          patch.note          ?? note,
          },
          par: moiNom,
        }),
      })
      const j = await r.json()
      if (j.erreur) { setEtat('err'); return }
      setEtat('saved')
      onSaved?.()
      setTimeout(() => setEtat(''), 1500)
    } catch { setEtat('err') }
  }

  // La note est débouncée pour ne pas enregistrer à chaque caractère.
  const noteTimer = useRef<any>(null)
  const onNote = (v: string) => {
    setNote(v)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => enregistrer({ note: v }), 700)
  }

  const ageJours = bon.ageJours ?? 0
  const facture = bon.factureNo ?? bon.facture_no
  const client = bon.clientNom ?? bon.client_nom ?? ''
  const valeur = bon.valeur ?? 0
  const enRetard = ageJours > 30
  const ton = tonStatut(statut)
  const colStatut = couleurTon(ton, t.C, t.sub)

  const inputStyle: any = {
    padding: '4px 6px', borderRadius: 6, border: `1px solid ${t.bdr}`,
    fontSize: 12, background: t.card, color: 'inherit',
  }
  const tdNum: any = { padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12.5, whiteSpace: 'nowrap' }

  return (
    <tr style={{
      borderBottom: `1px solid ${t.bdr}`,
      background: bon.signale ? (t.dark ? '#2a1512' : '#fdecea') : undefined,
      verticalAlign: 'top',
    }}>
      <td style={{ padding: '8px 10px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
        {facture}
        {bon.signale && (
          <span title="Non fermé depuis 2 imports ou plus"
            style={{ marginLeft: 6, display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: t.C.red }} />
        )}
      </td>
      <td style={{ padding: '8px 10px' }}>{client}</td>
      <td style={{ ...tdNum, fontFamily: undefined, fontWeight: enRetard ? 700 : 400, color: enRetard ? t.C.red : undefined }}>
        {ageJours} j
      </td>
      <td style={tdNum}>{fmtArgent(valeur)}</td>
      <td style={{ padding: '8px 10px', minWidth: 320 }}>
        {editable ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={statut}
                onChange={e => { setStatut(e.target.value); enregistrer({ statut: e.target.value }) }}
                style={{
                  ...inputStyle,
                  fontWeight: 600,
                  color: statut ? colStatut : t.sub,
                  borderColor: statut ? colStatut : t.bdr,
                }}
              >
                <option value="">— suivi —</option>
                {SUIVI_STATUTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <label style={{ fontSize: 11, color: t.sub }}>Planifié&nbsp;:</label>
              <input
                type="date"
                value={date}
                onChange={e => { setDate(e.target.value); enregistrer({ datePlanifiee: e.target.value }) }}
                style={inputStyle}
              />
              <span style={{ fontSize: 11, color: etat === 'err' ? t.C.red : etat === 'saved' ? t.C.green : t.sub, minWidth: 56 }}>
                {etat === 'saving' ? '…' : etat === 'saved' ? '✓ enregistré' : etat === 'err' ? '⚠️ erreur' : ''}
              </span>
            </div>
            <input
              type="text"
              value={note}
              placeholder="Note (ex. attend roulement, commande LAUTOPAK…)"
              onChange={e => onNote(e.target.value)}
              onBlur={() => { if (noteTimer.current) { clearTimeout(noteTimer.current); enregistrer({ note }) } }}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {statut ? <Badge t={t} couleur={colStatut}>{statut}</Badge> : <span style={{ color: t.sub, fontSize: 12 }}>—</span>}
              {date && <span style={{ fontSize: 12, color: t.sub }}>📅 {date}</span>}
            </div>
            {note && <span style={{ fontSize: 12, color: t.dark ? '#cfd2d6' : '#3c4043' }}>{note}</span>}
            {bon.suiviPar && <span style={{ fontSize: 10.5, color: t.sub }}>maj : {bon.suiviPar}</span>}
          </div>
        )}
      </td>
    </tr>
  )
}
