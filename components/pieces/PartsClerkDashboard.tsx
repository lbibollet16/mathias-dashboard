'use client'

// Détail d'un commis pièces : KPI, taux de closing, ses factures pièces
// ouvertes (avec suivi editable comme les bons méca), et ses ventes sous le
// seuil de marge avec justificatif (obligatoire >= 500 $, sinon recommandé).

import { useEffect, useState, useCallback } from 'react'
import { Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Th, Badge, fmtArgent, fmtArgentCourt } from '@/components/meca/MecaUI'
import SuiviBonRow from '@/components/meca/SuiviBonRow'

export default function PartsClerkDashboard({ clerkId, onClose, suiviEditable = false, moiNom, ...t }:
  { clerkId: string, onClose?: () => void, suiviEditable?: boolean, moiNom?: string } & Theme) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [textes, setTextes] = useState<Record<string, string>>({})
  const [enregistre, setEnregistre] = useState<string | null>(null)
  const [boMap, setBoMap] = useState<Record<string, any[]>>({})

  useEffect(() => {
    let annule = false
    fetch('/api/bo-alerts').then(r => r.json())
      .then(j => { if (!annule && j.alerts) setBoMap(j.alerts) })
      .catch(() => {})
    return () => { annule = true }
  }, [])

  const charger = useCallback(async (silencieux = false) => {
    if (!silencieux) setLoading(true)
    setErreur(null)
    try {
      const r = await fetch(`/api/pieces/commis-summary?id=${encodeURIComponent(clerkId)}`)
      const j = await r.json()
      if (j.erreur) setErreur(j.erreur); else setData(j)
    } catch (e: any) { setErreur(String(e)) }
    finally { setLoading(false) }
  }, [clerkId])

  useEffect(() => { charger() }, [charger])

  async function enregistrerJustificatif(venteId: string) {
    const texte = (textes[venteId] ?? '').trim()
    if (texte.length < 5) return
    setEnregistre(venteId)
    const r = await fetch('/api/pieces/justificatif', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ venteId, texte }),
    })
    const j = await r.json()
    setEnregistre(null)
    if (j.erreur) setErreur(j.erreur); else charger(true)
  }

  if (loading) return <Carte t={t}><span style={{ color: t.sub, fontSize: 14 }}>⏳ Chargement…</span></Carte>
  if (erreur)  return <Carte t={t}><span style={{ color: t.C.red, fontSize: 14 }}>Erreur : {erreur}</span></Carte>
  if (!data)   return null

  const fo = data.facturesOuvertes
  const nbBoPieces = (fo.liste ?? []).reduce((s: number, f: any) => s + (boMap[String(f.factureNo)]?.length ?? 0), 0)
  const nbBoFactures = (fo.liste ?? []).filter((f: any) => (boMap[String(f.factureNo)]?.length ?? 0) > 0).length

  return (
    <Carte t={t} style={{ display: 'flex', flexDirection: 'column', gap: 16, background: t.dark ? '#141414' : '#fafbfc' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: t.C.blue, margin: 0 }}>{data.clerk.nom}</h2>
          <p style={{ fontSize: 12.5, color: t.sub, margin: '2px 0 0' }}>#{data.clerk.id}</p>
        </div>
        {onClose && (
          <button onClick={onClose} style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${t.bdr}`, background: t.card, fontSize: 12.5, color: t.sub, cursor: 'pointer' }}>Fermer</button>
        )}
      </div>

      <GrilleKpi min={160}>
        <KpiCard t={t} label="Ventes" value={fmtArgentCourt(data.kpi.ventesTotal)} />
        <KpiCard t={t} label="Profit %" value={data.kpi.profitPct !== null ? `${data.kpi.profitPct.toFixed(1)} %` : '—'} />
        <KpiCard t={t} label="Nb factures" value={String(data.kpi.nbFactures)} />
        <KpiCard t={t} label="Sous 25% marge" value={String(data.kpi.ventesSousSeuilCount)} warn={data.kpi.ventesSousSeuilCount > 0} />
        <KpiCard t={t} label="Justif. manquants" value={String(data.kpi.justificatifsManquants)} warn={data.kpi.justificatifsManquants > 0} />
        <KpiCard t={t} label="Taux de closing" value={data.closing.tauxClosing !== null ? `${data.closing.tauxClosing.toFixed(1)} %` : '—'} />
        <KpiCard t={t} label="Ouvertes +15 j" value={String(fo.plus15j)} warn={fo.plus15j > 0} />
        <KpiCard t={t} label="Urgent +20 j" value={String(fo.plus20jUrgent)} warn={fo.plus20jUrgent > 0} />
      </GrilleKpi>

      {nbBoPieces > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: t.C.red, background: `${t.C.red}14`, border: `1px solid ${t.C.red}` }}>
          🔁 {nbBoPieces} pièce(s) en back-order sur {nbBoFactures} de tes factures ouvertes — voir le détail ci-dessous.
        </div>
      )}

      {data.closing.nbEstimes > 0 && (
        <p style={{ fontSize: 12, color: t.sub, margin: 0 }}>
          {data.closing.nbConvertis} estimé(s) converti(s) sur {data.closing.nbEstimes} au total.
        </p>
      )}

      {fo.total > 0 && (
        <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
          <div style={{ padding: '14px 16px 10px' }}>
            <SectionTitre
              t={t}
              titre={`Factures pièces ouvertes (${fo.total})`}
              aide={suiviEditable ? 'Renseigne le suivi de chaque facture ouverte. Enregistré automatiquement.' : undefined}
            />
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
                <Th t={t} align="left">#Facture</Th>
                <Th t={t} align="left">Client</Th>
                <Th t={t}>Âge</Th>
                <Th t={t}>Total</Th>
                <Th t={t} align="left">Suivi</Th>
              </tr>
            </thead>
            <tbody>
              {fo.liste.map((f: any) => (
                <SuiviBonRow
                  key={f.factureNo}
                  {...t}
                  bon={{ ...f, valeur: f.total, boAlerts: boMap[String(f.factureNo)] }}
                  editable={suiviEditable}
                  moiNom={moiNom}
                  endpoint="/api/pieces/open-invoices"
                  masquerDate
                  onSaved={() => charger(true)}
                />
              ))}
            </tbody>
          </table>
        </Carte>
      )}

      <Carte t={t}>
        <SectionTitre t={t} titre="Ventes sous 25 % de marge" aide="Justificatif obligatoire pour les ventes de 500 $ et plus, recommandé en dessous." />
        {data.ventesSousSeuil.length === 0 && <p style={{ fontSize: 13, color: t.sub, marginTop: 12 }}>Aucune vente sous le seuil de marge pour la période.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
          {data.ventesSousSeuil.map((v: any) => {
            const col = v.justificatifTexte ? t.bdr : v.justificatifRequis ? t.C.red : t.C.yellow
            return (
              <div key={v.id} style={{
                border: `1px solid ${col}`, borderRadius: 8, padding: 12,
                background: v.justificatifTexte ? 'transparent' : `${col}0f`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{v.clientNom}</span>
                  <span style={{ fontSize: 12, fontFamily: 'monospace', color: t.sub }}>
                    Ventes {fmtArgentCourt(v.ventes)} · Profit {v.profitPct?.toFixed(1)} %
                  </span>
                  {!v.justificatifTexte && (
                    <Badge t={t} couleur={v.justificatifRequis ? t.C.red : t.C.yellow}>
                      {v.justificatifRequis ? 'Obligatoire' : 'Recommandé'}
                    </Badge>
                  )}
                </div>
                {v.justificatifTexte ? (
                  <p style={{ fontSize: 12.5, color: t.sub, fontStyle: 'italic', margin: 0 }}>« {v.justificatifTexte} »</p>
                ) : suiviEditable ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      placeholder="Raison de la marge (ex: prix compétitif client flotte, pièce en solde…)"
                      value={textes[v.id] ?? ''}
                      onChange={e => setTextes(p => ({ ...p, [v.id]: e.target.value }))}
                      style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: `1px solid ${t.bdr}`, fontSize: 12.5, background: t.card, color: 'inherit' }}
                    />
                    <button
                      onClick={() => enregistrerJustificatif(v.id)}
                      disabled={(textes[v.id] ?? '').trim().length < 5 || enregistre === v.id}
                      style={{
                        padding: '6px 14px', borderRadius: 6, border: `1px solid ${t.C.blue}`,
                        background: t.C.blue, color: '#fff', fontSize: 12.5, fontWeight: 600,
                        cursor: 'pointer', opacity: (textes[v.id] ?? '').trim().length < 5 ? 0.5 : 1,
                      }}
                    >
                      {enregistre === v.id ? '…' : 'Enregistrer'}
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: 12, color: t.C.red, margin: 0 }}>Justificatif non fourni.</p>
                )}
              </div>
            )
          })}
        </div>
      </Carte>
    </Carte>
  )
}
