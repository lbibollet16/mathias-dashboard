'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Menu Hub — page d'accueil alternative quand la nav principale déborde.
 *
 * URL : /menu (à bookmark)
 *
 * Affiche toutes les sections du dashboard sous forme de grandes tuiles
 * cliquables, organisées par catégorie. Inclut aussi les pages "hors nav"
 * comme /amazon-sp-api.
 *
 * Chaque tuile mène vers `/?tab=xxx` (le dashboard principal sélectionne
 * l'onglet via ce param) ou vers une URL directe pour les pages standalone.
 */

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface Tile {
  label: string;
  icon: string;
  description: string;
  href: string;
  color: string;
  isStandalone?: boolean;
}

interface Category {
  title: string;
  emoji: string;
  tiles: Tile[];
}

const CATEGORIES: Category[] = [
  {
    title: 'AMAZON & E-COMMERCE',
    emoji: '🛒',
    tiles: [
      {
        label: 'Amazon — Réconciliation',
        icon: '📦',
        description: 'Réconciliation FBA/FBM, settlements, LAUTOPAK',
        href: '/?tab=amazon',
        color: '#f97316',
      },
      {
        label: 'Amazon SP-API Hub',
        icon: '⚙️',
        description: 'Sync auto settlements, ledger, claims — page standalone',
        href: '/amazon-sp-api',
        color: '#dc2626',
        isStandalone: true,
      },
    ],
  },
  {
    title: 'SERVICE / MÉCANIQUE',
    emoji: '🔧',
    tiles: [
      {
        label: 'Aviseur',
        icon: '🔧',
        description: 'Tableau de bord personnel + suivi de ses bons de travail',
        href: '/?tab=aviseur',
        color: '#0891b2',
      },
      {
        label: 'Directeur de service',
        icon: '📊',
        description: 'Powersport + Marine réunis, aviseurs à suivre',
        href: '/?tab=directeur_service',
        color: '#0284c7',
      },
      {
        label: 'Aviseur Technique',
        icon: '⚙️',
        description: 'Imports Excel, paramétrage aviseurs, suivi des bons',
        href: '/?tab=aviseur_technique',
        color: '#7c3aed',
      },
    ],
  },
  {
    title: 'COMPTOIR PIÈCES',
    emoji: '🧰',
    tiles: [
      {
        label: 'Commis Pièces',
        icon: '🧰',
        description: 'Tableau de bord personnel du commis pièces',
        href: '/?tab=commis_pieces',
        color: '#0d9488',
      },
      {
        label: 'Comptoir Pièces',
        icon: '🛠',
        description: 'Vue directeur du comptoir pièces, commis à suivre',
        href: '/?tab=comptoir_pieces',
        color: '#0284c7',
      },
      {
        label: 'Pièces — Réglages',
        icon: '⚙️',
        description: 'Imports Excel pièces + paramétrage des commis',
        href: '/?tab=pieces_config',
        color: '#7c3aed',
      },
    ],
  },
  {
    title: 'COMMANDES & INVENTAIRE',
    emoji: '📋',
    tiles: [
      {
        label: 'Commandes du jour',
        icon: '📋',
        description: 'Commandes journalières',
        href: '/?tab=commandes',
        color: '#2563eb',
      },
      {
        label: 'Commandes en attente',
        icon: '⏳',
        description: 'Suivi commandes Traction non reçues',
        href: '/?tab=commandes_attente',
        color: '#f59e0b',
      },
      {
        label: 'Fournitures (Suggestions)',
        icon: '💡',
        description: 'Suggestions de réapprovisionnement',
        href: '/?tab=fournitures',
        color: '#10b981',
      },
      {
        label: 'Inventaire',
        icon: '📦',
        description: 'Inventaire cyclique et comptage',
        href: '/?tab=inventaire',
        color: '#0891b2',
      },
      {
        label: 'Pièces Négatives',
        icon: '🔴',
        description: 'Suivi des pièces en négatif',
        href: '/?tab=negatifs',
        color: '#ef4444',
      },
      {
        label: 'Retours RMA',
        icon: '🔄',
        description: 'Gestion des retours fournisseurs',
        href: '/?tab=retours',
        color: '#8b5cf6',
      },
      {
        label: 'Vérification',
        icon: '🔍',
        description: 'Vérifications doubles',
        href: '/?tab=verification',
        color: '#06b6d4',
      },
    ],
  },
  {
    title: 'COMPTABILITÉ & ANALYSES',
    emoji: '💰',
    tiles: [
      {
        label: 'Comptabilité',
        icon: '💰',
        description: 'Validation comptable et historique',
        href: '/?tab=comptabilite',
        color: '#059669',
      },
      {
        label: 'Calculateur Achats',
        icon: '🧮',
        description: 'Calcul des achats et stocks',
        href: '/?tab=calc',
        color: '#0d9488',
      },
      {
        label: 'Importer Ventes',
        icon: '📥',
        description: 'Import des données de ventes',
        href: '/?tab=import',
        color: '#0284c7',
      },
      {
        label: 'Booking',
        icon: '📅',
        description: 'Planification et réservations',
        href: '/?tab=booking',
        color: '#6366f1',
      },
    ],
  },
  {
    title: 'ADMIN',
    emoji: '👥',
    tiles: [
      {
        label: 'Utilisateurs',
        icon: '👥',
        description: 'Gestion des accès et rôles',
        href: '/?tab=utilisateurs',
        color: '#71717a',
      },
    ],
  },
];

export default function MenuHub() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [profil, setProfil] = useState<{ email: string; role: string } | null>(null);

  useEffect(() => {
    supabaseCli.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        window.location.href = '/login';
        return;
      }
      setAuthed(true);
      setAuthChecked(true);
      // Try to load profile (for role-based display, but tolérant si pas dispo)
      try {
        const { data } = await supabaseCli
          .from('utilisateurs')
          .select('email, role')
          .eq('email', session.user.email)
          .maybeSingle();
        if (data) setProfil({ email: data.email, role: data.role });
      } catch {
        // Si la table n'existe pas ou échec, on affiche tout quand même
      }
    });
  }, []);

  if (!authChecked || !authed) return null;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        padding: '32px 24px',
        fontFamily: "'DM Sans', sans-serif",
        color: '#e2e8f0',
      }}
    >
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
        {/* Header */}
        <div
          style={{
            marginBottom: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 36, fontWeight: 900 }}>
              🚀 Menu Hub
            </h1>
            <p style={{ margin: '8px 0 0', color: '#94a3b8', fontSize: 14 }}>
              Toutes tes sections en un seul endroit. Bookmark cette URL pour
              y accéder sans passer par la nav.
              {profil?.role && (
                <>
                  {' · '}
                  <span style={{ color: '#cbd5e1', fontWeight: 600 }}>
                    Connecté en tant que <strong>{profil.role}</strong>
                  </span>
                </>
              )}
            </p>
          </div>
          <a
            href="/"
            style={{
              padding: '10px 18px',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              textDecoration: 'none',
              fontSize: 13,
              fontWeight: 700,
              border: '1px solid rgba(255,255,255,0.15)',
            }}
          >
            ← Dashboard classique
          </a>
        </div>

        {/* Categories */}
        {CATEGORIES.map((cat) => (
          <section key={cat.title} style={{ marginBottom: 32 }}>
            <h2
              style={{
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: 2,
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: 12,
              }}
            >
              {cat.emoji} {cat.title}
            </h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 12,
              }}
            >
              {cat.tiles.map((tile) => (
                <TileCard key={tile.label} tile={tile} />
              ))}
            </div>
          </section>
        ))}

        {/* Footer */}
        <div
          style={{
            marginTop: 40,
            padding: 16,
            borderRadius: 12,
            background: 'rgba(255,255,255,0.05)',
            fontSize: 12,
            color: '#94a3b8',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          💡 <strong>Astuce</strong> : tu peux accéder à ce menu en tapant
          directement <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4 }}>
            /menu
          </code> dans la barre d'adresse. Bookmark cette URL.
          <br />
          Les pages <strong>standalone</strong> (Amazon SP-API Hub) ne sont
          pas dans la nav du dashboard — elles ont leur propre URL.
        </div>
      </div>
    </div>
  );
}

function TileCard({ tile }: { tile: Tile }) {
  return (
    <a
      href={tile.href}
      style={{
        display: 'block',
        padding: 16,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.06)',
        border: '2px solid rgba(255,255,255,0.08)',
        textDecoration: 'none',
        color: '#fff',
        transition: 'all 0.2s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-3px)';
        e.currentTarget.style.border = `2px solid ${tile.color}`;
        e.currentTarget.style.background = `linear-gradient(135deg, rgba(255,255,255,0.08) 0%, ${tile.color}20 100%)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.border = '2px solid rgba(255,255,255,0.08)';
        e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
      }}
    >
      {tile.isStandalone && (
        <span
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            fontSize: 9,
            padding: '3px 7px',
            borderRadius: 999,
            background: tile.color,
            color: '#fff',
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
          }}
        >
          Page dédiée
        </span>
      )}
      <div
        style={{
          fontSize: 28,
          marginBottom: 8,
          color: tile.color,
        }}
      >
        {tile.icon}
      </div>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>
        {tile.label}
      </div>
      <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>
        {tile.description}
      </div>
    </a>
  );
}
