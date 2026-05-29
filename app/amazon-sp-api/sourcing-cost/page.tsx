'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Sourcing Cost Bulk Enricher — drag-drop the Amazon-downloaded XLSX,
 * server fills in our MPP costs in the "Seller New Cost" column,
 * sends back the enriched XLSX ready to upload back to Amazon.
 *
 * Flow :
 *   1. Operator downloads from Seller Central > Inventory > IDR Portal
 *      > Manage Sourcing Cost > Bulk Update > "Download sourcing cost"
 *   2. Operator drops that XLSX into this page
 *   3. Page POSTs to /api/amazon/sourcing-cost/enrich-xlsx
 *   4. Server pulls amazon_sku_costs, matches by ASIN/FNSKU, fills
 *      Seller New Cost whenever our cost is higher than Latest Approved
 *   5. Operator downloads the result, uploads to Amazon, hits Submit
 */

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface Summary {
  filled: number;
  skipped_no_cost_known: number;
  skipped_lower_or_equal: number;
  total_rows: number;
  sample_filled: Array<{ asin: string; approved: number; ourCost: number }>;
}

export default function SourcingCostPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [importSummary, setImportSummary] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabaseCli.auth.getSession().then(({ data }) => {
      setAuthChecked(true);
      if (!data.session) window.location.href = '/login?next=/amazon-sp-api/sourcing-cost';
      else setAuthed(true);
    });
  }, []);

  async function runImport() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setImportSummary(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/amazon/sourcing-cost/import-from-xlsx', {
        method: 'POST',
        body: fd,
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      setImportSummary(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runEnrich() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    setImportSummary(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/amazon/sourcing-cost/enrich-xlsx', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      // Parse summary header
      const summaryHeader = res.headers.get('X-Enrich-Summary');
      if (summaryHeader) {
        try {
          setSummary(JSON.parse(summaryHeader));
        } catch {
          /* ignore */
        }
      }
      // Force-download the enriched file
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sourcing-cost-enriched-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

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
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
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
            💰 Sourcing Cost Bulk Enricher
          </h1>
          <p style={{ fontSize: 12, color: '#94a3b8', margin: 0, lineHeight: 1.6 }}>
            Prend le XLSX <strong>&laquo; Download sourcing cost &raquo;</strong> téléchargé
            depuis Seller Central, le remplit avec nos vrais costs MPP
            (table <code>amazon_sku_costs</code>), te renvoie le fichier
            enrichi prêt à uploader.
          </p>
        </div>

        {/* Workflow guide */}
        <div
          style={{
            padding: 14,
            marginBottom: 20,
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            borderRadius: 10,
            fontSize: 12,
            color: '#fde68a',
            lineHeight: 1.6,
          }}
        >
          <strong>Procédure complète :</strong>
          <ol style={{ marginTop: 6, paddingLeft: 18 }}>
            <li>
              Sur Seller Central : <em>Inventory → Inventory Defect and
              Reimbursement → Manage Sourcing Cost → Bulk Update</em> →
              click <strong>Download sourcing cost</strong>
            </li>
            <li>Drop le XLSX téléchargé dans la zone ci-dessous</li>
            <li>Click <strong>Enrichir</strong> → download le fichier enrichi</li>
            <li>
              Retourne sur Seller Central même page, click{' '}
              <strong>Upload file</strong>, drop ton fichier enrichi
            </li>
            <li>
              Click <strong>Submit for review</strong> — Amazon traite
              en 1-5 jours business
            </li>
          </ol>
          ⚠️ Une fois soumis, lockout 30 jours par SKU. Vérifie bien le
          summary avant d&apos;uploader sur Amazon.
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
          style={{
            padding: 32,
            border: '2px dashed rgba(255,255,255,0.2)',
            borderRadius: 12,
            background: 'rgba(15,23,42,0.6)',
            textAlign: 'center',
            marginBottom: 16,
          }}
        >
          <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>
            Drag-drop le XLSX Amazon ici, ou :
          </p>
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{
              margin: '12px auto',
              display: 'block',
              color: '#cbd5e1',
            }}
          />
          {file && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#86efac' }}>
              ✓ {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
          <button
            onClick={runEnrich}
            disabled={!file || busy}
            style={{
              background: 'rgba(245, 158, 11, 0.85)',
              border: 'none',
              color: '#0f172a',
              padding: '10px 20px',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 700,
              cursor: file && !busy ? 'pointer' : 'not-allowed',
              opacity: file && !busy ? 1 : 0.5,
              flex: 2,
            }}
          >
            {busy ? '⏳ En cours…' : '✨ Enrichir + télécharger'}
          </button>
          <button
            onClick={runImport}
            disabled={!file || busy}
            title="Importe dans amazon_sku_costs les rows où Source=SELLER (= costs déjà soumis à Amazon dans le passé qu'on a perdus côté MPP). Élargit le référentiel pour les prochaines vagues d'enrichissement."
            style={{
              background: 'rgba(99, 102, 241, 0.85)',
              border: 'none',
              color: '#e2e8f0',
              padding: '10px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              cursor: file && !busy ? 'pointer' : 'not-allowed',
              opacity: file && !busy ? 1 : 0.5,
              flex: 1,
            }}
          >
            📥 Import-back vers MPP
          </button>
        </div>
        <p style={{ fontSize: 10, color: '#64748b', margin: '0 0 12px 0', lineHeight: 1.5 }}>
          <strong>Enrichir</strong> = fill Seller New Cost depuis MPP, te download le file enrichi.{' '}
          <strong>Import-back</strong> = scanne le file pour les costs déjà
          soumis à Amazon (src=SELLER) et les rajoute dans notre DB MPP.
          À faire 1× pour récupérer les ~225 ASINs hors-MPP.
        </p>

        {error && (
          <div
            style={{
              marginTop: 14,
              padding: 12,
              background: 'rgba(220,38,38,0.2)',
              border: '1px solid rgba(220,38,38,0.5)',
              color: '#fecaca',
              borderRadius: 10,
              fontSize: 13,
            }}
          >
            ✗ {error}
          </div>
        )}

        {summary && (
          <div
            style={{
              marginTop: 20,
              padding: 16,
              background: 'rgba(34, 197, 94, 0.1)',
              border: '1px solid rgba(34, 197, 94, 0.4)',
              borderRadius: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: '#86efac', marginBottom: 10 }}>
              ✅ Fichier enrichi téléchargé
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 10,
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Rows traitées</div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{summary.total_rows}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>✨ Costs mis à jour</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fcd34d' }}>
                  {summary.filled}
                </div>
              </div>
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Skip : cost inconnu</div>
                <div style={{ fontSize: 18, color: '#cbd5e1' }}>
                  {summary.skipped_no_cost_known}
                </div>
              </div>
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Skip : pas meilleur</div>
                <div style={{ fontSize: 18, color: '#cbd5e1' }}>
                  {summary.skipped_lower_or_equal}
                </div>
              </div>
            </div>

            {summary.sample_filled.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
                  Sample des updates (10 premiers) :
                </div>
                <table style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}>
                  <thead>
                    <tr style={{ color: '#94a3b8' }}>
                      <th style={{ textAlign: 'left' }}>ASIN</th>
                      <th style={{ textAlign: 'right' }}>Approved (Amazon)</th>
                      <th style={{ textAlign: 'right' }}>→ Our cost</th>
                      <th style={{ textAlign: 'right' }}>Δ %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.sample_filled.map((r) => {
                      const delta = r.approved > 0 ? ((r.ourCost - r.approved) / r.approved) * 100 : 0;
                      return (
                        <tr key={r.asin}>
                          <td>{r.asin}</td>
                          <td style={{ textAlign: 'right', color: '#cbd5e1' }}>
                            {r.approved.toFixed(2)}
                          </td>
                          <td style={{ textAlign: 'right', color: '#fcd34d', fontWeight: 700 }}>
                            {r.ourCost.toFixed(2)}
                          </td>
                          <td style={{ textAlign: 'right', color: '#86efac' }}>
                            +{delta.toFixed(0)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
              Le fichier <strong>sourcing-cost-enriched-{new Date().toISOString().slice(0, 10)}.xlsx</strong>{' '}
              vient d&apos;être téléchargé dans Downloads. Retourne sur
              Seller Central, click <strong>Upload file</strong>, choisis
              ce fichier, puis <strong>Submit for review</strong>.
            </p>
          </div>
        )}

        {importSummary && (
          <div
            style={{
              marginTop: 20,
              padding: 16,
              background: 'rgba(99, 102, 241, 0.12)',
              border: '1px solid rgba(99, 102, 241, 0.4)',
              borderRadius: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: '#a5b4fc', marginBottom: 10 }}>
              📥 Import-back terminé
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 10,
                fontSize: 13,
              }}
            >
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>✨ Importés dans MPP</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#a5b4fc' }}>
                  {String(importSummary.inserted ?? '?')}
                </div>
              </div>
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Skip : déjà en DB</div>
                <div style={{ fontSize: 18 }}>{String(importSummary.skipped_existing_in_db ?? '?')}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Skip : src=AMAZON (non SELLER)</div>
                <div style={{ fontSize: 18 }}>{String(importSummary.skipped_not_seller_source ?? '?')}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Skip : cost invalide</div>
                <div style={{ fontSize: 18 }}>{String(importSummary.skipped_zero_or_invalid ?? '?')}</div>
              </div>
            </div>
            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
              ✅ Notre référentiel <code>amazon_sku_costs</code> a été enrichi.
              Maintenant tu peux click <strong>✨ Enrichir + télécharger</strong> sur
              le même fichier (ou re-download depuis Amazon pour avoir un
              snapshot frais) — le prochain enrichissement aura accès à
              beaucoup plus de costs.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
