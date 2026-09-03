'use client'

// La file d'attente des programmes recus.
//
// Le principe de cet ecran : l'IA propose, un humain dispose. Ces chiffres
// pilotent des commandes a cinq chiffres, alors rien ne devient un programme
// actif sans qu'on ait regarde. L'ecran met donc en avant, dans l'ordre :
//
//   1. ce dont le modele s'est declare INCERTAIN — la seule chose qu'il faut
//      verifier ligne a ligne dans le document d'origine
//   2. le rapprochement au fournisseur de l'ERP, qui conditionne tout : un
//      programme rattache au mauvais nom ne trouvera aucune piece
//   3. la grille extraite, telle qu'elle sera enregistree
//
// Le taux de confiance est affiche mais volontairement discret : c'est le
// modele qui se note lui-meme, ca ne remplace pas la relecture.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Theme, Carte, SectionTitre, Th, Badge, Message } from '@/components/meca/MecaUI'

const fmtDate = (s: string | null) => {
  if (!s) return '—'
  const [a, m, j] = String(s).slice(0, 10).split('-')
  return j ? `${j}/${m}/${a}` : String(s)
}
const fmtArgent = (v: number | null | undefined) =>
  v == null ? '—' : Math.round(v).toLocaleString('fr-CA') + ' $'

const STATUTS: Record<string, { label: string; couleur: keyof Theme['C'] | 'sub' }> = {
  nouveau:        { label: 'Recu',              couleur: 'blue' },
  extrait:        { label: 'Extrait',           couleur: 'blue' },
  a_valider:      { label: 'A valider',         couleur: 'yellow' },
  valide:         { label: 'Valide',            couleur: 'green' },
  rejete:         { label: 'Classe sans suite', couleur: 'sub' },
  lien_seulement: { label: 'Derriere un portail', couleur: 'yellow' },
  erreur:         { label: 'Echec',             couleur: 'red' },
}

export default function BookingImports({ t, email, fournisseurs, onValide }: {
  t: Theme
  email: string | null
  fournisseurs: string[]
  onValide: () => void
}) {
  const [imports, setImports] = useState<any[]>([])
  const [totaux, setTotaux] = useState<any>({})
  const [chargement, setChargement] = useState(true)
  const [envoi, setEnvoi] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [ouvert, setOuvert] = useState<number | null>(null)
  // Seul « a valider » s'ouvre de lui-meme : c'est le seul groupe qui demande
  // une decision. Les echecs et les classes sans suite restent replies.
  const [groupesOuverts, setGroupesOuverts] = useState<Set<string>>(new Set(['a_valider']))
  const [dispo, setDispo] = useState(true)
  const [gmail, setGmail] = useState<string | null>(null)
  const [releve, setReleve] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const charger = useCallback(async () => {
    try {
      const r = await fetch('/api/rotation/booking/imports')
      const j = await r.json()
      if (j.erreur) { setDispo(false); return }
      setImports(j.imports || [])
      setTotaux(j.totaux || {})
      setDispo(true)
    } catch { setDispo(false) } finally { setChargement(false) }
  }, [])

  useEffect(() => { charger() }, [charger])

  const televerser = useCallback(async (fichiers: FileList | null) => {
    if (!fichiers?.length) return
    setEnvoi(true); setMessage(null)
    try {
      const fd = new FormData()
      for (const f of Array.from(fichiers)) fd.append('fichiers', f)
      if (email) fd.append('user_email', email)
      const r = await fetch('/api/rotation/booking/imports', { method: 'POST', body: fd })
      const j = await r.json()
      if (j.erreur) throw new Error(j.erreur)
      const n = (j.imports || []).length
      setMessage(`${n} document${n > 1 ? 's' : ''} analyse${n > 1 ? 's' : ''}. Relis avant de valider.`)
      charger()
    } catch (e: any) {
      setMessage(`Erreur : ${e.message}`)
    } finally {
      setEnvoi(false)
      if (input.current) input.current.value = ''
    }
  }, [email, charger])

  /**
   * Deux appels distincts : « verifier » ne consomme rien et sert a valider le
   * branchement des cles ; « relever » traite vraiment la boite. Separer les
   * deux evite de decouvrir un probleme d'authentification au milieu d'un
   * traitement a moitie fait.
   */
  const gmailAppel = useCallback(async (mode: 'test' | 'relever' | 'historique' | 'relancer') => {
    setReleve(true); setGmail(null)
    try {
      const q = mode === 'test' ? '?test=1'
        : mode === 'historique' ? '?depuis=2024/01/01&max=60'
        : mode === 'relancer' ? '?relancer=1&max=30'
        : ''
      const r = await fetch(`/api/rotation/booking/gmail${q}`)
      const j = await r.json()
      if (j.erreur) {
        setGmail(`${j.erreur}${j.aide ? ' — ' + j.aide : ''}${j.manque?.length ? ' Manque : ' + j.manque.join(', ') + '.' : ''}`)
        return
      }
      if (mode === 'test') {
        setGmail(j.message || 'Acces confirme.')
      } else if (j.panne_message) {
        // Une panne d'environnement se dit UNE fois, en clair. Vingt-trois
        // lignes « Echec » identiques a l'ecran ne disent rien d'utile.
        setGmail(j.panne_message)
        charger()
      } else if (mode === 'relancer') {
        setGmail(`${j.nb_repris} document(s) repris, ${j.a_valider} en attente de ta relecture` +
                 `${j.nb_erreurs ? `, ${j.nb_erreurs} encore en echec` : ''}` +
                 `${j.nb_perimes ? `. ${j.nb_perimes} classe(s) sans suite : recus il y a plus de ${j.fenetre_jours} jours, programmes presumes fermes` : ''}.` +
                 `${j.nb_restant ? ` Il en reste ${j.nb_restant} : relance encore, une lecture prend 15 a 50 secondes et le temps par appel est limite.` : ''}`)
        charger()
      } else {
        setGmail(
          `${j.nb_messages} courriel(s) releve(s), ${j.nb_documents} document(s) analyse(s), ` +
          `${j.a_valider} en attente de ta relecture` +
          `${j.nb_a_rejouer ? `, ${j.nb_a_rejouer} a rejouer plus tard` : ''}.` +
          `${j.nb_restant ? ` Il en reste ${j.nb_restant} : relance encore.` : ''}`)
        charger()
      }
    } catch (e: any) {
      // Le travail deja accompli est enregistre au fil de l'eau : on recharge
      // meme en cas d'echec, sinon l'ecran laisse croire a une perte totale.
      setGmail(`Erreur : ${e.message} — recharge de l'etat en cours, ce qui a ete traite avant l'incident est conserve.`)
      charger()
    } finally { setReleve(false) }
  }, [charger])

  const agir = useCallback(async (id: number, action: string, extra: any = {}) => {
    try {
      const r = await fetch('/api/rotation/booking/imports', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, user_email: email, ...extra }),
      })
      const j = await r.json()
      if (j.erreur) throw new Error(j.erreur)
      if (action === 'valider') {
        setMessage(`Programme cree : ${j.nb_paliers} paliers, ${j.nb_bonus} bonus. Il apparait maintenant dans la liste.`)
        onValide()
      }
      charger()
    } catch (e: any) {
      setMessage(`Erreur : ${e.message}`)
    }
  }, [email, charger, onValide])

  if (chargement) return null

  if (!dispo) {
    return (
      <Carte t={t}>
        <SectionTitre t={t} titre="Programmes recus" />
        <div style={{ marginTop: 12 }}>
          <Message t={t} type="info">
            Table absente. Execute la migration <code>2026-09-03d_booking_imports.sql</code> dans Supabase
            pour activer l'import automatique des programmes.
          </Message>
        </div>
      </Carte>
    )
  }

  // La boite contient des dizaines de courriels dont la plupart ne sont pas
  // des programmes. Les aligner a plat noie les trois ou quatre qui demandent
  // une decision. On les range donc par statut, dans l'ordre de ce qu'ils
  // exigent de toi, et seul le premier groupe s'ouvre de lui-meme.
  const GROUPES: { statut: string; titre: string; couleur: keyof Theme['C'] | 'sub'; aide: string }[] = [
    { statut: 'a_valider', titre: 'A valider', couleur: 'yellow',
      aide: 'Un programme a ete lu. Verifie ce dont le modele n\'etait pas sur, puis valide.' },
    { statut: 'lien_seulement', titre: 'Derriere un portail', couleur: 'yellow',
      aide: 'La grille est derriere un login concessionnaire. Telecharge le fichier et depose-le ici.' },
    { statut: 'erreur', titre: 'En echec', couleur: 'red',
      aide: 'L\'extraction n\'a pas abouti. Si la cause etait passagere, relance.' },
    { statut: 'valide', titre: 'Valides', couleur: 'green',
      aide: 'Devenus des programmes actifs.' },
    { statut: 'rejete', titre: 'Classes sans suite', couleur: 'sub',
      aide: 'Ce ne sont pas des programmes de reservation — factures, catalogues, bulletins.' },
    { statut: 'nouveau', titre: 'En attente de lecture', couleur: 'blue', aide: '' },
  ]

  const parStatut = new Map<string, any[]>()
  for (const i of imports) parStatut.set(i.statut, [...(parStatut.get(i.statut) || []), i])

  // Les causes d'echec, dedupliquees. Soixante-dix-huit lignes « Echec »
  // identiques n'apprennent rien ; « 55 fois : le solde est a zero » se lit.
  const causes = new Map<string, number>()
  for (const i of parStatut.get('erreur') || []) {
    const c = String(i.erreur || 'Cause inconnue').slice(0, 200)
    causes.set(c, (causes.get(c) || 0) + 1)
  }

  return (
    <Carte t={t}>
      <SectionTitre t={t} titre="Programmes recus"
        aide="Depose les PDF, Excel ou courriels de programme : ils sont lus automatiquement et deposes ici. Rien ne devient actif sans ta relecture." />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
        <input ref={input} type="file" multiple accept=".pdf,.xlsx,.xlsm,.xls,.csv,.txt,.eml"
          onChange={e => televerser(e.target.files)} style={{ display: 'none' }} />
        <button onClick={() => input.current?.click()} disabled={envoi} style={{
          padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
          cursor: envoi ? 'wait' : 'pointer', opacity: envoi ? 0.6 : 1,
          border: `1px solid ${t.C.blue}`, background: `${t.C.blue}1f`, color: t.C.blue,
        }}>
          {envoi ? 'Lecture en cours…' : 'Deposer des programmes'}
        </button>

        <span style={{ width: 1, height: 26, background: t.bdr, margin: '0 4px' }} />

        <button onClick={() => gmailAppel('test')} disabled={releve} style={boutonPlat(t, t.sub, releve)}>
          Verifier l'acces a la boite
        </button>
        <button onClick={() => gmailAppel('relever')} disabled={releve} style={boutonPlat(t, t.C.blue, releve)}
          title="Analyse les courriels des 30 derniers jours. Au-dela, un programme de reservation est presque toujours ferme.">
          {releve ? 'En cours…' : 'Relever booking@ (30 j)'}
        </button>
        <button onClick={() => gmailAppel('historique')} disabled={releve} style={boutonPlat(t, t.sub, releve)}
          title="Ignore la fenetre de 30 jours et remonte a janvier 2024. A n'utiliser qu'une fois, pour recuperer les grilles des saisons passees : leurs dates sont a rafraichir a la main.">
          Rattraper l'historique
        </button>
        {totaux.erreur > 0 && (
          <button onClick={() => gmailAppel('relancer')} disabled={releve} style={boutonPlat(t, t.C.red, releve)}
            title="Retelecharge les pieces jointes depuis Gmail et refait l'extraction. Utile quand l'echec venait du service et non du document.">
            Relancer les {totaux.erreur} echecs
          </button>
        )}
      </div>

      {gmail && (
        <div style={{ marginTop: 12 }}>
          <Message t={t} type={/erreur|refuse|configur|manque/i.test(gmail) ? 'err' : 'ok'}>{gmail}</Message>
        </div>
      )}

      {envoi && (
        <p style={{ fontSize: 12, color: t.sub, margin: '10px 0 0', lineHeight: 1.6 }}>
          Une grille dense comme celle de Parts Canada — 132 paliers — prend une minute ou deux a lire.
        </p>
      )}

      {message && (
        <div style={{ marginTop: 12 }}>
          <Message t={t} type={message.startsWith('Erreur') ? 'err' : 'ok'}>{message}</Message>
        </div>
      )}

      {imports.length === 0 && (
        <p style={{ fontSize: 13, color: t.sub, margin: '14px 0 0', lineHeight: 1.6 }}>
          Rien encore. Depose les PDF de tes programmes — ceux du dossier <code>booking/</code> par exemple —
          ou attends que le cron releve <strong>booking@mathiasms.com</strong>.
        </p>
      )}

      {GROUPES.map(g => {
        const lignes = parStatut.get(g.statut) || []
        if (lignes.length === 0) return null
        const deplie = groupesOuverts.has(g.statut)
        const couleur = g.couleur === 'sub' ? t.sub : t.C[g.couleur]

        return (
          <div key={g.statut} style={{ marginTop: 14, border: `1px solid ${t.bdr}`, borderRadius: 10 }}>
            <button
              onClick={() => setGroupesOuverts(s => {
                const n = new Set(s)
                n.has(g.statut) ? n.delete(g.statut) : n.add(g.statut)
                return n
              })}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '11px 14px', cursor: 'pointer', textAlign: 'left',
                background: deplie ? (t.dark ? '#ffffff08' : '#00000005') : 'transparent',
                border: 'none', borderRadius: 10, color: 'inherit',
              }}>
              <span style={{
                display: 'inline-block', width: 12, color: t.sub, fontSize: 11,
                transform: deplie ? 'rotate(90deg)' : 'none', transition: 'transform .12s',
              }}>▶</span>
              <span style={{ fontWeight: 800, fontSize: 13, color: couleur }}>{g.titre}</span>
              <Badge t={t} couleur={couleur}>{lignes.length}</Badge>
              {!deplie && g.aide && (
                <span style={{ fontSize: 11.5, color: t.sub, flex: 1, overflow: 'hidden',
                               textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.aide}
                </span>
              )}
            </button>

            {deplie && (
              <div style={{ padding: '0 14px 14px' }}>
                {g.aide && (
                  <p style={{ fontSize: 12, color: t.sub, margin: '0 0 4px', lineHeight: 1.6 }}>{g.aide}</p>
                )}

                {/* Les causes d'echec, une fois chacune. */}
                {g.statut === 'erreur' && causes.size > 0 && (
                  <div style={{ margin: '10px 0 4px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {[...causes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n], k) => (
                      <div key={k} style={{
                        padding: '9px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.55,
                        color: t.C.red, background: `${t.C.red}12`, border: `1px solid ${t.C.red}44`,
                      }}>
                        <strong>{n} fois</strong> — {c}
                      </div>
                    ))}
                  </div>
                )}

                {lignes.map(i => (
                  <LigneImport key={i.id} t={t} i={i} fournisseurs={fournisseurs}
                    ouvert={ouvert === i.id} onOuvrir={() => setOuvert(ouvert === i.id ? null : i.id)}
                    onAgir={agir} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </Carte>
  )
}

function LigneImport({ t, i, fournisseurs, ouvert, onOuvrir, onAgir }: {
  t: Theme; i: any; fournisseurs: string[]; ouvert: boolean
  onOuvrir: () => void
  onAgir: (id: number, action: string, extra?: any) => void
}) {
  const st = STATUTS[i.statut] || STATUTS.nouveau
  const couleur = st.couleur === 'sub' ? t.sub : t.C[st.couleur]
  const p = i.extraction
  const incertitudes: string[] = i.incertitudes || []

  return (
    <div style={{ borderTop: `1px solid ${t.bdr}`, paddingTop: 14, marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <button onClick={onOuvrir} style={{
          flex: 1, minWidth: 260, textAlign: 'left', cursor: 'pointer',
          background: 'none', border: 'none', padding: 0, color: 'inherit',
        }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: t.dark ? '#e8eaed' : '#202124' }}>
            {p?.nom || i.nom_fichier || i.objet || `Import #${i.id}`}
          </div>
          <div style={{ fontSize: 11.5, color: t.sub, marginTop: 3 }}>
            {i.fournisseur_annonce || '—'}
            {i.nom_fichier && ` · ${i.nom_fichier}`}
            {p?.paliers?.length ? ` · ${p.paliers.length} paliers` : ''}
            {p?.bonus?.length ? ` · ${p.bonus.length} bonus` : ''}
          </div>
        </button>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {incertitudes.length > 0 && i.statut === 'a_valider' && (
            <Badge t={t} couleur={t.C.yellow}>{incertitudes.length} point{incertitudes.length > 1 ? 's' : ''} a verifier</Badge>
          )}
          <Badge t={t} couleur={couleur}>{st.label}</Badge>
        </div>
      </div>

      {ouvert && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

          {i.statut === 'erreur' && (
            <Message t={t} type="err">{i.erreur || 'Extraction impossible.'}</Message>
          )}

          {i.statut === 'lien_seulement' && (
            <Message t={t} type="info">
              Ce courriel renvoie vers un portail concessionnaire — la grille n'y est pas.
              {i.liens_portail?.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  {i.liens_portail.map((l: string, k: number) => (
                    <li key={k} style={{ wordBreak: 'break-all' }}>{l}</li>
                  ))}
                </ul>
              )}
              <div style={{ marginTop: 8 }}>
                Telecharge le formulaire depuis le portail et depose-le ici.
              </div>
            </Message>
          )}

          {/* Ce dont le modele n'est pas sur : la premiere chose a lire. */}
          {incertitudes.length > 0 && (
            <div style={{
              padding: '12px 16px', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
              color: t.C.yellow, background: `${t.C.yellow}14`, border: `1px solid ${t.C.yellow}55`,
            }}>
              <strong>A verifier dans le document d'origine</strong>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {incertitudes.map((u, k) => <li key={k}>{u}</li>)}
              </ul>
            </div>
          )}

          {p && (
            <>
              {/* Le rapprochement fournisseur : sans lui, rien ne marche. */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, display: 'block', marginBottom: 5, color: t.dark ? '#e8eaed' : '#202124' }}>
                    Fournisseur dans l'ERP
                  </label>
                  <select defaultValue={i.fournisseur_traction || ''}
                    onChange={e => e.target.value && onAgir(i.id, 'fournisseur', { fournisseur_traction: e.target.value })}
                    style={{
                      width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
                      border: `1px solid ${i.fournisseur_traction ? t.bdr : t.C.red}`,
                      background: t.dark ? '#202124' : '#fff', color: t.dark ? '#e8eaed' : '#202124',
                    }}>
                    <option value="">— a rapprocher —</option>
                    {fournisseurs.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <p style={{ fontSize: 11, color: t.sub, margin: '5px 0 0', lineHeight: 1.5 }}>
                    Le document dit « {i.fournisseur_annonce || '?'} ». Ton choix est memorise :
                    la question ne se reposera plus pour ce fournisseur.
                  </p>
                </div>
              </div>

              <FicheProgramme t={t} p={p} />

              {i.statut === 'a_valider' && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button onClick={() => onAgir(i.id, 'valider')} style={bouton(t, t.C.green)}>
                    Valider et creer le programme
                  </button>
                  <button onClick={() => onAgir(i.id, 'rejeter')} style={bouton(t, t.sub)}>
                    Classer sans suite
                  </button>
                </div>
              )}

              {i.statut === 'valide' && (
                <Message t={t} type="ok">
                  Programme actif (#{i.programme_id}). Il apparait dans la liste des programmes ci-dessus.
                </Message>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** La grille extraite, telle qu'elle sera enregistree. */
function FicheProgramme({ t, p }: { t: Theme; p: any }) {
  const paliers: any[] = p.paliers || []
  const baremes = [...new Set(paliers.map(x => x.bareme))]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, fontSize: 12.5 }}>
        <Info t={t} label="Ouvre le"     valeur={fmtDate(p.ouvre_le)} />
        <Info t={t} label="Ferme le"     valeur={fmtDate(p.ferme_le)} />
        <Info t={t} label="Livraison"    valeur={fmtDate(p.livraison_debut)} />
        <Info t={t} label="Min. commande" valeur={fmtArgent(p.min_commande)} />
        <Info t={t} label="Franco de port" valeur={fmtArgent(p.franco_seuil)} />
        <Info t={t} label="Baremes"      valeur={`${baremes.length} · ${p.baremes_exclusifs ? 'par categorie' : 'cumulables'}`} />
      </div>

      {paliers.length > 0 && (
        <div style={{ overflowX: 'auto', maxHeight: 380, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <Th t={t} align="left">Bareme</Th>
                <Th t={t} align="left">Niveau</Th>
                <Th t={t}>Seuil</Th>
                <Th t={t}>Escompte</Th>
                <Th t={t} align="left">Paiement</Th>
              </tr>
            </thead>
            <tbody>
              {paliers.map((pl, k) => (
                <tr key={k} style={{ borderTop: `1px solid ${t.bdr}` }}>
                  <td style={{ padding: '6px 8px' }}>
                    {pl.bareme}
                    {pl.axe !== 'tout' && <span style={{ color: t.sub, fontSize: 11 }}> · {pl.axe}</span>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{pl.niveau || '—'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {pl.seuil_qte != null ? `${pl.seuil_qte} u` : fmtArgent(pl.seuil_montant)}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700, color: t.C.green }}>
                    {pl.escompte_pct} %
                  </td>
                  <td style={{ padding: '6px 8px', fontSize: 11, color: t.sub }}>
                    {pl.echeancier?.length
                      ? pl.echeancier.map((e: any) => `${Math.round(e.part * 100)} % a ${e.jours} j`).join(' + ')
                      : '—'}
                    {pl.sous_minimums?.length > 0 && (
                      <div style={{ color: t.C.yellow }}>
                        dont {pl.sous_minimums.map((s: any) => `${fmtArgent(s.montant)} de ${s.libelle || s.cible?.join(', ')}`).join(' et ')}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {p.bonus?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
          {p.bonus.map((b: any, k: number) => (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <Badge t={t} couleur={t.C.blue}>{b.valeur_pct} %</Badge>
              <span>{b.libelle}</span>
              {b.avant_le && <span style={{ color: t.sub }}>· avant le {fmtDate(b.avant_le)}</span>}
            </div>
          ))}
        </div>
      )}

      {p.notes && (
        <p style={{ fontSize: 12, color: t.sub, lineHeight: 1.6, margin: 0 }}>{p.notes}</p>
      )}
    </div>
  )
}

function Info({ t, label, valeur }: { t: Theme; label: string; valeur: string }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: t.sub }}>{label}</div>
      <div style={{ fontWeight: 700, marginTop: 2 }}>{valeur}</div>
    </div>
  )
}

function boutonPlat(t: Theme, couleur: string, disabled = false): any {
  return {
    padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
    cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.6 : 1,
    border: `1px solid ${t.bdr}`, background: 'transparent', color: couleur,
  }
}

function bouton(t: Theme, couleur: string): any {
  return {
    padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${couleur}`, background: `${couleur}1f`, color: couleur,
  }
}
