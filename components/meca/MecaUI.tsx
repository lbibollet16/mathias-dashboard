'use client'

// Briques d'UI partagées du module méca.
//
// Tout est en styles inline et reçoit les tokens de thème du dashboard
// (dark / card / bdr / sub / thBg / hvr / C) plutôt que des couleurs codées en
// dur : c'est la convention du reste du site, et c'est ce qui fait fonctionner
// le mode sombre.

export interface Theme {
  dark: boolean
  card: string
  bdr:  string
  sub:  string
  thBg: string
  hvr:  string
  C:    { blue: string, green: string, yellow: string, red: string }
}

// Titre de section, aligné sur les autres onglets.
export function SectionTitre({ t, titre, aide }: { t: Theme, titre: string, aide?: string }) {
  return (
    <>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: t.C.blue, margin: 0 }}>{titre}</h3>
      {aide && <p style={{ fontSize: 12, color: t.sub, margin: '4px 0 0', lineHeight: 1.5 }}>{aide}</p>}
    </>
  )
}

export function Carte({ t, children, style }: { t: Theme, children: any, style?: any }) {
  return (
    <div style={{ background: t.card, border: `1px solid ${t.bdr}`, borderRadius: 12, padding: 18, ...style }}>
      {children}
    </div>
  )
}

export function KpiCard({ t, label, value, warn }: { t: Theme, label: string, value: string, warn?: boolean }) {
  return (
    <div style={{
      background: t.card,
      border: `1px solid ${warn ? t.C.red : t.bdr}`,
      borderRadius: 10,
      padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: t.sub }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: warn ? t.C.red : (t.dark ? '#e8eaed' : '#202124'), marginTop: 4 }}>
        {value}
      </div>
    </div>
  )
}

export function GrilleKpi({ children, min = 200 }: { children: any, min?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 14 }}>
      {children}
    </div>
  )
}

// Curseur horizontal. Les seuils sont exprimés en valeur, pas en %.
export function Gauge({ t, label, value, maxValue, unit = '', couleur }:
  { t: Theme, label: string, value: number, maxValue: number, unit?: string, couleur?: string }) {
  const safeMax = maxValue > 0 ? maxValue : 1
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100))
  const col = couleur ?? (pct <= 60 ? t.C.green : pct <= 85 ? t.C.yellow : t.C.red)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12.5, color: t.sub, fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: col }}>
          {value.toLocaleString('fr-CA')}{unit}
        </span>
      </div>
      <div style={{
        position: 'relative', height: 10, borderRadius: 6,
        background: t.dark ? '#111' : '#eef1f5',
        border: `1px solid ${t.bdr}`, overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct}%`, background: col, borderRadius: 6, transition: 'width .4s ease',
        }} />
      </div>
    </div>
  )
}

// Classement en barres horizontales. Remplace le graphique recharts du projet
// source : même lecture (qui porte le département), sans ajouter de librairie
// de graphiques au dashboard — et le rendu suit le thème.
export function BarresHorizontales({ t, items, format, onClick, selectedId }: {
  t: Theme
  items: { id: string, label: string, valeur: number }[]
  format: (v: number) => string
  onClick?: (id: string) => void
  selectedId?: string | null
}) {
  const max = Math.max(1, ...items.map(i => i.valeur))
  if (items.length === 0) {
    return <div style={{ padding: 16, textAlign: 'center', color: t.sub, fontSize: 13 }}>Aucune donnée.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map(i => {
        const actif = selectedId === i.id
        return (
          <div
            key={i.id}
            onClick={onClick ? () => onClick(i.id) : undefined}
            style={{ cursor: onClick ? 'pointer' : 'default' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ fontSize: 12.5, fontWeight: actif ? 700 : 500, color: actif ? t.C.blue : (t.dark ? '#e8eaed' : '#202124') }}>
                {i.label}
              </span>
              <span style={{ fontSize: 12.5, fontFamily: 'monospace', color: t.sub }}>{format(i.valeur)}</span>
            </div>
            <div style={{ height: 12, borderRadius: 6, background: t.dark ? '#111' : '#eef1f5', border: `1px solid ${t.bdr}`, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(0, (i.valeur / max) * 100)}%`,
                height: '100%', background: t.C.blue, opacity: actif ? 1 : 0.75,
                transition: 'width .4s ease',
              }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function Th({ t, children, align = 'right' }: { t: Theme, children: any, align?: 'left' | 'right' | 'center' }) {
  return (
    <th style={{
      padding: '9px 12px', textAlign: align, fontSize: 10.5, textTransform: 'uppercase',
      letterSpacing: '0.05em', color: t.sub, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  )
}

export function ThTriable({ t, label, colonne, actif, dir, onSort, align = 'right' }: {
  t: Theme, label: string, colonne: string, actif: string, dir: 'asc' | 'desc',
  onSort: (k: any) => void, align?: 'left' | 'right'
}) {
  const on = actif === colonne
  return (
    <th
      onClick={() => onSort(colonne)}
      style={{
        padding: '9px 12px', textAlign: align, fontSize: 10.5, textTransform: 'uppercase',
        letterSpacing: '0.05em', color: on ? t.C.blue : t.sub, fontWeight: on ? 700 : 600,
        cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
      }}
    >
      {label}{on && (dir === 'asc' ? ' ▲' : ' ▼')}
    </th>
  )
}

export function Badge({ t, children, couleur }: { t: Theme, children: any, couleur: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700,
      color: couleur, background: `${couleur}1f`, border: `1px solid ${couleur}55`, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}

export function Message({ t, type, children }: { t: Theme, type: 'info' | 'ok' | 'err', children: any }) {
  const col = type === 'err' ? t.C.red : type === 'ok' ? t.C.green : t.C.blue
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.5,
      color: col, background: `${col}14`, border: `1px solid ${col}55`,
    }}>
      {children}
    </div>
  )
}

export const fmtArgent = (v: number) =>
  v.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $'

export const fmtArgentCourt = (v: number) =>
  Math.round(v).toLocaleString('fr-CA') + ' $'
