'use client'

// La vue « Booking » de l'onglet Rotation & Fournisseurs.
//
// Un booking se decide sur une seule question : est-ce que l'escompte et les
// termes de paiement valent le cout d'immobiliser ce stock jusqu'a sa vente ?
// L'ecran est construit pour repondre a celle-la, dans cet ordre :
//
//   1. quel programme, et combien de temps reste-t-il          les cartes
//   2. quelle periode couvrir, sous quelle contrainte          le formulaire
//   3. le verdict chiffre, et la phrase qui l'explique         le bandeau
//   4. ou en est chaque bareme, et faut-il pousser plus loin   les baremes
//   5. quelles pieces, et lesquelles sont la juste pour le palier
//
// Le point qui merite l'ecran : la colonne « dont etirement ». Ce sont les
// unites achetees uniquement pour franchir un seuil. Elles sont la vraie
// monnaie d'echange d'une negociation, et ce sont elles qui deviennent le
// stock mort de l'an prochain quand on se trompe.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Th, Badge, Message, fmtArgentCourt,
} from '@/components/meca/MecaUI'
import BookingImports from '@/components/rotation/BookingImports'

const fmtPct = (v: number) => `${(Math.round(v * 100) / 100).toLocaleString('fr-CA')} %`
const fmtDate = (s: string | null) => {
  if (!s) return '—'
  const [a, m, j] = s.split('-')
  return `${j}/${m}/${a}`
}

const OBJECTIFS: { id: string; label: string; aide: string }[] = [
  { id: 'optimal',    label: 'Le meilleur gain net',
    aide: 'Le moteur monte au palier suivant tant que l\'escompte gagne depasse le cout de porter les unites ajoutees. C\'est le reglage a garder par defaut.' },
  { id: 'budget',     label: 'Sous un plafond',
    aide: 'On ne depasse pas le montant fixe. Les unites ajoutees pour un palier sont coupees en premier, puis les besoins les moins urgents.' },
  { id: 'couverture', label: 'Le strict besoin',
    aide: 'Aucun etirement : uniquement ce que la periode exige. Utile pour voir le plancher avant de negocier.' },
  { id: 'palier',     label: 'Viser un palier precis',
    aide: 'On force le niveau demande, meme s\'il n\'est pas rentable. Le bandeau dira alors combien il coute.' },
]

const MOTIFS: Record<string, { label: string; couleur: keyof Theme['C'] }> = {
  besoin:  { label: 'Besoin',        couleur: 'blue' },
  rupture: { label: 'Rupture',       couleur: 'red' },
  palier:  { label: 'Pour le palier', couleur: 'yellow' },
  minimum: { label: 'Pour le minimum', couleur: 'yellow' },
}

export default function BookingVue({ t, email }: { t: Theme; email: string | null }) {
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [programmes, setProgrammes] = useState<any[]>([])
  const [bookings, setBookings] = useState<any[]>([])
  const [fournisseursErp, setFournisseursErp] = useState<string[]>([])

  const [choisi, setChoisi] = useState<any | null>(null)
  const [objectif, setObjectif] = useState('optimal')
  const [budget, setBudget] = useState('')
  const [couverture, setCouverture] = useState(6)
  const [palierVise, setPalierVise] = useState('')
  const [dateCommande, setDateCommande] = useState(new Date().toISOString().slice(0, 10))

  // Prevision : un fournisseur, deux dates, et la question « de quoi vais-je
  // avoir besoin » — sans qu'un programme existe.
  const [prevFournisseur, setPrevFournisseur] = useState('')
  const [prevDebut, setPrevDebut] = useState(new Date().toISOString().slice(0, 10))
  const [prevFin, setPrevFin] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 6)
    return d.toISOString().slice(0, 10)
  })
  const [prevision, setPrevision] = useState(false)

  const [calcul, setCalcul] = useState(false)
  const [proposition, setProposition] = useState<any | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [voirToutesLignes, setVoirToutesLignes] = useState(false)

  const charger = useCallback(async () => {
    setChargement(true)
    try {
      const r = await fetch('/api/rotation/booking')
      const j = await r.json()
      if (j.erreur) throw new Error(j.erreur)
      setProgrammes(j.programmes || [])
      setBookings(j.bookings || [])
      setFournisseursErp(j.fournisseurs || [])
      setErreur(null)
    } catch (e: any) {
      setErreur(e.message)
    } finally {
      setChargement(false)
    }
  }, [])

  useEffect(() => { charger() }, [charger])

  const calculer = useCallback(async (prog: any) => {
    setCalcul(true); setMessage(null); setProposition(null)
    try {
      const r = await fetch('/api/rotation/booking/calculer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programme_id: prog.id,
          objectif,
          budget_max: objectif === 'budget' && budget ? Number(budget) : null,
          couverture_mois: couverture,
          palier_vise: objectif === 'palier' ? palierVise : null,
          date_commande: dateCommande,
        }),
      })
      const j = await r.json()
      if (j.erreur) throw new Error(j.erreur)
      setProposition(j.proposition)
      setRunId(j.run_id)
    } catch (e: any) {
      setMessage(`Erreur : ${e.message}`)
    } finally {
      setCalcul(false)
    }
  }, [objectif, budget, couverture, palierVise, dateCommande])

  const calculerPrevision = useCallback(async () => {
    if (!prevFournisseur) return
    setCalcul(true); setMessage(null); setProposition(null); setChoisi(null)
    try {
      const r = await fetch('/api/rotation/booking/calculer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fournisseur: prevFournisseur,
          couvre_debut: prevDebut,
          couvre_fin: prevFin,
          date_commande: new Date().toISOString().slice(0, 10),
        }),
      })
      const j = await r.json()
      if (j.erreur) throw new Error(j.erreur)
      setProposition(j.proposition)
      setRunId(j.run_id)
      setPrevision(true)
    } catch (e: any) {
      setMessage(`Erreur : ${e.message}`)
    } finally { setCalcul(false) }
  }, [prevFournisseur, prevDebut, prevFin])

  const enregistrer = useCallback(async () => {
    if (!proposition || !choisi) return
    try {
      const r = await fetch('/api/rotation/booking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposition, programme_id: choisi.id, run_id: runId,
          nom: `${choisi.fournisseur} — ${choisi.nom}`,
          objectif,
          budget_max: objectif === 'budget' && budget ? Number(budget) : null,
          couverture_mois: couverture,
          palier_vise: objectif === 'palier' ? palierVise : null,
          date_commande: dateCommande,
          user_email: email,
        }),
      })
      const j = await r.json()
      if (j.erreur) throw new Error(j.erreur)
      setMessage(`Proposition enregistree (#${j.booking.id}). Tu peux l'exporter en CSV.`)
      charger()
    } catch (e: any) {
      setMessage(`Erreur : ${e.message}`)
    }
  }, [proposition, choisi, runId, objectif, budget, couverture, palierVise, dateCommande, email, charger])

  const ouverts = useMemo(() => programmes.filter(p => p.ouvert), [programmes])
  const fermes  = useMemo(() => programmes.filter(p => !p.ouvert), [programmes])

  if (chargement) return <Message t={t} type="info">Chargement des programmes…</Message>

  if (erreur) {
    return (
      <Message t={t} type="err">
        {erreur}
        <div style={{ marginTop: 8, fontSize: 12 }}>
          Si la table n'existe pas encore, execute les migrations{' '}
          <code>2026-09-03_booking.sql</code> puis <code>2026-09-03b_booking_seed.sql</code> dans Supabase.
        </div>
      </Message>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── Ce qui ferme bientot ───────────────────────────────────── */}
      <Urgences t={t} programmes={ouverts} />

      {/* ── Ce qui arrive par courriel, en attente de relecture ────── */}
      <BookingImports t={t} email={email}
        fournisseurs={fournisseursErp}
        onValide={charger} />

      {/* ── Prevoir un besoin, sans programme ──────────────────────── */}
      <Carte t={t}>
        <SectionTitre t={t} titre="Prevoir le stock d'un fournisseur"
          aide="Sans grille commerciale : juste ce qu'il te faudra chez ce fournisseur entre deux dates. Meme calcul que pour un booking — saisonnalite, stock en route, references interchangeables, commandes speciales ecartees — mais aucun escompte a arbitrer." />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginTop: 16 }}>
          <Champ t={t} label="Fournisseur">
            <select value={prevFournisseur} onChange={e => setPrevFournisseur(e.target.value)} style={inputStyle(t)}>
              <option value="">Choisir…</option>
              {fournisseursErp.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </Champ>
          <Champ t={t} label="Du" aide="Debut de la periode a couvrir.">
            <input type="date" value={prevDebut} onChange={e => setPrevDebut(e.target.value)} style={inputStyle(t)} />
          </Champ>
          <Champ t={t} label="Au" aide="Le besoin suit le rythme saisonnier de chaque piece sur cette fenetre.">
            <input type="date" value={prevFin} onChange={e => setPrevFin(e.target.value)} style={inputStyle(t)} />
          </Champ>
        </div>

        <button onClick={calculerPrevision} disabled={calcul || !prevFournisseur}
          style={{ ...boutonStyle(t, t.C.blue, calcul || !prevFournisseur), marginTop: 16 }}>
          {calcul ? 'Calcul en cours…' : 'Calculer le besoin'}
        </button>
      </Carte>

      {/* ── Le choix du programme ──────────────────────────────────── */}
      <Carte t={t}>
        <SectionTitre t={t} titre="Les programmes"
          aide="Un programme par bulletin fournisseur, saisi tel qu'il est ecrit dans son PDF. Choisis-en un pour calculer la commande." />

        {ouverts.length === 0 && (
          <div style={{ marginTop: 12 }}>
            <Message t={t} type="info">
              Aucun programme n'est ouvert aujourd'hui. Les programmes fermes restent calculables
              en simulation — leur grille est reconduite d'une annee sur l'autre.
            </Message>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginTop: 14 }}>
          {[...ouverts, ...fermes].map(p => (
            <CarteProgramme key={p.id} t={t} p={p} actif={choisi?.id === p.id}
              onChoisir={() => { setChoisi(p); setProposition(null); setMessage(null) }} />
          ))}
        </div>
      </Carte>

      {/* ── Le formulaire ──────────────────────────────────────────── */}
      {choisi && (
        <Carte t={t}>
          <SectionTitre t={t} titre={`${choisi.fournisseur} — ${choisi.nom}`}
            aide={choisi.notes || undefined} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, marginTop: 16 }}>
            <Champ t={t} label="Date de la commande"
              aide="Elle decide des escomptes hatifs encore ouverts et du delai gagne par le dating.">
              <input type="date" value={dateCommande} onChange={e => setDateCommande(e.target.value)}
                style={inputStyle(t)} />
            </Champ>

            <Champ t={t} label="Quelle contrainte prime"
              aide={OBJECTIFS.find(o => o.id === objectif)?.aide}>
              <select value={objectif} onChange={e => setObjectif(e.target.value)} style={inputStyle(t)}>
                {OBJECTIFS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Champ>

            {objectif === 'budget' && (
              <Champ t={t} label="Plafond ($)" aide="Ce que tu ne veux pas depasser, tout compris.">
                <input type="number" value={budget} onChange={e => setBudget(e.target.value)}
                  placeholder="25000" style={inputStyle(t)} />
              </Champ>
            )}

            {objectif === 'palier' && (
              <Champ t={t} label="Niveau vise" aide="Le nom du palier tel qu'il apparait dans la grille.">
                <select value={palierVise} onChange={e => setPalierVise(e.target.value)} style={inputStyle(t)}>
                  <option value="">—</option>
                  {[...new Set((choisi.paliers || []).map((p: any) => p.niveau).filter(Boolean))]
                    .map((n: any) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Champ>
            )}

            {!choisi.couvre_debut && (
              <Champ t={t} label="Mois a couvrir"
                aide="Depuis la livraison. Le programme ne precise pas la periode qu'il vise, c'est donc toi qui la fixes.">
                <input type="number" min={1} max={24} value={couverture}
                  onChange={e => setCouverture(Number(e.target.value))} style={inputStyle(t)} />
              </Champ>
            )}
          </div>

          {choisi.couvre_debut && (
            <p style={{ fontSize: 12, color: t.sub, margin: '12px 0 0', lineHeight: 1.6 }}>
              Ce programme vise la periode du <strong>{fmtDate(choisi.couvre_debut)}</strong> au{' '}
              <strong>{fmtDate(choisi.couvre_fin)}</strong>, pour une livraison a partir du{' '}
              <strong>{fmtDate(choisi.livraison_debut)}</strong>. Le besoin est calcule sur cette
              fenetre-la, au rythme saisonnier de chaque piece — pas en moyenne annuelle.
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <button onClick={() => calculer(choisi)} disabled={calcul}
              style={boutonStyle(t, t.C.blue, calcul)}>
              {calcul ? 'Calcul en cours…' : 'Calculer la commande'}
            </button>
            {proposition && (
              <button onClick={enregistrer} style={boutonStyle(t, t.C.green)}>
                Enregistrer cette proposition
              </button>
            )}
          </div>

          {message && (
            <div style={{ marginTop: 12 }}>
              <Message t={t} type={message.startsWith('Erreur') ? 'err' : 'ok'}>{message}</Message>
            </div>
          )}
        </Carte>
      )}

      {/* ── Le resultat ────────────────────────────────────────────── */}
      {proposition && (
        <Resultat t={t} p={proposition} programme={choisi} prevision={prevision}
          voirToutes={voirToutesLignes} setVoirToutes={setVoirToutesLignes} />
      )}

      {/* ── L'historique ───────────────────────────────────────────── */}
      {bookings.length > 0 && (
        <Carte t={t}>
          <SectionTitre t={t} titre="Propositions enregistrees"
            aide="Ce qui a ete calcule et garde. L'export CSV se recopie dans le formulaire du fournisseur." />
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <Th t={t} align="left">Proposition</Th>
                  <Th t={t} align="left">Date</Th>
                  <Th t={t}>Lignes</Th>
                  <Th t={t}>Brut</Th>
                  <Th t={t}>Escompte</Th>
                  <Th t={t}>Net</Th>
                  <Th t={t}>Gain net</Th>
                  <Th t={t} align="center">Statut</Th>
                  <Th t={t} align="center">Export</Th>
                </tr>
              </thead>
              <tbody>
                {bookings.map(b => (
                  <tr key={b.id} style={{ borderTop: `1px solid ${t.bdr}` }}>
                    <td style={tdStyle('left')}>{b.nom}</td>
                    <td style={tdStyle('left')}>{fmtDate(b.date_commande)}</td>
                    <td style={tdStyle()}>{b.nb_lignes}</td>
                    <td style={tdStyle()}>{fmtArgentCourt(Number(b.montant_brut))}</td>
                    <td style={tdStyle()}>{fmtPct(Number(b.escompte_pct))}</td>
                    <td style={tdStyle()}>{fmtArgentCourt(Number(b.montant_net))}</td>
                    <td style={{ ...tdStyle(), color: Number(b.gain_net_dollars) >= 0 ? t.C.green : t.C.red, fontWeight: 700 }}>
                      {fmtArgentCourt(Number(b.gain_net_dollars))}
                    </td>
                    <td style={tdStyle('center')}><Badge t={t} couleur={t.C.blue}>{b.statut}</Badge></td>
                    <td style={tdStyle('center')}>
                      <a href={`/api/rotation/booking/export?booking=${b.id}`}
                        style={{ color: t.C.blue, fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
                        CSV
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Carte>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Ce qui ferme bientot — la seule chose qui doit sauter aux yeux
// ═══════════════════════════════════════════════════════════════════════

function Urgences({ t, programmes }: { t: Theme; programmes: any[] }) {
  // Un escompte hatif ne se rattrape pas : passe la date, les points sont
  // perdus pour l'annee. C'est la seule information de cet ecran qui a une
  // date de peremption.
  const echeances = programmes
    .filter(p => p.prochaine_echeance && p.prochaine_echeance.jours <= 45)
    .sort((a, b) => a.prochaine_echeance.jours - b.prochaine_echeance.jours)

  if (echeances.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {echeances.map(p => {
        const e = p.prochaine_echeance
        const urgent = e.jours <= 14
        return (
          <div key={p.id} style={{
            padding: '12px 16px', borderRadius: 10, fontSize: 13, lineHeight: 1.6,
            color: urgent ? t.C.red : t.C.yellow,
            background: `${urgent ? t.C.red : t.C.yellow}14`,
            border: `1px solid ${urgent ? t.C.red : t.C.yellow}55`,
          }}>
            <strong>{p.fournisseur}</strong> — {e.libelle} :{' '}
            <strong>{e.valeur_pct} %</strong> qui tombent le <strong>{fmtDate(e.date)}</strong>,
            {' '}dans <strong>{e.jours} jour{e.jours > 1 ? 's' : ''}</strong>.
            {urgent && ' Passe cette date, ces points sont perdus pour l\'annee.'}
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// La carte d'un programme
// ═══════════════════════════════════════════════════════════════════════

function CarteProgramme({ t, p, actif, onChoisir }: {
  t: Theme; p: any; actif: boolean; onChoisir: () => void
}) {
  // Le meilleur escompte annonce, tous baremes confondus : c'est ce qui
  // permet de comparer deux programmes d'un coup d'oeil.
  const maxEscompte = Math.max(0, ...(p.paliers || []).map((x: any) => Number(x.escompte_pct) || 0))
  const nbBaremes = new Set((p.paliers || []).map((x: any) => x.bareme)).size

  return (
    <button onClick={onChoisir} style={{
      textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 10,
      border: `1px solid ${actif ? t.C.blue : t.bdr}`,
      background: actif ? (t.dark ? '#1a233a' : '#dbeafe') : t.card,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 13, color: t.dark ? '#e8eaed' : '#202124' }}>
          {p.fournisseur}
        </span>
        <Badge t={t} couleur={p.ouvert ? t.C.green : t.sub}>
          {p.ouvert ? (p.jours_restants != null ? `${p.jours_restants} j` : 'ouvert') : 'ferme'}
        </Badge>
      </div>
      <div style={{ fontSize: 12, color: t.sub, lineHeight: 1.5 }}>{p.nom}</div>
      <div style={{ fontSize: 11, color: t.sub }}>
        {fmtDate(p.ouvre_le)} → {fmtDate(p.ferme_le)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
        {maxEscompte > 0 && <Badge t={t} couleur={t.C.green}>jusqu'a {maxEscompte} %</Badge>}
        {nbBaremes > 1 && <Badge t={t} couleur={t.C.blue}>{nbBaremes} baremes</Badge>}
        {p.baremes_exclusifs && <Badge t={t} couleur={t.C.yellow}>par categorie</Badge>}
      </div>
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Le resultat
// ═══════════════════════════════════════════════════════════════════════

function Resultat({ t, p, programme, prevision, voirToutes, setVoirToutes }: {
  t: Theme; p: any; programme: any; prevision?: boolean
  voirToutes: boolean; setVoirToutes: (v: boolean) => void
}) {
  const bon = p.gain_net_dollars > 0
  const lignes = voirToutes ? p.lignes : p.lignes.slice(0, 60)
  const etirement = p.lignes.reduce((s: number, l: any) => s + (l.qte_etirement || 0) * l.cout_unitaire, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Le verdict, en une phrase et cinq chiffres */}
      <Carte t={t} style={{ borderColor: prevision ? t.bdr : (bon ? t.C.green : t.C.red) }}>
        <SectionTitre t={t} titre={prevision ? 'Le besoin' : 'Le verdict'} />
        <p style={{ fontSize: 14, lineHeight: 1.7, color: t.dark ? '#e8eaed' : '#202124', margin: '10px 0 16px' }}>
          {prevision ? (
            <>Pour tenir du <strong>{fmtDate(p.couvre_debut)}</strong> au <strong>{fmtDate(p.couvre_fin)}</strong>,
            il te manque <strong>{fmtArgentCourt(p.montant_brut)}</strong> sur <strong>{p.nb_lignes}</strong> references,
            compte tenu de ton stock et de ce qui est deja en route. Aucun escompte n'est applique :
            c'est le besoin nu, celui qu'un programme viendrait ensuite remiser.</>
          ) : bon ? (
            <>Cette commande de <strong>{fmtArgentCourt(p.montant_net)}</strong> net rapporte{' '}
            <strong style={{ color: t.C.green }}>{fmtArgentCourt(p.gain_net_dollars)}</strong> une fois
            le cout de portage deduit. L'escompte pese {fmtArgentCourt(p.escompte_dollars)}
            {p.dating_dollars > 0 && <> et les termes de paiement {fmtArgentCourt(p.dating_dollars)}</>},
            contre {fmtArgentCourt(p.portage_dollars)} pour garder ce stock jusqu'a sa vente.</>
          ) : (
            <>Cette commande de <strong>{fmtArgentCourt(p.montant_net)}</strong> net coute{' '}
            <strong style={{ color: t.C.red }}>{fmtArgentCourt(-p.gain_net_dollars)}</strong> de plus
            qu'elle ne rapporte : {fmtArgentCourt(p.portage_dollars)} de portage contre{' '}
            {fmtArgentCourt(p.escompte_dollars + p.dating_dollars)} d'avantages. Reduis la periode
            couverte, ou passe en « strict besoin » pour voir le plancher.</>
          )}
        </p>

        <GrilleKpi min={150}>
          <KpiCard t={t} label={prevision ? 'Besoin total' : 'Montant brut'} value={fmtArgentCourt(p.montant_brut)} />
          {!prevision && <KpiCard t={t} label={`Escompte (${fmtPct(p.escompte_pct)})`} value={fmtArgentCourt(p.escompte_dollars)} />}
          {!prevision && <KpiCard t={t} label="Montant net" value={fmtArgentCourt(p.montant_net)} />}
          {!prevision && <KpiCard t={t} label={p.dating_jours > 0 ? `Dating (+${p.dating_jours} j)` : 'Dating'}
            value={fmtArgentCourt(p.dating_dollars)} />}
          <KpiCard t={t} label="Cout de portage" value={fmtArgentCourt(p.portage_dollars)} warn={!prevision && p.portage_dollars > p.escompte_dollars} />
          {!prevision && <KpiCard t={t} label="Gain net" value={fmtArgentCourt(p.gain_net_dollars)} warn={!bon} />}
          <KpiCard t={t} label="References" value={String(p.nb_lignes)} />
        </GrilleKpi>

        <p style={{ fontSize: 12, color: t.sub, margin: '14px 0 0', lineHeight: 1.6 }}>
          Periode couverte : <strong>{fmtDate(p.couvre_debut)}</strong> au <strong>{fmtDate(p.couvre_fin)}</strong>,
          livraison a partir du <strong>{fmtDate(p.livraison)}</strong>.
          {etirement > 0 && (
            <> Sur le total, <strong>{fmtArgentCourt(etirement)}</strong> ont ete ajoutes uniquement
            pour franchir un seuil — c'est la part negociable, et la premiere a couper.</>
          )}
        </p>
      </Carte>

      {/* Ce qu'il faut savoir avant de croire le chiffre */}
      {p.avertissements?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {p.avertissements.map((a: string, i: number) => (
            <Message key={i} t={t} type="info">{a}</Message>
          ))}
        </div>
      )}

      {/* Les baremes */}
      {p.baremes?.length > 0 && (
        <Carte t={t}>
          <SectionTitre t={t} titre="Ou en est chaque bareme"
            aide={programme?.baremes_exclusifs
              ? 'Chaque piece ne compte que dans un seul bareme. Pousser les pneus au palier suivant se fait donc au detriment du reste.'
              : 'Les baremes se cumulent : une meme piece peut beneficier de plusieurs.'} />
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <Th t={t} align="left">Bareme</Th>
                  <Th t={t}>Montant</Th>
                  <Th t={t}>Pieces</Th>
                  <Th t={t} align="center">Palier atteint</Th>
                  <Th t={t}>Escompte</Th>
                  <Th t={t} align="left">Le palier suivant</Th>
                </tr>
              </thead>
              <tbody>
                {p.baremes.map((b: any) => (
                  <tr key={b.bareme} style={{ borderTop: `1px solid ${t.bdr}` }}>
                    <td style={tdStyle('left')}>
                      <strong>{b.bareme}</strong>
                      {b.axe !== 'tout' && (
                        <div style={{ fontSize: 11, color: t.sub }}>par {b.axe}</div>
                      )}
                    </td>
                    <td style={tdStyle()}>{fmtArgentCourt(b.montant)}</td>
                    <td style={tdStyle()}>{b.nb_pieces}</td>
                    <td style={tdStyle('center')}>
                      {b.palier_atteint
                        ? <Badge t={t} couleur={t.C.green}>{b.palier_atteint}</Badge>
                        : <span style={{ color: t.sub }}>aucun</span>}
                    </td>
                    <td style={{ ...tdStyle(), fontWeight: 700, color: b.escompte_pct > 0 ? t.C.green : t.sub }}>
                      {fmtPct(b.escompte_pct)}
                    </td>
                    <td style={{ ...tdStyle('left'), fontSize: 12, color: t.sub, lineHeight: 1.5, maxWidth: 420 }}>
                      {b.verdict || (b.prochain_niveau
                        ? `${b.prochain_niveau} a ${fmtArgentCourt(b.prochain_seuil)} — il manque ${fmtArgentCourt(b.manque || 0)}.`
                        : 'Palier maximum atteint.')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Carte>
      )}

      {/* Les bonus */}
      {p.detail_bonus?.length > 0 && (
        <Carte t={t}>
          <SectionTitre t={t} titre="Les avantages hors grille"
            aide="Escomptes hatifs, paiement rapide, suppléments par famille. Ce qui a ete ecarte l'est avec sa raison." />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {p.detail_bonus.map((b: any, i: number) => (
              <div key={i} style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13,
                opacity: b.retenu ? 1 : 0.62,
              }}>
                <Badge t={t} couleur={b.retenu ? t.C.green : t.sub}>
                  {b.retenu ? `+${b.valeur_pct} %` : 'ecarte'}
                </Badge>
                <div style={{ lineHeight: 1.5 }}>
                  <span style={{ color: t.dark ? '#e8eaed' : '#202124' }}>{b.libelle}</span>
                  {b.pourquoi && <div style={{ fontSize: 12, color: t.sub }}>{b.pourquoi}</div>}
                </div>
              </div>
            ))}
            {p.dating_choisi === 'dating' && (
              <div style={{ fontSize: 12, color: t.sub, lineHeight: 1.6, marginTop: 4 }}>
                Le dating retenu fait gagner <strong>{p.dating_jours} jours</strong> sur les termes ordinaires.
              </div>
            )}
          </div>
        </Carte>
      )}

      {/* Les lignes */}
      <Carte t={t}>
        <SectionTitre t={t} titre={`La commande — ${p.nb_lignes} lignes`}
          aide="Triee par montant. « Dont etirement » est la part achetee uniquement pour franchir un seuil : c'est elle qu'on coupe en premier si le budget serre." />
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                <Th t={t} align="left">Piece</Th>
                <Th t={t}>Qte</Th>
                <Th t={t} align="left">A commander</Th>
                <Th t={t}>Cout</Th>
                <Th t={t}>Montant</Th>
                <Th t={t} align="center">Pourquoi</Th>
                <Th t={t}>Dont etirement</Th>
                <Th t={t}>Stock</Th>
                <Th t={t}>En route</Th>
                <Th t={t}>Couvert par equiv.</Th>
                <Th t={t}>Demande</Th>
                <Th t={t}>Couv. apres</Th>
                <Th t={t}>Rotation</Th>
                <Th t={t} align="left">Bareme</Th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l: any) => {
                const m = MOTIFS[l.motif] || MOTIFS.besoin
                return (
                  <tr key={l.code_piece} style={{ borderTop: `1px solid ${t.bdr}` }}>
                    <td style={tdStyle('left')}>
                      <div style={{ fontWeight: 700 }}>{l.code_piece}</div>
                      <div style={{ fontSize: 11, color: t.sub, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.description}
                      </div>
                    </td>
                    <td style={{ ...tdStyle(), fontWeight: 700 }}>{l.qte}</td>
                    <td style={{ ...tdStyle('left'), fontSize: 11.5 }}>
                      {l.contenants > 0
                        ? <span style={{ color: t.C.blue, fontWeight: 700 }}>
                            {l.contenants} × {l.conditionnement}
                          </span>
                        : <span style={{ color: t.sub }}>a l'unite</span>}
                    </td>
                    <td style={tdStyle()}>{Number(l.cout_unitaire).toFixed(2)}</td>
                    <td style={{ ...tdStyle(), fontWeight: 700 }}>{fmtArgentCourt(l.montant)}</td>
                    <td style={tdStyle('center')}>
                      <Badge t={t} couleur={t.C[m.couleur]}>{m.label}</Badge>
                    </td>
                    <td style={{ ...tdStyle(), color: l.qte_etirement > 0 ? t.C.yellow : t.sub }}>
                      {l.qte_etirement > 0 ? l.qte_etirement : '—'}
                    </td>
                    <td style={tdStyle()}>{l.stock}</td>
                    <td style={tdStyle()}>{l.en_route || '—'}</td>
                    <td style={{ ...tdStyle(), color: l.alt_couverture > 0 ? t.C.green : t.sub }}>
                      {l.alt_couverture > 0
                        ? <span title={`Deja en stock sous : ${(l.alt_codes || []).join(', ')}`}>
                            −{l.alt_couverture}
                          </span>
                        : '—'}
                    </td>
                    <td style={tdStyle()}>{Number(l.demande_periode).toFixed(1)}</td>
                    <td style={tdStyle()}>{l.couverture_apres != null ? `${l.couverture_apres} m` : '—'}</td>
                    <td style={tdStyle()}>{Number(l.rotation).toFixed(2)}</td>
                    <td style={{ ...tdStyle('left'), fontSize: 11, color: t.sub }}>{l.bareme}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {p.lignes.length > 60 && (
          <button onClick={() => setVoirToutes(!voirToutes)}
            style={{ ...boutonStyle(t, t.C.blue), marginTop: 12, background: 'transparent' }}>
            {voirToutes ? 'Ne montrer que les 60 premieres' : `Voir les ${p.lignes.length} lignes`}
          </button>
        )}
      </Carte>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Petites briques
// ═══════════════════════════════════════════════════════════════════════

function Champ({ t, label, aide, children }: { t: Theme; label: string; aide?: string; children: any }) {
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 700, color: t.dark ? '#e8eaed' : '#202124', display: 'block', marginBottom: 5 }}>
        {label}
      </label>
      {children}
      {aide && <p style={{ fontSize: 11, color: t.sub, margin: '5px 0 0', lineHeight: 1.5 }}>{aide}</p>}
    </div>
  )
}

function inputStyle(t: Theme): any {
  return {
    width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
    border: `1px solid ${t.bdr}`, background: t.dark ? '#202124' : '#fff',
    color: t.dark ? '#e8eaed' : '#202124',
  }
}

function boutonStyle(t: Theme, couleur: string, disabled = false): any {
  return {
    padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
    border: `1px solid ${couleur}`, background: `${couleur}1f`, color: couleur,
  }
}

function tdStyle(align: 'left' | 'right' | 'center' = 'right'): any {
  return { padding: '8px 10px', textAlign: align, verticalAlign: 'top' }
}
