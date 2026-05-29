'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Dispute Reimbursements — page de récupération rétroactive des
 * remboursements sous-payés par Amazon.
 *
 * Pour chaque row, on génère un template "Submit a reimbursement claim
 * dispute" (le path Seller Central qui DEMANDE explicitement le
 * Reimbursement ID). On cite la politique cost basis mars 2025 et on
 * réclame le différentiel entre ce qu'Amazon a payé et ce que notre
 * nouveau cost indiquerait.
 *
 * Différence avec /amazon-sp-api/claims :
 *   - /claims    → events damaged où Amazon n'a JAMAIS payé
 *   - /dispute   → reimbursements où Amazon a payé MOINS que notre cost
 */

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface UnderpaidRow {
  id: number;
  reimbursement_id: string | null;
  approval_date: string | null;
  age_days: number | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  product_name: string | null;
  amazon_order_id: string | null;
  reason: string | null;
  quantity: number;
  amount_paid: number;
  unit_cost_new: number;
  expected_amount: number;
  uplift_cad: number;
  within_90d: boolean;
}

interface ListResponse {
  ok: boolean;
  total_count: number;
  total_uplift_cad: number;
  within_90d_count: number;
  within_90d_uplift_cad: number;
  candidates: UnderpaidRow[];
}

export default function DisputePage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterWithinDays, setFilterWithinDays] = useState(90);
  const [filterMinUplift, setFilterMinUplift] = useState(1);
  const [workflowIndex, setWorkflowIndex] = useState<number | null>(null);

  useEffect(() => {
    supabaseCli.auth.getSession().then(({ data }) => {
      setAuthChecked(true);
      if (!data.session) {
        window.location.href = '/login?next=/amazon-sp-api/dispute-reimbursements';
      } else {
        setAuthed(true);
      }
    });
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        within_days: String(filterWithinDays),
        min_uplift: String(filterMinUplift),
        limit: '500',
      });
      const res = await fetch('/api/amazon/reimbursements/underpaid?' + qs.toString());
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

  useEffect(() => {
    if (authed) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, filterWithinDays, filterMinUplift]);

  const current = workflowIndex != null && data ? data.candidates[workflowIndex] : null;

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
          <button onClick={() => (window.location.href = '/amazon-sp-api')} style={backBtn}>
            ← retour /amazon-sp-api
          </button>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 6px 0' }}>
            ♻️ Dispute reimbursements sous-payés
          </h1>
          <p style={{ fontSize: 12, color: '#94a3b8', margin: 0, lineHeight: 1.6 }}>
            Reimbursements où Amazon a payé moins que ce que notre cost
            actuel indique. À soumettre via Seller Central →{' '}
            <strong>&laquo; Submit a reimbursement claim dispute &raquo;</strong> avec
            le Reimbursement ID. Fenêtre dispute fraîche = 90 jours, taux
            succès ~60% historique.
          </p>
        </div>

        {/* KPIs */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <Kpi
            label="Sous-payés détectés"
            value={String(data?.total_count ?? 0)}
            color="#fcd34d"
          />
          <Kpi
            label="🔥 Uplift potentiel total"
            value={(data?.total_uplift_cad ?? 0).toFixed(2) + ' CAD'}
            color="#fb923c"
          />
          <Kpi
            label="Dont 90j (fenêtre fraîche)"
            value={
              (data?.within_90d_count ?? 0) +
              ' cas · ' +
              (data?.within_90d_uplift_cad ?? 0).toFixed(2) +
              ' CAD'
            }
            color="#f87171"
          />
        </div>

        {/* Filtres */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            padding: 12,
            background: 'rgba(15,23,42,0.5)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10,
            marginBottom: 14,
            alignItems: 'center',
            fontSize: 12,
            flexWrap: 'wrap',
          }}
        >
          <label>
            Window jours :{' '}
            <select
              value={filterWithinDays}
              onChange={(e) => setFilterWithinDays(Number(e.target.value))}
              style={selectStyle}
              disabled={loading}
            >
              <option value={90}>90j (fresh, ~60% succès)</option>
              <option value={180}>180j</option>
              <option value={365}>1 an</option>
              <option value={540}>18 mois (tout)</option>
            </select>
          </label>
          <label>
            Min uplift CAD :{' '}
            <input
              type="number"
              min={0}
              step={1}
              value={filterMinUplift}
              onChange={(e) => setFilterMinUplift(Number(e.target.value))}
              style={{ ...selectStyle, width: 70 }}
              disabled={loading}
            />
          </label>
          <button onClick={load} disabled={loading} style={secondaryBtn}>
            🔃 Recharger
          </button>
          {loading && <span style={{ color: '#94a3b8' }}>chargement…</span>}
        </div>

        {/* Bandeau d'instruction Seller Central */}
        {!current && (
          <div
            style={{
              padding: 14,
              marginBottom: 14,
              background: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.35)',
              borderRadius: 10,
              fontSize: 12,
              color: '#fde68a',
              lineHeight: 1.6,
            }}
          >
            📍 <strong>Dans Seller Central</strong> : Help → Contact us →
            Selling on Amazon → cherche{' '}
            <strong>&laquo; Submit a reimbursement claim dispute &raquo;</strong>{' '}
            dans la liste. Le formulaire te demande un{' '}
            <strong>Reimbursement ID</strong> (qu&apos;on a) + upload de
            facture supplier. Click sur une row ci-dessous pour générer
            le template à coller.
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: 'rgba(220,38,38,0.2)',
              border: '1px solid rgba(220,38,38,0.5)',
              color: '#fecaca',
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            ✗ {error}
          </div>
        )}

        {/* Workflow mode */}
        {current && (
          <DisputeCard
            row={current}
            index={workflowIndex!}
            total={data!.candidates.length}
            onPrev={() =>
              setWorkflowIndex((i) => (i != null && i > 0 ? i - 1 : i))
            }
            onNext={() =>
              setWorkflowIndex((i) =>
                i != null && i < (data?.candidates.length ?? 0) - 1 ? i + 1 : i,
              )
            }
            onClose={() => setWorkflowIndex(null)}
          />
        )}

        {/* List mode */}
        {!current && data && data.candidates.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              onClick={() => setWorkflowIndex(0)}
              style={{ ...primaryBtn, fontSize: 14, padding: '12px 16px', marginBottom: 8 }}
            >
              🚀 Lancer le workflow ({data.candidates.length} disputes)
            </button>
            {data.candidates.map((r, i) => (
              <UnderpaidRow key={r.id} r={r} onClick={() => setWorkflowIndex(i)} />
            ))}
          </div>
        )}

        {!current && data && data.candidates.length === 0 && !loading && (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: '#94a3b8',
              background: 'rgba(15,23,42,0.5)',
              borderRadius: 12,
            }}
          >
            Aucun reimbursement sous-payé selon les filtres actuels.
            Élargis la fenêtre ou réduis min_uplift.
          </div>
        )}
      </div>
    </div>
  );
}

function UnderpaidRow({ r, onClick }: { r: UnderpaidRow; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 110px 120px 1fr 70px 90px 90px 90px',
        gap: 10,
        padding: 10,
        background: 'rgba(15,23,42,0.5)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 8,
        color: '#e2e8f0',
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 11,
        alignItems: 'center',
      }}
    >
      <span
        style={{
          padding: '2px 6px',
          background: r.within_90d ? 'rgba(34,197,94,0.2)' : 'rgba(148,163,184,0.15)',
          color: r.within_90d ? '#86efac' : '#cbd5e1',
          borderRadius: 4,
          textAlign: 'center',
          fontWeight: 700,
        }}
      >
        {r.age_days != null ? r.age_days + 'j' : '?'}
      </span>
      <span style={{ fontFamily: 'monospace', color: '#a5f3fc' }}>
        {r.reimbursement_id ?? '?'}
      </span>
      <span style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{r.asin ?? '?'}</span>
      <span style={{ color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {r.product_name ?? '?'}
      </span>
      <span style={{ textAlign: 'right', color: '#94a3b8' }}>×{r.quantity}</span>
      <span style={{ textAlign: 'right', color: '#cbd5e1' }}>{r.amount_paid.toFixed(2)}</span>
      <span style={{ textAlign: 'right', color: '#fcd34d', fontWeight: 700 }}>
        {r.expected_amount.toFixed(2)}
      </span>
      <span style={{ textAlign: 'right', color: '#86efac', fontWeight: 800 }}>
        +{r.uplift_cad.toFixed(2)}
      </span>
    </button>
  );
}

function DisputeCard({
  row,
  index,
  total,
  onPrev,
  onNext,
  onClose,
}: {
  row: UnderpaidRow;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const policyUrl = 'https://sellercentral.amazon.com/gp/help/external/G200213130';

  // Template du body — argumentaire cost basis + montant différentiel.
  const body = useMemo(
    () =>
      `Hello Amazon Support,

I am requesting a re-evaluation of the following reimbursement under the FBA inventory reimbursement policy of March 10, 2025 (${policyUrl}), which calculates reimbursements based on sourcing/manufacturing cost.

- Reimbursement ID: ${row.reimbursement_id ?? '(unknown)'}
- Approval Date: ${row.approval_date?.slice(0, 10) ?? '(unknown)'}
- ASIN: ${row.asin ?? '(unknown)'}
- SKU (seller): ${row.sku ?? '(unknown)'}
- FNSKU: ${row.fnsku ?? '(unknown)'}
- Reason: ${row.reason ?? '(unknown)'}
- Quantity reimbursed: ${row.quantity}
- Amount paid by Amazon: ${row.amount_paid.toFixed(2)} CAD
- Expected amount per current approved sourcing cost: ${row.unit_cost_new.toFixed(2)} CAD per unit × ${row.quantity} = ${row.expected_amount.toFixed(2)} CAD
- Differential to recover: ${row.uplift_cad.toFixed(2)} CAD

The sourcing cost reflected here has been updated via the Manage Sourcing Cost workflow to match actual supplier acquisition cost. Per the cost-basis policy, this reimbursement should be re-evaluated at the updated cost.

Supplier invoice for the affected SKU is available upon request.

Could you please re-evaluate this reimbursement and process the differential adjustment of ${row.uplift_cad.toFixed(2)} CAD?

Thank you,
Mathias Power Parts`,
    [row, policyUrl],
  );

  const references = useMemo(
    () =>
      [row.reimbursement_id, row.asin, row.fnsku, row.sku, row.amazon_order_id]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(', '),
    [row],
  );

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
        padding: 20,
        background: 'rgba(15,23,42,0.7)',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={onPrev} disabled={index === 0} style={secondaryBtn}>
          ← précédent
        </button>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
          Dispute {index + 1} / {total}
        </span>
        <button onClick={onClose} style={secondaryBtn}>
          ✕ retour à la liste
        </button>
        <button onClick={onNext} disabled={index === total - 1} style={secondaryBtn}>
          suivant →
        </button>
      </div>

      <div
        style={{
          padding: 12,
          background: 'rgba(0,0,0,0.3)',
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 12,
          fontFamily: 'monospace',
          color: '#a5f3fc',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span>Reimbursement ID : <strong>{row.reimbursement_id}</strong></span>
        <span>{row.asin}</span>
        <span>×{row.quantity}</span>
        <span>payé {row.amount_paid.toFixed(2)} CAD</span>
        <span style={{ marginLeft: 'auto', color: '#86efac', fontWeight: 700 }}>
          uplift +{row.uplift_cad.toFixed(2)} CAD
        </span>
      </div>

      <div
        style={{
          padding: 10,
          background: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          borderRadius: 8,
          fontSize: 11,
          color: '#fde68a',
          marginBottom: 14,
        }}
      >
        📍 Seller Central → Help → Contact us → Selling on Amazon →{' '}
        <strong>&laquo; Submit a reimbursement claim dispute &raquo;</strong>. Le
        formulaire va te demander le <strong>Reimbursement ID</strong>{' '}
        ci-dessous + upload facture supplier (optionnel).
      </div>

      <Section label="🆔 Reimbursement ID" text={row.reimbursement_id ?? ''} onCopy={() => copy(row.reimbursement_id ?? '', 'Reimbursement ID')} />
      <Section
        label="📋 Body du case (cost basis policy + différentiel)"
        text={body}
        onCopy={() => copy(body, 'Body')}
        multiline
      />
      <Section
        label="📋 Reference numbers"
        text={references}
        onCopy={() => copy(references, 'References')}
      />

      <a
        href="https://sellercentral.amazon.ca/help/center/contactus"
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block', marginTop: 12 }}
      >
        🔗 Ouvrir Seller Central
      </a>
    </div>
  );
}

function Section({
  label,
  text,
  onCopy,
  multiline,
}: {
  label: string;
  text: string;
  onCopy: () => void;
  multiline?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
        <button onClick={onCopy} style={{ ...secondaryBtn, marginLeft: 'auto', padding: '2px 10px' }}>
          📋 Copier
        </button>
      </div>
      <div
        style={{
          padding: 10,
          background: 'rgba(0,0,0,0.4)',
          borderRadius: 6,
          fontSize: 12,
          fontFamily: 'monospace',
          color: '#cbd5e1',
          whiteSpace: multiline ? 'pre-wrap' : 'normal',
          wordBreak: 'break-word',
          maxHeight: multiline ? 280 : undefined,
          overflow: 'auto',
        }}
      >
        {text}
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
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
      <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

const backBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.2)',
  color: '#cbd5e1',
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  cursor: 'pointer',
  marginBottom: 12,
};
const selectStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.4)',
  border: '1px solid rgba(255,255,255,0.2)',
  color: '#e2e8f0',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12,
  fontFamily: "'DM Sans', sans-serif",
};
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
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.2)',
  color: '#e2e8f0',
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  cursor: 'pointer',
};
