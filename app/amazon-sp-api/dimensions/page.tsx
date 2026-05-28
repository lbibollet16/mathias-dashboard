'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Dimensions audit page — compares the dimensions Amazon has on file
 * (Catalog API) to the actual dimensions we measured. Flags SKUs where
 * Amazon's number is materially larger (>10% volume or >15% weight),
 * generates a cubiscan-remeasure case template per flagged SKU.
 *
 * Operator flow :
 *   1. Click "🔄 Sync depuis Catalog API" → populates amazon_* dims
 *   2. Upload CSV (or paste manually) the actual measured dimensions
 *      via the "📥 Importer dimensions réelles" panel
 *   3. The "Discrepancies à disputer" list refreshes automatically
 *   4. For each row, "📋 Copier le case body" + "🔗 Seller Central"
 */

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface FlaggedRow {
  sku: string;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  actual_length_cm: number | null;
  actual_width_cm: number | null;
  actual_height_cm: number | null;
  actual_weight_kg: number | null;
  amazon_length_cm: number | null;
  amazon_width_cm: number | null;
  amazon_height_cm: number | null;
  amazon_weight_kg: number | null;
  amazon_size_tier: string | null;
  discrepancy_volume_pct: number | null;
  discrepancy_weight_pct: number | null;
  cubiscan_requested_at: string | null;
  cubiscan_resolved_at: string | null;
  request: {
    case_subject: string;
    case_body: string;
    seller_central_url: string;
  };
}

interface FlaggedResponse {
  ok: boolean;
  total_flagged: number;
  rows: FlaggedRow[];
  missing_actual: Array<{ sku: string; asin: string | null; product_name: string | null }>;
}

export default function DimensionsPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<FlaggedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<unknown>(null);

  useEffect(() => {
    supabaseCli.auth.getSession().then(({ data }) => {
      setAuthChecked(true);
      if (!data.session) window.location.href = '/login?next=/amazon-sp-api/dimensions';
      else setAuthed(true);
    });
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/amazon/dimensions/flagged?include_missing=true');
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

  async function runAmazonSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/amazon/dimensions/sync-amazon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 200, only_missing: false }),
      });
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

  async function importCsv() {
    // Parse simple CSV: sku,length_cm,width_cm,height_cm,weight_kg[,asin][,fnsku]
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return;
    const headerCols = lines[0].split(',').map((s) => s.trim().toLowerCase());
    const isHeader = headerCols.includes('sku') && headerCols.includes('length_cm');
    const startAt = isHeader ? 1 : 0;
    const rows = [];
    for (let i = startAt; i < lines.length; i++) {
      const cells = lines[i].split(',').map((s) => s.trim());
      const get = (col: string) => {
        if (isHeader) {
          const idx = headerCols.indexOf(col.toLowerCase());
          return idx >= 0 ? cells[idx] : undefined;
        }
        // Positional fallback : sku,length,width,height,weight,asin,fnsku
        const map: Record<string, number> = {
          sku: 0,
          actual_length_cm: 1,
          actual_width_cm: 2,
          actual_height_cm: 3,
          actual_weight_kg: 4,
          asin: 5,
          fnsku: 6,
        };
        return cells[map[col] ?? -1];
      };
      const sku = get('sku');
      if (!sku) continue;
      rows.push({
        sku,
        asin: get('asin') || undefined,
        fnsku: get('fnsku') || undefined,
        actual_length_cm: Number(get('actual_length_cm') ?? get('length_cm')),
        actual_width_cm: Number(get('actual_width_cm') ?? get('width_cm')),
        actual_height_cm: Number(get('actual_height_cm') ?? get('height_cm')),
        actual_weight_kg: Number(get('actual_weight_kg') ?? get('weight_kg')),
      });
    }
    if (rows.length === 0) {
      setError('CSV parsing : aucune ligne valide. Format attendu : sku,length_cm,width_cm,height_cm,weight_kg');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch('/api/amazon/dimensions/import-actual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'csv_import', rows }),
      });
      const body = await res.json();
      setImportResult(body);
      if (!body.ok && body.error) setError(body.error);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    if (authed) void load();
  }, [authed]);

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
            📐 Dimensions audit — fees Amazon gonflés
          </h1>
          <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
            Compare ce qu&apos;Amazon a mesuré (via Catalog API) à nos
            dimensions réelles. Discrepancy &gt; +10% volume = Cubiscan
            remeasure request éligible. Amazon ré-évalue 2× par 30 jours
            par SKU, et tu récupères les overcharges des 90 derniers jours
            si tu prouves la sur-mesure.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button onClick={runAmazonSync} disabled={syncing} style={primaryBtn}>
            {syncing ? '⏳ Sync Catalog API…' : '🔄 Sync dimensions Amazon'}
          </button>
          <button onClick={load} disabled={loading} style={secondaryBtn}>
            🔃 Recharger
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ alignSelf: 'center', color: '#94a3b8', fontSize: 12 }}>
            🔴 {data?.total_flagged ?? 0} flaggés · 🟡{' '}
            {data?.missing_actual?.length ?? 0} sans actual dim
          </span>
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

        {/* CSV import panel */}
        <details
          style={{
            marginBottom: 16,
            background: 'rgba(15,23,42,0.6)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            padding: 14,
          }}
        >
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            📥 Importer dimensions réelles (CSV)
          </summary>
          <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
            Colle un CSV format <code>sku,length_cm,width_cm,height_cm,weight_kg</code>{' '}
            (header optionnel). Une ligne par SKU.
          </p>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={'sku,length_cm,width_cm,height_cm,weight_kg\nFBA-260621,25.5,12.3,8,0.45\nFBA-073647,30,20,15,1.2'}
            style={{
              width: '100%',
              minHeight: 120,
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 8,
              color: '#cbd5e1',
              fontFamily: 'monospace',
              fontSize: 12,
              padding: 8,
              marginTop: 8,
            }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button onClick={importCsv} disabled={importing || !csvText.trim()} style={primaryBtn}>
              {importing ? '⏳ Import…' : '⬆ Importer'}
            </button>
            {importResult && (
              <pre style={{ fontSize: 11, color: '#a5f3fc', flex: 1, margin: 0, overflow: 'auto', maxHeight: 100 }}>
                {JSON.stringify(importResult, null, 2)}
              </pre>
            )}
          </div>
        </details>

        {/* Flagged rows */}
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '24px 0 12px 0' }}>
          🔴 SKUs flaggés pour Cubiscan
        </h2>
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
            Aucun SKU au-delà du seuil de discrepancy. Soit les dimensions
            Amazon matchent les nôtres, soit la table actual_* n&apos;est
            pas encore peuplée (importe ton CSV ci-dessus).
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data?.rows.map((r) => <FlaggedCard key={r.sku} r={r} />)}
        </div>

        {/* Missing actual dims */}
        {(data?.missing_actual?.length ?? 0) > 0 && (
          <details style={{ marginTop: 24 }}>
            <summary style={{ cursor: 'pointer', fontSize: 14, color: '#fcd34d' }}>
              🟡 {data?.missing_actual.length} SKUs sans actual dim (importe ton CSV pour les chiffrer)
            </summary>
            <pre
              style={{
                marginTop: 8,
                background: 'rgba(0,0,0,0.4)',
                padding: 10,
                fontSize: 11,
                fontFamily: 'monospace',
                color: '#cbd5e1',
                borderRadius: 8,
                maxHeight: 300,
                overflow: 'auto',
              }}
            >
              {(data?.missing_actual ?? [])
                .map(
                  (m) =>
                    `${m.sku}\t${m.asin ?? ''}\t${(m.product_name ?? '').slice(0, 60)}`,
                )
                .join('\n')}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function FlaggedCard({ r }: { r: FlaggedRow }) {
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      const orig = document.title;
      document.title = '✅ ' + label + ' copié';
      setTimeout(() => (document.title = orig), 1500);
    } catch {
      window.prompt('Copier manuellement (' + label + ') :', text);
    }
  }

  return (
    <div
      style={{
        padding: 12,
        background: 'rgba(15,23,42,0.6)',
        border: '1px solid rgba(248, 113, 113, 0.4)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#cbd5e1', minWidth: 130 }}>
          {r.sku}
        </span>
        <span style={{ fontSize: 11, color: '#64748b', flex: 1 }}>
          {r.product_name?.slice(0, 60) ?? '?'}
        </span>
        <span style={{ fontSize: 11, color: '#fcd34d', minWidth: 100 }}>
          {r.amazon_size_tier ?? '?'}
        </span>
        <span style={{ fontSize: 14, color: '#f87171', fontWeight: 700 }}>
          +{r.discrepancy_volume_pct?.toFixed(1) ?? '?'}% vol
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          fontSize: 11,
          fontFamily: 'monospace',
          color: '#94a3b8',
          marginBottom: 8,
        }}
      >
        <div>
          <strong>Actual :</strong> {r.actual_length_cm}×{r.actual_width_cm}×
          {r.actual_height_cm}cm · {r.actual_weight_kg}kg
        </div>
        <div>
          <strong>Amazon :</strong> {r.amazon_length_cm}×{r.amazon_width_cm}×
          {r.amazon_height_cm}cm · {r.amazon_weight_kg}kg
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => copy(r.request.case_subject, 'Subject')} style={secondaryBtn}>
          📋 Subject
        </button>
        <button onClick={() => copy(r.request.case_body, 'Body')} style={secondaryBtn}>
          📋 Body
        </button>
        <a
          href={r.request.seller_central_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...primaryBtn, textDecoration: 'none' }}
        >
          🔗 Ouvrir Seller Central
        </a>
        {r.cubiscan_requested_at && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#86efac' }}>
            ✅ demandé {r.cubiscan_requested_at.slice(0, 10)}
          </span>
        )}
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  background: 'rgba(245, 158, 11, 0.85)',
  border: 'none',
  color: '#0f172a',
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};
const secondaryBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.2)',
  color: '#e2e8f0',
  padding: '4px 10px',
  borderRadius: 8,
  fontSize: 11,
  cursor: 'pointer',
};
