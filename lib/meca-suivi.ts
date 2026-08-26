// Étiquettes de suivi qu'un aviseur pose sur un bon de travail ouvert.
// Partagé client/serveur : le serveur valide, le client affiche + colore.
// Fichier sans directive 'use client' pour rester importable des deux côtés.

export const SUIVI_STATUTS = [
  'Pièce en commande',
  'Planifié',
  'Problème client',
  'En attente client',
  'En attente approbation',
  'En cours',
  'Prêt à facturer',
  'Fermé',
] as const

export type SuiviStatut = typeof SUIVI_STATUTS[number]

export function estStatutValide(s: any): s is SuiviStatut {
  return typeof s === 'string' && (SUIVI_STATUTS as readonly string[]).includes(s)
}

// Clé de couleur logique — le composant la traduit dans la palette du thème (C).
export function tonStatut(s: string | null | undefined): 'red' | 'yellow' | 'blue' | 'green' | 'neutre' {
  switch (s) {
    case 'Problème client':          return 'red'
    case 'Pièce en commande':        return 'yellow'
    case 'En attente client':        return 'yellow'
    case 'En attente approbation':   return 'yellow'
    case 'Planifié':                 return 'blue'
    case 'En cours':                 return 'blue'
    case 'Prêt à facturer':          return 'green'
    case 'Fermé':                    return 'green'
    default:                         return 'neutre'
  }
}
