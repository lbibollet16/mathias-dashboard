'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Aged inventory monitor — lists every FBA SKU sitting in Amazon's
 * warehouses past the 181-day Aged Inventory Surcharge threshold.
 *
 * Reading the page : the deadline banner tells the operator how many
 * days until Amazon's monthly evaluation (15th of each month) — every
 * removal/discount taken before the 14th stops the surcharge for that
 * row this month. Rows are sorted with worst urgency first.
 */

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface AtRiskRow {
  sku: string;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  qty_total: number | null;
  qty_181_to_270_days: number;
  qty_271_to_365_days: number;
  qty_365_plus_days: number;
  qty_at_risk: number;
  urgency: 'monitor' | 'discount' | 'remove';
  recommended_action: string | null;
  recommended_sales_price: number | null;
  estimated_30d_cost: number;
}

interface AtRiskResponse {
  ok: boolean;
  snapshot_date: string | null;
  days_until_deadline?: number;
  deadline_note?: string;
  total_at_risk_skus: number;
  total_units_at_risk: number;
  total_estimated_30d_cost: number;
  rows: AtRiskRow[];
  message?: string;
  error?: string;
}

export default function AgingPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [data, setData] = useState<AtRiskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterUrgency, setFilterUrgency] = useState<'all' | 'monitor' | 'discount' | 'remove'>('all');

  useEffect(() => {
    supabaseCli.auth.getSession().then(({ data }) => {
      setAuthChecked(true);
      if (!data.session) window.location.href = '/login?next=/amazon-sp-api/aging';
      else setAuthed(true);
    });
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/amazon/aging/at-risk');
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/amazon/sp-api/aging-sync', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (authed) void load();
  }, [authed]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    if (filterUrgency === 'all') return data.rows;
    return data.rows.filter((r) => r.urgency === filterUrgency);
  }, [data, filterUrgency]);

  if (!authChecked || !authed) return null;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)',
        padding: 24,
        fontFamily: "'DM Sans', sans-serif",
        color: '#e2e8f0',
      }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => (window.location.href = '/amazon-sp-api')}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#cbd5e1',
              padding: '6px 12px',
              borderRadius: 8,
              fontSize: 12,
              cursor: 'pointer',
              marginBottom: 12,
            }}
          >
            ← retour /amazon-sp-api
          </button>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 6px 0' }}>
            ⏳ Aged inventory — surcharges Amazon à éviter
          </h1>
          <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
            Snapshot {data?.snapshot_date ?? '— pas encore sync'}. La surcharge
            d&apos;inventaire âgé est évaluée le 15 de chaque mois. Une removal
            order ou un sale flash AVANT le 14 stoppe la facture pour le mois.
          </p>
        </div>

        {data?.deadline_note && (
          <div
            style={{
              padding: 14,
              marginBottom: 16,
              borderRadius: 12,
              background:
                (data.days_until_deadline ?? 30) <= 5
                  ? 'rgba(220, 38, 38, 0.2)'
                  : 'rgba(245, 158, 11, 0.15)',
              border:
                (data.days_until_deadline ?? 30) <= 5
                  ? '1px solid rgba(220,38,38,0.5)'
                  : '1px solid rgba(245, 158, 11, 0.5)',
              fontSize: 13,
              color: (data.days_until_deadline ?? 30) <= 5 ? '#fecaca' : '#fde68a',
            }}
          >
            🗓 {data.deadline_note}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <KpiCard
            label="SKUs à risque"
            value={String(data?.total_at_risk_skus ?? 0)}
            color="#fcd34d"
          />
          <KpiCard
            label="Unités totales à risque"
            value={String(data?.total_units_at_risk ?? 0)}
            color="#fb923c"
          />
          <KpiCard
            label="Coût stockage 30j estimé"
            value={(data?.total_estimated_30d_cost ?? 0).toFixed(2) + ' CAD'}
            color="#f87171"
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <button onClick={runSync} disabled={syncing} style={primaryBtn}>
            {syncing ? '⏳ Sync en cours…' : '🔄 Refresh snapshot SP-API'}
          </button>
          <button onClick={load} disabled={loading} style={secondaryBtn}>
            {loading ? '…' : '🔃 Recharger la liste'}
          </button>
          <div style={{ flex: 1 }} />
          {(['all', 'remove', 'discount', 'monitor'] as const).map((u) => (
            <button
              key={u}
              onClick={() => setFilterUrgency(u)}
              style={{
                ...secondaryBtn,
                background:
                  filterUrgency === u ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.06)',
              }}
            >
              {u === 'all'
                ? `Tous (${data?.rows.length ?? 0})`
                : u === 'remove'
                  ? `🔴 Remove (${data?.rows.filter((r) => r.urgency === 'remove').length ?? 0})`
                  : u === 'discount'
                    ? `🟠 Discount (${data?.rows.filter((r) => r.urgency === 'discount').length ?? 0})`
                    : `🟡 Monitor (${data?.rows.filter((r) => r.urgency === 'monitor').length ?? 0})`}
            </button>
          ))}
        </div>

        {error && (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: 'rgba(220,38,38,0.2)',
              border: '1px solid rgba(220,38,38,0.5)',
              color: '#fecaca',
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            ✗ {error}
          </div>
        )}

        {data && data.rows.length === 0 && (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: '#94a3b8',
              background: 'rgba(15,23,42,0.5)',
              borderRadius: 12,
            }}
          >
            ✅ Aucun SKU à risque actuellement.{' '}
            {data.message ?? 'Tu peux respirer pour cette évaluation Amazon.'}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filteredRows.map((r) => (
            <AgingRow key={r.sku} r={r} />
          ))}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 200,
        padding: 14,
        background: 'rgba(15,23,42,0.6)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 10,
      }}
    >
      <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function AgingRow({ r }: { r: AtRiskRow }) {
  const urgencyColor =
    r.urgency === 'remove' ? '#f87171' : r.urgency === 'discount' ? '#fb923c' : '#fcd34d';
  const urgencyLabel = r.urgency === 'remove' ? '🔴 Remove' : r.urgency === 'discount' ? '🟠 Discount' : '🟡 Monitor';

  function openAmazon() {
    if (!r.asin) return;
    window.open(`https://www.amazon.ca/dp/${r.asin}`, '_blank');
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr 90px 90px 90px 110px 130px 100px',
        gap: 8,
        padding: 10,
        background: 'rgba(15,23,42,0.6)',
        border: `1px solid ${urgencyColor}40`,
        borderRadius: 8,
        fontSize: 11,
        alignItems: 'center',
      }}
    >
      <span style={{ fontWeight: 700, color: urgencyColor, fontSize: 12 }}>{urgencyLabel}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{r.sku}</div>
        {r.product_name && (
          <div style={{ color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {r.product_name}
          </div>
        )}
      </div>
      <div style={{ textAlign: 'center', color: r.qty_181_to_270_days > 0 ? '#fcd34d' : '#475569' }}>
        <div style={{ fontSize: 9 }}>181-270j</div>
        <div style={{ fontWeight: 700 }}>{r.qty_181_to_270_days || '·'}</div>
      </div>
      <div style={{ textAlign: 'center', color: r.qty_271_to_365_days > 0 ? '#fb923c' : '#475569' }}>
        <div style={{ fontSize: 9 }}>271-365j</div>
        <div style={{ fontWeight: 700 }}>{r.qty_271_to_365_days || '·'}</div>
      </div>
      <div style={{ textAlign: 'center', color: r.qty_365_plus_days > 0 ? '#f87171' : '#475569' }}>
        <div style={{ fontSize: 9 }}>365j+</div>
        <div style={{ fontWeight: 700 }}>{r.qty_365_plus_days || '·'}</div>
      </div>
      <div style={{ textAlign: 'center', color: '#94a3b8' }}>
        Stock {r.qty_total ?? '?'} u
      </div>
      <div style={{ fontSize: 10, color: '#94a3b8' }}>
        {r.recommended_action ? (
          <span title={r.recommended_action}>{r.recommended_action.slice(0, 24)}</span>
        ) : (
          <span style={{ color: '#475569' }}>—</span>
        )}
      </div>
      <button
        onClick={openAmazon}
        disabled={!r.asin}
        style={{
          ...secondaryBtn,
          padding: '4px 8px',
          fontSize: 10,
          opacity: r.asin ? 1 : 0.4,
        }}
      >
        Voir Amazon
      </button>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  background: 'rgba(245, 158, 11, 0.85)',
  border: 'none',
  color: '#0f172a',
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};
const secondaryBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.2)',
  color: '#e2e8f0',
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  cursor: 'pointer',
};
