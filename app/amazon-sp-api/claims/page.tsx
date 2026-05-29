'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Claims workflow page — gives the operator a triage list of
 * `amazon_claim_candidates` and a guided, sequential workflow to file
 * them in Seller Central. Each card has copy-to-clipboard subject + body
 * and a button to open Seller Central in a new tab. When all cards in
 * the current selection are processed, the page marks them `sent` in DB.
 */

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface ClaimCandidate {
  id: number;
  ledger_event_id: number;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  event_date: string;
  event_type: string;
  quantity: number;
  fulfillment_center: string | null;
  reference_id: string | null;
  estimated_unit_price: number | null;
  estimated_amount: number | null;
  days_since_event: number | null;
  eligible_to_claim: boolean;
  status: string;
  claim_payload: {
    // Amazon "My issue is not listed" form a 4 fields ; on en pré-remplit
    // 3 (le 4e étant Upload Files qu'on laisse vide pour la 1re vague).
    amazon_field1_what_help?: string;
    amazon_field2_steps_taken?: string;
    amazon_field3_references?: string;
    // Legacy — utilisé seulement pour identifier le case dans la liste.
    case_subject?: string;
    case_body?: string;
    seller_central_url?: string;
    policy_url?: string;
    suggested_navigation?: string;
    // Métadonnées de scoring (depuis l'extension VendorReturns/CustomerReturns)
    confidence?: 'high' | 'medium' | 'low';
    source_event_type?: string;
  } | null;
  sent_at: string | null;
  amazon_case_id: string | null;
}

type FilterStatus = 'pending' | 'sent' | 'paid' | 'all';
type FilterConfidence = 'high' | 'high+medium' | 'all';

export default function ClaimsPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<ClaimCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [totalCAD, setTotalCAD] = useState(0);

  const [filterStatus, setFilterStatus] = useState<FilterStatus>('pending');
  const [filterConfidence, setFilterConfidence] = useState<FilterConfidence>('high+medium');
  const [filterHasCost, setFilterHasCost] = useState(true);
  const [filterMinAmount, setFilterMinAmount] = useState(10);
  const [filterEligibleOnly, setFilterEligibleOnly] = useState(true);

  // Workflow mode : index of the candidate currently being processed.
  // null = list view, number = focus view on that index.
  const [workflowIndex, setWorkflowIndex] = useState<number | null>(null);
  const [submittedIds, setSubmittedIds] = useState<Set<number>>(new Set());
  const [batchNotes, setBatchNotes] = useState('');

  // Auth gate — same pattern as the other dashboard pages.
  useEffect(() => {
    supabaseCli.auth.getSession().then(({ data }) => {
      setAuthChecked(true);
      if (!data.session) {
        window.location.href = '/login?next=/amazon-sp-api/claims';
      } else {
        setAuthed(true);
      }
    });
  }, []);

  async function loadCandidates() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        status: filterStatus,
        eligible: filterEligibleOnly ? 'true' : 'all',
        has_cost: filterHasCost ? 'true' : 'false',
        min_amount: String(filterMinAmount),
        confidence: filterConfidence,
        limit: '500',
      });
      const res = await fetch('/api/amazon/claims/list?' + qs.toString());
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      setCandidates(body.candidates);
      setTotalCAD(body.total_estimated_amount);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Auto-load whenever filters change (after auth pass).
  useEffect(() => {
    if (!authed) return;
    void loadCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, filterStatus, filterHasCost, filterMinAmount, filterEligibleOnly, filterConfidence]);

  async function markBatchSent() {
    const idsToMark = Array.from(submittedIds);
    if (idsToMark.length === 0) return;
    setLoading(true);
    try {
      const res = await fetch('/api/amazon/claims/mark-sent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: idsToMark,
          notes: batchNotes || `batch submit ${new Date().toISOString().slice(0, 10)}`,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      // Clear submitted set, reload.
      setSubmittedIds(new Set());
      setWorkflowIndex(null);
      setBatchNotes('');
      await loadCandidates();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const submittedTotal = useMemo(() => {
    return candidates
      .filter((c) => submittedIds.has(c.id))
      .reduce((s, c) => s + (c.estimated_amount ?? 0), 0);
  }, [candidates, submittedIds]);

  if (!authChecked || !authed) return null;

  const current = workflowIndex != null ? candidates[workflowIndex] : null;

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
        <Header
          onBack={() => (window.location.href = '/amazon-sp-api')}
          total={candidates.length}
          totalCAD={totalCAD}
        />

        {!current && (
          <FilterBar
            status={filterStatus}
            onStatus={setFilterStatus}
            hasCost={filterHasCost}
            onHasCost={setFilterHasCost}
            minAmount={filterMinAmount}
            onMinAmount={setFilterMinAmount}
            eligibleOnly={filterEligibleOnly}
            onEligibleOnly={setFilterEligibleOnly}
            confidence={filterConfidence}
            onConfidence={setFilterConfidence}
            loading={loading}
          />
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
              marginBottom: 16,
            }}
          >
            ✗ {error}
          </div>
        )}

        {!current && (
          <CandidatesList
            candidates={candidates}
            onStartWorkflow={(i) => setWorkflowIndex(i)}
            submittedIds={submittedIds}
            loading={loading}
          />
        )}

        {current && (
          <WorkflowCard
            candidate={current}
            index={workflowIndex!}
            total={candidates.length}
            onPrev={() =>
              setWorkflowIndex((i) => (i != null && i > 0 ? i - 1 : i))
            }
            onNext={() =>
              setWorkflowIndex((i) =>
                i != null && i < candidates.length - 1 ? i + 1 : i,
              )
            }
            onMarkSubmitted={() => {
              setSubmittedIds((set) => new Set(set).add(current.id));
              setWorkflowIndex((i) =>
                i != null && i < candidates.length - 1 ? i + 1 : null,
              );
            }}
            onUnmarkSubmitted={() => {
              setSubmittedIds((set) => {
                const out = new Set(set);
                out.delete(current.id);
                return out;
              });
            }}
            alreadySubmitted={submittedIds.has(current.id)}
            onClose={() => setWorkflowIndex(null)}
          />
        )}

        {submittedIds.size > 0 && (
          <SubmitBatchBar
            count={submittedIds.size}
            totalCAD={submittedTotal}
            notes={batchNotes}
            onNotes={setBatchNotes}
            onConfirm={markBatchSent}
            onClear={() => setSubmittedIds(new Set())}
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function Header({
  onBack,
  total,
  totalCAD,
}: {
  onBack: () => void;
  total: number;
  totalCAD: number;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <button
        onClick={onBack}
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
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px 0' }}>
        💸 Claims FBA à réclamer
      </h1>
      <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>
        {total} cas filtré{total > 1 ? 's' : ''} · estimation totale{' '}
        <strong style={{ color: '#fcd34d' }}>{totalCAD.toFixed(2)} CAD</strong>{' '}
        au cost basis (politique Amazon mars 2025).
      </p>
    </div>
  );
}

function FilterBar({
  status,
  onStatus,
  hasCost,
  onHasCost,
  minAmount,
  onMinAmount,
  eligibleOnly,
  onEligibleOnly,
  confidence,
  onConfidence,
  loading,
}: {
  status: FilterStatus;
  onStatus: (s: FilterStatus) => void;
  hasCost: boolean;
  onHasCost: (b: boolean) => void;
  minAmount: number;
  onMinAmount: (n: number) => void;
  eligibleOnly: boolean;
  onEligibleOnly: (b: boolean) => void;
  confidence: FilterConfidence;
  onConfidence: (c: FilterConfidence) => void;
  loading: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        padding: 14,
        background: 'rgba(15,23,42,0.5)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        marginBottom: 16,
        alignItems: 'center',
        fontSize: 12,
      }}
    >
      <label>
        Statut :{' '}
        <select
          value={status}
          onChange={(e) => onStatus(e.target.value as FilterStatus)}
          style={selectStyle}
          disabled={loading}
        >
          <option value="pending">pending</option>
          <option value="sent">sent</option>
          <option value="paid">paid</option>
          <option value="all">tous</option>
        </select>
      </label>
      <label
        title="High = Adjustments (paiement quasi-systématique). Medium = CustomerReturns damaged (souvent payé). Low = VendorReturns damaged (paiement moins fréquent — Amazon nous renvoie l'unité). High+medium = sweet spot."
      >
        Confidence :{' '}
        <select
          value={confidence}
          onChange={(e) => onConfidence(e.target.value as FilterConfidence)}
          style={selectStyle}
          disabled={loading}
        >
          <option value="high">🟢 high seulement (Adjustments)</option>
          <option value="high+medium">🟢🟡 high + medium (recommandé)</option>
          <option value="all">tous (incluant low 🟠)</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={hasCost}
          onChange={(e) => onHasCost(e.target.checked)}
          disabled={loading}
        />{' '}
        Cost connu seulement
      </label>
      <label>
        <input
          type="checkbox"
          checked={eligibleOnly}
          onChange={(e) => onEligibleOnly(e.target.checked)}
          disabled={loading}
        />{' '}
        Éligibles seulement (≥30j)
      </label>
      <label>
        Min CAD :{' '}
        <input
          type="number"
          min={0}
          max={10000}
          step={1}
          value={minAmount}
          onChange={(e) => onMinAmount(Number(e.target.value))}
          style={{ ...selectStyle, width: 70 }}
          disabled={loading}
        />
      </label>
      {loading && <span style={{ color: '#94a3b8' }}>chargement…</span>}
    </div>
  );
}

function CandidatesList({
  candidates,
  onStartWorkflow,
  submittedIds,
  loading,
}: {
  candidates: ClaimCandidate[];
  onStartWorkflow: (i: number) => void;
  submittedIds: Set<number>;
  loading: boolean;
}) {
  if (loading && candidates.length === 0) {
    return <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32 }}>chargement…</p>;
  }
  if (candidates.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          textAlign: 'center',
          color: '#94a3b8',
          background: 'rgba(15,23,42,0.5)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
        }}
      >
        Aucun cas selon les filtres. Élargis les critères ou lance{' '}
        <code>Detect claims</code> sur /amazon-sp-api d&apos;abord.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        onClick={() => onStartWorkflow(0)}
        style={{
          ...primaryBtn,
          fontSize: 14,
          padding: '12px 16px',
          marginBottom: 8,
        }}
      >
        🚀 Lancer le workflow batch ({candidates.length} cas)
      </button>
      {candidates.map((c, i) => (
        <CandidateRow
          key={c.id}
          c={c}
          submitted={submittedIds.has(c.id)}
          onClick={() => onStartWorkflow(i)}
        />
      ))}
    </div>
  );
}

function CandidateRow({
  c,
  submitted,
  onClick,
}: {
  c: ClaimCandidate;
  submitted: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        background: submitted ? 'rgba(34,197,94,0.1)' : 'rgba(15,23,42,0.5)',
        border: `1px solid ${submitted ? 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.1)'}`,
        borderRadius: 10,
        color: '#e2e8f0',
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      <span style={{ width: 24 }}>{submitted ? '✅' : '📋'}</span>
      <span style={{ fontFamily: 'monospace', minWidth: 140 }}>{c.sku ?? c.asin ?? '?'}</span>
      <span style={{ minWidth: 130, color: '#94a3b8' }}>{c.event_type}</span>
      <ConfidenceBadge confidence={c.claim_payload?.confidence} />
      <span style={{ minWidth: 90, color: '#94a3b8' }}>{c.event_date}</span>
      <span style={{ minWidth: 50, color: '#94a3b8' }}>×{c.quantity}</span>
      <span
        style={{
          marginLeft: 'auto',
          fontWeight: 700,
          color: c.estimated_amount ? '#fcd34d' : '#64748b',
        }}
      >
        {c.estimated_amount != null ? c.estimated_amount.toFixed(2) + ' CAD' : 'cost ?'}
      </span>
    </button>
  );
}

function WorkflowCard({
  candidate,
  index,
  total,
  onPrev,
  onNext,
  onMarkSubmitted,
  onUnmarkSubmitted,
  alreadySubmitted,
  onClose,
}: {
  candidate: ClaimCandidate;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onMarkSubmitted: () => void;
  onUnmarkSubmitted: () => void;
  alreadySubmitted: boolean;
  onClose: () => void;
}) {
  // Les 3 champs alignés sur le formulaire "My issue is not listed"
  // d'Amazon Seller Central. Fallback sur le body legacy si l'event a
  // été détecté avant que ces champs existent (rétrocompat).
  const field1 =
    candidate.claim_payload?.amazon_field1_what_help ??
    candidate.claim_payload?.case_body ??
    '';
  const field2 =
    candidate.claim_payload?.amazon_field2_steps_taken ??
    'I reviewed my Inventory Ledger Detail report (GET_LEDGER_DETAIL_VIEW_DATA) for this event and verified that no corresponding reimbursement appears in my Reimbursements report. The 30-day claim waiting period has elapsed. Supplier invoice for the affected SKU is available on request.';
  // Si le payload n'a pas le champ 3 pré-calculé, on assemble depuis les
  // identifiants disponibles du candidate row.
  const field3 =
    candidate.claim_payload?.amazon_field3_references ??
    [candidate.asin, candidate.fnsku, candidate.sku, candidate.reference_id]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(', ');
  const url =
    candidate.claim_payload?.seller_central_url ??
    'https://sellercentral.amazon.ca/help/center/contactus';

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      // Quick visual feedback via title — kept simple
      const orig = document.title;
      document.title = `✅ ${label} copié`;
      setTimeout(() => (document.title = orig), 1500);
    } catch {
      window.prompt(`Copier manuellement (${label}) :`, text);
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
          Cas {index + 1} / {total}
        </span>
        <button onClick={onClose} style={secondaryBtn}>
          ✕ retour à la liste
        </button>
        <button
          onClick={onNext}
          disabled={index === total - 1}
          style={secondaryBtn}
        >
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
        <ConfidenceBadge confidence={candidate.claim_payload?.confidence} />
        <span>SKU: {candidate.sku ?? '?'}</span>
        <span>FNSKU: {candidate.fnsku ?? '?'}</span>
        <span>ASIN: {candidate.asin ?? '?'}</span>
        <span>{candidate.event_type} ×{candidate.quantity}</span>
        <span>{candidate.event_date}</span>
        <span>{candidate.days_since_event} j</span>
        <strong style={{ color: '#fcd34d', marginLeft: 'auto' }}>
          {candidate.estimated_amount?.toFixed(2) ?? '?'} CAD
        </strong>
      </div>

      {/* Bandeau d'instruction Seller Central pour rappeler le bon chemin */}
      <div
        style={{
          padding: 10,
          marginBottom: 14,
          background: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          borderRadius: 8,
          fontSize: 11,
          color: '#fde68a',
          lineHeight: 1.5,
        }}
      >
        📍 <strong>Dans Seller Central</strong> : Help → Contact us →
        Selling on Amazon → <em>Manage support cases</em> → cherche dans la
        liste en bas et clique le bouton sombre <strong>&laquo; My issue is
        not listed &raquo;</strong>. Le formulaire ouvre 4 champs — colle
        chacun ci-dessous au champ correspondant.
      </div>

      <Section
        label="📋 Champ 1 — What do you need help with?"
        text={field1}
        onCopy={() => copy(field1, 'Champ 1 (What need help)')}
        multiline
      />
      <Section
        label="📋 Champ 2 — What steps have you taken already?"
        text={field2}
        onCopy={() => copy(field2, 'Champ 2 (Steps taken)')}
        multiline
      />
      <Section
        label="📋 Champ 3 — Reference numbers (Optional)"
        text={field3}
        onCopy={() => copy(field3, 'Champ 3 (References)')}
      />
      <div style={{ fontSize: 10, color: '#64748b', marginTop: -8, marginBottom: 12 }}>
        📎 <strong>Champ 4 (Upload files)</strong> : laisse vide pour la 1ʳᵉ
        soumission. Si Amazon demande la facture supplier en réponse au
        case, tu pourras l&apos;uploader à ce moment-là.
      </div>

      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          marginTop: 20,
          flexWrap: 'wrap',
        }}
      >
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...primaryBtn, textDecoration: 'none' }}
        >
          🔗 Ouvrir Seller Central
        </a>
        {alreadySubmitted ? (
          <button onClick={onUnmarkSubmitted} style={{ ...secondaryBtn, color: '#fca5a5' }}>
            ↩ Démarquer
          </button>
        ) : (
          <button onClick={onMarkSubmitted} style={primaryBtn}>
            ✅ Soumis dans Seller Central
          </button>
        )}
      </div>

      <p style={{ fontSize: 11, color: '#64748b', marginTop: 12 }}>
        Navigation suggérée :{' '}
        {candidate.claim_payload?.suggested_navigation ??
          'Seller Central → Help → Contact us → FBA → FBA issue → Damaged or lost inventory'}
      </p>
    </div>
  );
}

/**
 * Petit badge coloré indiquant la probabilité de succès du claim.
 * Dérivé de l'event_type Amazon source dans claim_payload.confidence.
 *   - high   → Adjustments (paiement quasi-systématique)
 *   - medium → CustomerReturns + damaged (Amazon paye souvent)
 *   - low    → VendorReturns + damaged (Amazon rembourse moins
 *              fréquemment parce qu'ils nous renvoient l'unité)
 */
function ConfidenceBadge({
  confidence,
}: {
  confidence: 'high' | 'medium' | 'low' | undefined;
}) {
  if (!confidence) {
    return <span style={{ minWidth: 70 }} />;
  }
  const config: Record<string, { color: string; label: string; bg: string }> = {
    high: { color: '#86efac', label: '✓ high', bg: 'rgba(34,197,94,0.15)' },
    medium: { color: '#fcd34d', label: '~ med', bg: 'rgba(245,158,11,0.15)' },
    low: { color: '#fca5a5', label: '⚠ low', bg: 'rgba(248,113,113,0.15)' },
  };
  const cfg = config[confidence];
  return (
    <span
      style={{
        minWidth: 70,
        padding: '2px 8px',
        background: cfg.bg,
        color: cfg.color,
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 700,
        textAlign: 'center',
      }}
      title={`Confidence ${confidence} — basé sur l'event_type Amazon source. High = Adjustments (~quasi-systématique). Medium = CustomerReturns damaged (souvent payé). Low = VendorReturns damaged (Amazon renvoie l'unité, paiement moins fréquent).`}
    >
      {cfg.label}
    </span>
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
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

function SubmitBatchBar({
  count,
  totalCAD,
  notes,
  onNotes,
  onConfirm,
  onClear,
  loading,
}: {
  count: number;
  totalCAD: number;
  notes: string;
  onNotes: (s: string) => void;
  onConfirm: () => void;
  onClear: () => void;
  loading: boolean;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        right: 16,
        padding: 14,
        background: 'rgba(34, 197, 94, 0.15)',
        border: '1px solid rgba(34, 197, 94, 0.5)',
        borderRadius: 12,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        maxWidth: 1168,
        margin: '0 auto',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ fontSize: 13, color: '#86efac' }}>
        ✅ <strong>{count}</strong> cas marqué{count > 1 ? 's' : ''} comme soumis ·{' '}
        <strong style={{ color: '#fcd34d' }}>{totalCAD.toFixed(2)} CAD</strong>{' '}
        attendu
      </div>
      <input
        type="text"
        placeholder="Notes (ex. batch 28 mai, case #12345)"
        value={notes}
        onChange={(e) => onNotes(e.target.value)}
        style={{ ...selectStyle, flex: 1, minWidth: 220, padding: '6px 10px' }}
      />
      <button onClick={onClear} style={secondaryBtn} disabled={loading}>
        Annuler
      </button>
      <button onClick={onConfirm} style={primaryBtn} disabled={loading || count === 0}>
        💾 Confirmer marquage DB ({count})
      </button>
    </div>
  );
}

// =============================================================================
// styles
// =============================================================================

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
