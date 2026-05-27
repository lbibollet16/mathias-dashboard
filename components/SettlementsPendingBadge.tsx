'use client';

import { useEffect, useState } from 'react';

/**
 * Badge visible UNIQUEMENT pour les utilisateurs admin (role='admin')
 * dans la nav du dashboard. Compte les settlements `closed_at IS NULL`
 * et affiche un cercle rouge avec le nombre + tooltip avec sample.
 *
 * Usage dans page.tsx (à mettre près du bouton "Comptabilité" ou
 * "Amazon" dans la nav) :
 *
 *   {profil?.role === 'admin' && <SettlementsPendingBadge />}
 *
 * Le composant est self-contained — fait son propre fetch et son
 * propre polling toutes les 5 minutes.
 */

interface PendingSettlement {
  settlement_id: string;
  settlement_end: string | null;
  deposit_date: string | null;
  total_amount: number | null;
  currency: string | null;
}

interface PendingCountResponse {
  ok: boolean;
  count: number;
  sample: PendingSettlement[];
}

export default function SettlementsPendingBadge({
  href = '/?tab=comptabilite',
  className = '',
}: {
  href?: string;
  className?: string;
}) {
  const [data, setData] = useState<PendingCountResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/amazon/settlements/pending-count');
        const body = (await res.json()) as PendingCountResponse;
        if (!cancelled) setData(body);
      } catch {
        // silencieux — badge disparaît juste
      }
    }
    void load();
    const interval = setInterval(load, 5 * 60_000); // refresh 5min
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!data || !data.ok || data.count === 0) return null;

  const tooltip = data.sample
    .map((s) => {
      const date = s.settlement_end ? s.settlement_end.slice(0, 10) : '?';
      const amt = s.total_amount != null
        ? `${s.total_amount.toLocaleString('fr-CA')} ${s.currency || 'CAD'}`
        : '?';
      return `${date} · ${amt} · ${s.settlement_id}`;
    })
    .join('\n');

  return (
    <a
      href={href}
      title={
        `${data.count} settlement(s) à fermer\n────────────────────\n${tooltip}\n────────────────────\nCliquer pour ouvrir Comptabilité`
      }
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        background: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)',
        color: '#fff',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        textDecoration: 'none',
        boxShadow: '0 2px 6px rgba(220,38,38,0.4)',
        animation: data.count > 2 ? 'pulse-settlements 2s ease-in-out infinite' : undefined,
      }}
    >
      <span style={{ fontSize: 14 }}>📊</span>
      <span>{data.count} à fermer</span>
      <style jsx>{`
        @keyframes pulse-settlements {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
      `}</style>
    </a>
  );
}
