'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Hub Amazon SP-API — page standalone pour tester et déclencher tous les
 * syncs auto sans toucher au dashboard principal (qui a déjà trop d'onglets).
 *
 * URL : /amazon-sp-api
 *
 * Contient :
 *   - Carte de statut "Mes claims à réclamer" (lecture seule, auto-refresh)
 *   - 5 boutons d'action : Backfill 8 mois / Sync 4 reports / Detect claims /
 *     Sync settlements / Sync ledger 7j
 *   - Zone d'affichage du résultat de la dernière action
 *
 * Auth : redirige vers /login si pas connecté.
 */

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface ClaimSummary {
  total_candidates: number;
  pending_eligible: { count: number; estimated_amount: number };
  pending_not_yet_eligible: { count: number; estimated_amount: number };
  sent: { count: number; estimated_amount: number };
  paid: { count: number; estimated_amount: number; recovered: number };
  rejected: { count: number; estimated_amount: number };
  expired: { count: number; estimated_amount: number };
  by_event_type: Record<string, { count: number; estimated_amount: number }>;
}

interface BackfillChunkResult {
  chunk: number;
  from: string;
  to: string;
  ok: boolean;
  rows_inserted?: number;
  rows_seen?: number;
  rows_mapped?: number;
  rows_rejected?: number;
  headers_detected?: string[];
  sample_rejected?: Record<string, string>;
  reportId?: string;
  status?: string;
  error?: string;
  duration_ms: number;
}

interface BackfillProgress {
  total: number;
  current: number;
  chunks: BackfillChunkResult[];
  done: boolean;
}

export default function AmazonSpApiHub() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [summary, setSummary] = useState<ClaimSummary | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null);
  // Set whenever Amazon returns 429. The banner counts down to this
  // timestamp and disables the action buttons in the meantime.
  const [rateLimitedUntil, setRateLimitedUntil] = useState<Date | null>(null);

  // Auth check
  useEffect(() => {
    supabaseCli.auth.getSession().then(({ data: { session } }) => {
      if (session) setAuthed(true);
      else window.location.href = '/login';
      setAuthChecked(true);
    });
  }, []);

  // Load claims summary
  async function loadSummary() {
    try {
      const r = await fetch('/api/amazon/claims');
      const body = await r.json();
      if (body.ok && body.summary) setSummary(body.summary);
    } catch {
      // silencieux
    }
  }

  useEffect(() => {
    if (authed) void loadSummary();
  }, [authed]);

  // Backfill chunked — fait N appels HTTP séquentiels d'1 mois chacun
  // pour contourner le timeout serverless Vercel (60-300s par fonction).
  // Chaque chunk étant ~60s, on reste safe sur tous les plans Vercel.
  //
  // smart : si true, on précharge la couverture via
  // /api/amazon/ledger/coverage et on skip les mois ayant déjà ≥100
  // events en DB. Indispensable pour ne pas brûler le rate-limit
  // Amazon sur des mois déjà rattrapés (rate = 1 token/min, burst 15
  // — chaque chunk consomme 1 token, et si on re-fetche Oct + Nov qui
  // sont déjà OK on perd 2 tokens avant d'atteindre les vrais trous).
  async function runBackfillChunked(monthsBack = 8, smart = false, marketplace: 'CA' | 'US' = 'CA') {
    if (busy) return;
    setBusy('backfill');
    setError(null);
    setResult(null);

    // Calcule les N chunks de 30 jours en remontant depuis aujourd'hui
    const now = new Date();
    const chunks: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < monthsBack; i++) {
      const end = new Date(now);
      end.setDate(end.getDate() - i * 30);
      const start = new Date(end);
      start.setDate(start.getDate() - 30);
      chunks.unshift({ from: start.toISOString(), to: end.toISOString() });
    }

    // Smart mode : skip chunks dont la fenêtre est déjà couverte en DB.
    // On query la couverture par mois et on filtre les chunks qui
    // chevauchent un mois ayant >= 100 events.
    if (smart) {
      try {
        // Coverage par pays (US vs CA) — sinon un mois CA déjà rempli
        // ferait croire que la fenêtre US est OK alors qu'elle est vide.
        const covUrl = '/api/amazon/ledger/coverage?months=' + Math.min(24, monthsBack) + (marketplace === 'US' ? '&country=US' : '&country=CA');
        const covRes = await fetch(covUrl);
        const cov = await covRes.json();
        if (cov.ok && Array.isArray(cov.months)) {
          const coveredMonths = new Set(
            cov.months
              .filter(
                (m: { status: string; year_month: string }) => m.status === 'covered',
              )
              .map((m: { year_month: string }) => m.year_month),
          );
          const kept: typeof chunks = [];
          for (const c of chunks) {
            // year-month at chunk midpoint — proxy for "which month does
            // this 30-day window mostly belong to".
            const mid = new Date((new Date(c.from).getTime() + new Date(c.to).getTime()) / 2);
            const ym = mid.toISOString().slice(0, 7);
            if (!coveredMonths.has(ym)) kept.push(c);
          }
          // If smart mode prunes everything → display message and stop.
          if (kept.length === 0) {
            setBusy(null);
            setResult({
              mode: 'smart_backfill',
              message: 'Tous les mois sont déjà couverts (≥100 events chacun). Rien à rattraper.',
              coverage: cov.summary,
            });
            return;
          }
          chunks.length = 0;
          chunks.push(...kept);
        }
      } catch {
        // Coverage check failed — on continue avec tous les chunks plutôt
        // que de bloquer le user.
      }
    }

    setBackfillProgress({ total: chunks.length, current: 0, chunks: [], done: false });

    const results: BackfillChunkResult[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const startedAt = Date.now();
      try {
        const res = await fetch('/api/amazon/sp-api/ledger-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: chunk.from,
            to: chunk.to,
            chunk_days: 30,
            marketplace,
          }),
        });
        const body = await res.json();
        const duration = Date.now() - startedAt;
        // 429 inside the chunked loop : raise the rate-limit banner with the
        // server's retry_at, stop firing more chunks, mark the rest skipped.
        if (res.status === 429 && body.rate_limited && body.retry_at) {
          setRateLimitedUntil(new Date(body.retry_at));
          results.push({
            chunk: i + 1,
            from: chunk.from.slice(0, 10),
            to: chunk.to.slice(0, 10),
            ok: false,
            error: `429 rate-limited — chunks suivants annulés. ${body.error}`,
            duration_ms: duration,
          });
          setBackfillProgress({
            total: chunks.length,
            current: i + 1,
            chunks: [...results],
            done: true,
          });
          break;
        }
        // body shape (depuis syncLedgerRange) :
        // { ok, chunks: [LedgerChunkResult], total_rows_inserted, total_errors }
        // On extrait le détail du SEUL chunk interne pour avoir
        // rows_mapped/rejected/headers_detected/sample_rejected.
        const innerChunk = (body.chunks ?? [])[0] ?? {};
        const chunkResult: BackfillChunkResult = {
          chunk: i + 1,
          from: chunk.from.slice(0, 10),
          to: chunk.to.slice(0, 10),
          ok: !!body.ok,
          rows_inserted: body.total_rows_inserted ?? innerChunk.rows_inserted ?? 0,
          rows_seen: innerChunk.rows_seen,
          rows_mapped: innerChunk.rows_mapped,
          rows_rejected: innerChunk.rows_rejected,
          headers_detected: innerChunk.headers_detected,
          sample_rejected: innerChunk.sample_rejected,
          reportId: innerChunk.reportId,
          status: innerChunk.status,
          error: body.ok ? innerChunk.error : body.error || `HTTP ${res.status}`,
          duration_ms: duration,
        };
        results.push(chunkResult);
        setBackfillProgress({
          total: chunks.length,
          current: i + 1,
          chunks: [...results],
          done: false,
        });
      } catch (e) {
        const duration = Date.now() - startedAt;
        const chunkResult: BackfillChunkResult = {
          chunk: i + 1,
          from: chunk.from.slice(0, 10),
          to: chunk.to.slice(0, 10),
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          duration_ms: duration,
        };
        results.push(chunkResult);
        setBackfillProgress({
          total: chunks.length,
          current: i + 1,
          chunks: [...results],
          done: false,
        });
        // On continue les autres chunks même si un échoue
      }
    }

    // Final
    const totalRows = results.reduce((s, r) => s + (r.rows_inserted ?? 0), 0);
    const totalErrors = results.filter((r) => !r.ok).length;
    setBackfillProgress({
      total: chunks.length,
      current: chunks.length,
      chunks: results,
      done: true,
    });
    setResult({
      mode: 'chunked_backfill',
      marketplace,
      months_back: monthsBack,
      total_chunks: chunks.length,
      total_rows_inserted: totalRows,
      total_errors: totalErrors,
      chunks: results,
    });
    if (totalErrors > 0) {
      setError(`${totalErrors}/${chunks.length} chunks ont échoué (voir détails ci-dessous)`);
    }
    await loadSummary();
    setBusy(null);
  }

  // Generic action runner
  async function run(
    label: string,
    fetchOpts: () => Promise<Response>,
  ) {
    if (busy) return;
    // Block actions while rate-limited — Amazon refill is per-token,
    // hammering it just resets the wait.
    if (rateLimitedUntil && rateLimitedUntil.getTime() > Date.now()) return;
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      const startedAt = Date.now();
      const res = await fetchOpts();
      const body = await res.json();
      const durationMs = Date.now() - startedAt;
      setResult({ duration_ms: durationMs, ...body });
      // 429 path — surface a friendly banner + countdown via state.
      if (res.status === 429 && body.rate_limited && body.retry_at) {
        setRateLimitedUntil(new Date(body.retry_at));
        setError(typeof body.error === 'string' ? body.error : 'Amazon SP-API rate limit');
        return;
      }
      if (!res.ok || body.ok === false) {
        setError(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
      } else {
        // Une action OK efface aussi le rate-limit s'il était périmé
        // (cas où on a juste continué à attendre puis cliqué).
        if (rateLimitedUntil && rateLimitedUntil.getTime() <= Date.now()) {
          setRateLimitedUntil(null);
        }
        await loadSummary();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!authChecked) return null;
  if (!authed) return null;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)',
        padding: '24px',
        fontFamily: "'DM Sans', sans-serif",
        color: '#e2e8f0',
      }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 900 }}>
              ⚙️ Amazon SP-API Hub
            </h1>
            <p style={{ margin: '6px 0 0', color: '#94a3b8', fontSize: 14 }}>
              Sync automatique des données Amazon. Page de test et déclenchement manuel.
            </p>
          </div>
          <a
            href="/"
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              textDecoration: 'none',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            ← Retour Dashboard
          </a>
        </div>

        {/* Summary card claims */}
        <ClaimsSummaryCard summary={summary} onRefresh={loadSummary} />

        {/* Actions grid */}
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: '24px 0 12px' }}>
          🔧 Actions SP-API
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          <ActionCard
            title="🧠 Smart backfill (mois manquants seulement)"
            description="Check d'abord la couverture par mois en DB, puis ne fire les chunks SP-API QUE pour les mois avec <100 events. Économise tokens rate-limit Amazon (1/min) en sautant les mois déjà rattrapés. À utiliser après un 1er backfill partiel pour combler les trous."
            color="#16a34a"
            busy={busy === 'backfill'}
            onClick={() => runBackfillChunked(8, true)}
          />
          <ActionCard
            title="📚 Backfill ledger 8 mois (brut)"
            description="One-shot : télécharge l'historique sur 8 mois en 8 appels séquentiels d'1 mois chacun (~1 min/chunk = 8-10 min total). Évite les timeouts serverless. À faire UNE FOIS au tout premier setup. Préférer le Smart backfill ensuite."
            color="#7c3aed"
            busy={busy === 'backfill'}
            onClick={() => runBackfillChunked(8, false)}
          />
          <ActionCard
            title="🔄 Sync 4 reports manuels"
            description="Reimbursements + FBA Inventory + Customer Returns + Removal Orders. Remplace tes anciens uploads CSV manuels. ~8 min."
            color="#0891b2"
            busy={busy === 'sync-all'}
            onClick={() =>
              run('sync-all', () =>
                fetch('/api/amazon/sp-api/sync-all', { method: 'POST' }),
              )
            }
          />
          <ActionCard
            title="💰 Sync settlements"
            description="Pull les nouveaux settlements DONE chez Amazon. Le cron le fait à 8h chaque jour mais tu peux le forcer."
            color="#059669"
            busy={busy === 'settlements'}
            onClick={() =>
              run('settlements', () =>
                fetch('/api/amazon/sp-api/settlements-sync', { method: 'POST' }),
              )
            }
          />
          <ActionCard
            title="📒 Sync ledger 7j (incrémental)"
            description="Re-fetche les 7 derniers jours du ledger pour capter les reconciliations tardives d'Amazon."
            color="#0284c7"
            busy={busy === 'ledger-recent'}
            onClick={() =>
              run('ledger-recent', () =>
                fetch('/api/amazon/sp-api/ledger-sync', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mode: 'recent', days_back: 7 }),
                }),
              )
            }
          />
          <ActionCard
            title="🎯 Détecter claims manqués"
            description="Croise ledger × reimbursements × ventes pour calculer ce qu'Amazon te doit en stock perdu / cassé. À lancer après les autres syncs."
            color="#dc2626"
            busy={busy === 'detect'}
            onClick={() =>
              run('detect', () =>
                fetch('/api/amazon/claims/detect', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                }),
              )
            }
          />
          <ActionCard
            title="💸 Page Claims (workflow batch)"
            description="Ouvre la page de gestion des claims FBA : liste les candidats Damaged/Defective non remboursés, génère subject + body prêts à coller dans Seller Central, marque envoyé en DB. Vérifie d'abord avoir lancé Detect claims pour peupler la liste."
            color="#f59e0b"
            busy={false}
            onClick={() => {
              window.location.href = '/amazon-sp-api/claims';
            }}
          />
          <ActionCard
            title="⏳ Aged inventory monitor"
            description="Surveille les SKUs FBA approchant la barre des 181 jours (Aged Inventory Surcharge). Sync le report GET_FBA_INVENTORY_PLANNING_DATA + page avec tri par urgence (remove / discount / monitor). Évaluation Amazon le 15 du mois — agir avant le 14 stoppe la surcharge."
            color="#fb923c"
            busy={false}
            onClick={() => {
              window.location.href = '/amazon-sp-api/aging';
            }}
          />
          <ActionCard
            title="📐 Dimensions audit (Cubiscan dispute)"
            description="Compare ce qu'Amazon mesure (via Catalog API) à nos dimensions réelles. Discrepancy >+10% volume = candidat à un Cubiscan remeasure request. Récupère les fees overcharged des 90 derniers jours."
            color="#ec4899"
            busy={false}
            onClick={() => {
              window.location.href = '/amazon-sp-api/dimensions';
            }}
          />
          <ActionCard
            title="💰 Sourcing Cost Bulk Enricher"
            description="Drop le XLSX Amazon 'Bulk Manage Sourcing Cost' téléchargé depuis le IDR Portal, on remplit automatiquement la colonne Seller New Cost avec nos vrais costs MPP. Te download le fichier enrichi prêt à uploader. Levier #1 pour récupérer les sous-payments d'auto-reimbursements (~25-35 K CAD potentiel sur 18m)."
            color="#ec4899"
            busy={false}
            onClick={() => {
              window.location.href = '/amazon-sp-api/sourcing-cost';
            }}
          />
          <ActionCard
            title="♻️ Dispute reimbursements sous-payés"
            description="Reimbursements Amazon où le montant payé < (notre cost × quantité). Génère un template 'Submit a reimbursement claim dispute' avec le Reimbursement ID + différentiel à réclamer. Window 90j = fenêtre fraîche (~60% succès). Récupération rétroactive estimée ~6 K CAD sur 90j."
            color="#22d3ee"
            busy={false}
            onClick={() => {
              window.location.href = '/amazon-sp-api/dispute-reimbursements';
            }}
          />
          <ActionCard
            title="🔍 Ping SP-API (diagnostic)"
            description="Test rapide (<5s) : vérifie env vars + LWA token + 1 appel SP-API léger. À utiliser quand un sync rate pour savoir si c'est la config ou le report."
            color="#10b981"
            busy={busy === 'ping'}
            onClick={() =>
              run('ping', () => fetch('/api/amazon/sp-api/ping'))
            }
          />
          <ActionCard
            title="🐛 Debug ledger (1 semaine)"
            description="Lance un report ledger sur les 7 derniers jours et retourne les colonnes/sample (sans rien upsert). Utile pour comprendre pourquoi le backfill ramène 0 lignes."
            color="#f59e0b"
            busy={busy === 'ledger-debug'}
            onClick={() => {
              const now = new Date();
              const weekAgo = new Date(now);
              weekAgo.setDate(weekAgo.getDate() - 7);
              const from = weekAgo.toISOString().slice(0, 10);
              const to = now.toISOString().slice(0, 10);
              return run('ledger-debug', () =>
                fetch(`/api/amazon/sp-api/ledger-debug?from=${from}&to=${to}`),
              );
            }}
          />
          <ActionCard
            title="🇺🇸 Snapshot stock US (Amazon.com)"
            description="Tire un snapshot LIVE du stock FBA US (marketplace ATVPDKIKX0DER). Retourne nb SKUs, units, valeur USD, top 20. Inséré dans amazon_fba_inventory avec préfixe SKU 'US:' pour cohabiter avec CA. Peut prendre 60-180s à cause du rate limit Amazon sur POST /reports (1 req/min)."
            color="#3b82f6"
            busy={busy === 'inventory-us'}
            onClick={() => run('inventory-us', () => fetch('/api/amazon/sp-api/inventory-us'))}
          />
          <ActionCard
            title="🇺🇸 Smart backfill ledger US 18 mois"
            description="Backfill historique du ledger d'inventaire US (avant sept 2025). Check d'abord la couverture par mois côté US uniquement, puis fire les chunks SP-API seulement pour les mois manquants. Idéal pour éclairer les 73 SKUs à 0 sans historique visible. ~15-30 min selon la couverture déjà en place."
            color="#3b82f6"
            busy={busy === 'backfill'}
            onClick={() => runBackfillChunked(18, true, 'US')}
          />
          <ActionCard
            title="🇺🇸 Backfill ledger US 12 mois (brut)"
            description="Backfill brut : 12 chunks de 30 jours en remontant depuis aujourd'hui, sans skip. À utiliser si tu veux re-télécharger les mois déjà couverts (forcer un refresh)."
            color="#1e40af"
            busy={busy === 'backfill'}
            onClick={() => runBackfillChunked(12, false, 'US')}
          />
        </div>

        {/* Backfill progress (only visible when running or done) */}
        {backfillProgress && (
          <BackfillProgressPanel progress={backfillProgress} />
        )}

        {/* Rate-limit banner with live countdown — takes priority over the
            generic error display because the resolution is just "wait". */}
        {rateLimitedUntil && (
          <RateLimitBanner
            until={rateLimitedUntil}
            onExpire={() => setRateLimitedUntil(null)}
          />
        )}

        {/* Error (only when no rate-limit countdown active) */}
        {error && !rateLimitedUntil && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              borderRadius: 12,
              background: 'rgba(220,38,38,0.2)',
              border: '1px solid rgba(220,38,38,0.5)',
              color: '#fecaca',
              fontSize: 13,
            }}
          >
            ✗ {error}
          </div>
        )}

        {/* Result */}
        {result != null && (
          <div style={{ marginTop: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>
              📋 Résultat dernière action
            </h2>
            <pre
              style={{
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                padding: 16,
                fontSize: 12,
                fontFamily: 'monospace',
                color: '#a5f3fc',
                overflow: 'auto',
                maxHeight: 500,
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}

        {/* Footer info */}
        <div
          style={{
            marginTop: 24,
            padding: 16,
            borderRadius: 12,
            background: 'rgba(255,255,255,0.05)',
            fontSize: 11,
            color: '#94a3b8',
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 700, color: '#cbd5e1', marginBottom: 8 }}>
            ℹ️ Ordre recommandé pour le premier setup
          </div>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>📚 <strong>Backfill ledger 8 mois</strong> (une seule fois — long mais nécessaire)</li>
            <li>🔄 <strong>Sync 4 reports manuels</strong> (pour avoir reimbursements + inventory frais)</li>
            <li>💰 <strong>Sync settlements</strong> (si pas déjà à jour)</li>
            <li>🎯 <strong>Détecter claims manqués</strong> (LE step qui te dit où sont les $$ à récupérer)</li>
          </ol>
          <div style={{ marginTop: 12 }}>
            Ensuite les crons quotidiens (11h, 12h, 12h30, 13h UTC) maintiennent tout à jour automatiquement.
            Tu peux bookmark cette page pour des tests ponctuels.
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  title,
  description,
  color,
  busy,
  onClick,
}: {
  title: string;
  description: string;
  color: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        textAlign: 'left',
        padding: 16,
        borderRadius: 12,
        background: busy ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)',
        border: `2px solid ${busy ? color : 'rgba(255,255,255,0.1)'}`,
        cursor: busy ? 'wait' : 'pointer',
        color: '#fff',
        fontFamily: 'inherit',
        transition: 'all 0.2s',
        opacity: busy ? 0.7 : 1,
      }}
      onMouseEnter={(e) => {
        if (!busy) {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.border = `2px solid ${color}`;
        }
      }}
      onMouseLeave={(e) => {
        if (!busy) {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.border = '2px solid rgba(255,255,255,0.1)';
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 800 }}>{title}</span>
        {busy && <span style={{ marginLeft: 'auto', color: color, fontSize: 12 }}>⏳ En cours…</span>}
      </div>
      <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>{description}</div>
    </button>
  );
}

function ClaimsSummaryCard({
  summary,
  onRefresh,
}: {
  summary: ClaimSummary | null;
  onRefresh: () => void;
}) {
  const fmt = (n: number) =>
    n.toLocaleString('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

  if (!summary) {
    return (
      <div
        style={{
          padding: 24,
          borderRadius: 16,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          textAlign: 'center',
          color: '#94a3b8',
          fontSize: 14,
        }}
      >
        Chargement du summary claims… (ou aucun candidate détecté encore — lance « Détecter claims manqués » après le sync initial)
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 20,
        borderRadius: 16,
        background: 'linear-gradient(135deg, rgba(220,38,38,0.15) 0%, rgba(245,158,11,0.1) 100%)',
        border: '1px solid rgba(220,38,38,0.3)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900 }}>
          🎯 Claims à réclamer auprès d'Amazon
        </h2>
        <button
          onClick={onRefresh}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          🔄 Refresh
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        <StatCell
          label="🔥 À récupérer maintenant"
          value={fmt(summary.pending_eligible.estimated_amount)}
          subValue={`${summary.pending_eligible.count} candidates éligibles`}
          accent="#fbbf24"
        />
        <StatCell
          label="⏳ Pas encore éligibles (<30j)"
          value={fmt(summary.pending_not_yet_eligible.estimated_amount)}
          subValue={`${summary.pending_not_yet_eligible.count} candidates`}
          accent="#60a5fa"
        />
        <StatCell
          label="📤 Envoyés à Amazon"
          value={fmt(summary.sent.estimated_amount)}
          subValue={`${summary.sent.count} cases ouverts`}
          accent="#a78bfa"
        />
        <StatCell
          label="✅ Récupéré"
          value={fmt(summary.paid.recovered)}
          subValue={`${summary.paid.count} settlements payés`}
          accent="#10b981"
        />
        <StatCell
          label="❌ Refusé"
          value={fmt(summary.rejected.estimated_amount)}
          subValue={`${summary.rejected.count} cases`}
          accent="#ef4444"
        />
        <StatCell
          label="🕒 Expiré (>18 mois)"
          value={fmt(summary.expired.estimated_amount)}
          subValue={`${summary.expired.count} cases (trop tard)`}
          accent="#6b7280"
        />
      </div>
      {Object.keys(summary.by_event_type).length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
            Par type d'événement
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(summary.by_event_type).map(([type, v]) => (
              <span
                key={type}
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.1)',
                  fontSize: 12,
                  color: '#e2e8f0',
                }}
              >
                <strong>{type}</strong> · {v.count} unités · {fmt(v.estimated_amount)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  subValue,
  accent,
}: {
  label: string;
  value: string;
  subValue: string;
  accent: string;
}) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 12,
        background: 'rgba(0,0,0,0.2)',
        border: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: accent }}>{value}</div>
      <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 2 }}>{subValue}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// BackfillProgressPanel — barre de progression du backfill chunked
// ────────────────────────────────────────────────────────────────────────

function BackfillProgressPanel({ progress }: { progress: BackfillProgress }) {
  const pct = Math.round((progress.current / progress.total) * 100);
  const totalRows = progress.chunks.reduce((s, c) => s + (c.rows_inserted ?? 0), 0);
  const errors = progress.chunks.filter((c) => !c.ok).length;
  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 12,
        background: progress.done
          ? 'rgba(16,185,129,0.1)'
          : 'rgba(124,58,237,0.15)',
        border: `1px solid ${progress.done ? 'rgba(16,185,129,0.4)' : 'rgba(124,58,237,0.4)'}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 800, color: '#fff' }}>
          {progress.done
            ? `✅ Backfill terminé · ${totalRows.toLocaleString('fr-CA')} mouvements ledger insérés`
            : `📚 Backfill en cours · chunk ${progress.current}/${progress.total}`}
          {errors > 0 && (
            <span style={{ marginLeft: 8, color: '#fbbf24' }}>
              ⚠️ {errors} erreur(s)
            </span>
          )}
        </span>
        <span style={{ fontSize: 12, color: '#cbd5e1' }}>{pct}%</span>
      </div>
      {/* Barre de progression */}
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: 'rgba(0,0,0,0.4)',
          overflow: 'hidden',
          marginBottom: 12,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: progress.done
              ? 'linear-gradient(90deg, #10b981 0%, #34d399 100%)'
              : 'linear-gradient(90deg, #7c3aed 0%, #a855f7 100%)',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      {/* Liste des chunks */}
      <div style={{ display: 'grid', gap: 4 }}>
        {progress.chunks.map((c) => (
          <div
            key={c.chunk}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
              fontFamily: 'monospace',
              padding: '4px 8px',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.2)',
            }}
          >
            <span
              style={{
                width: 18,
                color: c.ok ? (c.rows_inserted ? '#34d399' : '#fbbf24') : '#fca5a5',
                fontWeight: 700,
              }}
            >
              {c.ok ? (c.rows_inserted ? '✓' : '⚠') : '✗'}
            </span>
            <span style={{ color: '#94a3b8', minWidth: 40 }}>#{c.chunk}</span>
            <span style={{ color: '#cbd5e1', minWidth: 180 }}>
              {c.from} → {c.to}
            </span>
            <span
              style={{
                color: c.ok ? (c.rows_inserted ? '#a5f3fc' : '#fde68a') : '#fecaca',
                flex: 1,
              }}
            >
              {c.ok ? (
                <>
                  seen=<strong>{(c.rows_seen ?? 0).toLocaleString('fr-CA')}</strong>
                  {' · '}
                  mapped=<strong>{(c.rows_mapped ?? 0).toLocaleString('fr-CA')}</strong>
                  {(c.rows_rejected ?? 0) > 0 && (
                    <>
                      {' · '}
                      <span style={{ color: '#fbbf24' }}>
                        rejected={(c.rows_rejected ?? 0).toLocaleString('fr-CA')}
                      </span>
                    </>
                  )}
                  {' · '}
                  inserted=<strong>{(c.rows_inserted ?? 0).toLocaleString('fr-CA')}</strong>
                  {' · '}
                  {(c.duration_ms / 1000).toFixed(1)}s
                </>
              ) : (
                c.error?.slice(0, 80)
              )}
            </span>
          </div>
        ))}
        {/* Si chunks ont des headers détectés ou sample rejected, on les
           affiche en details collapse pour debug */}
        {progress.chunks.some((c) => c.headers_detected || c.sample_rejected) && (
          <details
            style={{
              marginTop: 8,
              padding: 8,
              fontSize: 11,
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            <summary style={{ color: '#fbbf24', fontWeight: 700 }}>
              🔍 Détails debug (headers Amazon détectés + sample rejected)
            </summary>
            <div style={{ marginTop: 8, fontFamily: 'monospace' }}>
              {progress.chunks
                .filter((c) => c.headers_detected || c.sample_rejected)
                .slice(0, 1) // 1er suffit, ils sont identiques
                .map((c) => (
                  <div key={c.chunk}>
                    {c.headers_detected && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ color: '#94a3b8', marginBottom: 4 }}>
                          Headers Amazon (chunk #{c.chunk}) :
                        </div>
                        <div style={{ color: '#a5f3fc', wordBreak: 'break-all' }}>
                          {c.headers_detected.map((h) => `"${h}"`).join(', ')}
                        </div>
                      </div>
                    )}
                    {c.sample_rejected && (
                      <div>
                        <div style={{ color: '#fbbf24', marginBottom: 4 }}>
                          Sample rejeté (1ère ligne dont mapRow n'a pas pu extraire
                          event_date OU event_type) :
                        </div>
                        <pre
                          style={{
                            color: '#fecaca',
                            background: 'rgba(0,0,0,0.4)',
                            padding: 8,
                            borderRadius: 4,
                            overflow: 'auto',
                            margin: 0,
                          }}
                        >
                          {JSON.stringify(c.sample_rejected, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </details>
        )}
        {/* Placeholder pour les chunks pas encore lancés */}
        {!progress.done &&
          Array.from({ length: progress.total - progress.chunks.length }, (_, i) => (
            <div
              key={`pending-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                fontFamily: 'monospace',
                padding: '4px 8px',
                borderRadius: 6,
                background: 'rgba(0,0,0,0.1)',
                color: '#475569',
              }}
            >
              <span style={{ width: 18 }}>⏳</span>
              <span style={{ minWidth: 40 }}>#{progress.chunks.length + i + 1}</span>
              <span style={{ flex: 1 }}>(en attente…)</span>
            </div>
          ))}
      </div>
    </div>
  );
}

/**
 * Banner showing the live countdown until Amazon SP-API is ready to accept
 * another `POST /reports/2021-06-30/reports` call. Renders nothing when the
 * deadline has passed — fires `onExpire` so the parent can clear its state
 * and re-enable the action buttons.
 */
function RateLimitBanner({ until, onExpire }: { until: Date; onExpire: () => void }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const remainingMs = until.getTime() - now;
  useEffect(() => {
    if (remainingMs <= 0) onExpire();
  }, [remainingMs, onExpire]);

  if (remainingMs <= 0) return null;

  const totalSecs = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const countdown = mins > 0 ? `${mins} min ${String(secs).padStart(2, '0')}s` : `${secs}s`;
  const retryAt = until.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div
      style={{
        marginTop: 16,
        padding: 14,
        borderRadius: 12,
        background: 'rgba(245, 158, 11, 0.15)',
        border: '1px solid rgba(245, 158, 11, 0.5)',
        color: '#fde68a',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
        ⏳ Amazon SP-API t&apos;a rate-limité
      </div>
      <div>
        Le bucket Amazon se remplit à <strong>1 jeton par minute</strong> sur
        ce endpoint. Aucun bouton ne va déclencher d&apos;appel tant que le
        compteur ci-dessous n&apos;est pas écoulé — réessayer maintenant
        remet le compteur à zéro.
      </div>
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#fcd34d' }}>
          {countdown}
        </span>
        <span style={{ fontSize: 12, color: '#fde68a', opacity: 0.85 }}>
          (déblocage vers {retryAt})
        </span>
      </div>
    </div>
  );
}
