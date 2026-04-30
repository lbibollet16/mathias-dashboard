// Helper d'équilibrage des prix unitaires LAUTOPAK pour qu'une liste de lignes
// totalise EXACTEMENT un montant cible. Logique identique à l'ancien
// balanceGroupLines de /api/amazon/closure/lautopak-lines/route.ts.
//
// Garantie : prix_unitaire × qty (calculé en cents entiers) = amount, et
//            sum(amount) = targetTotal au cent près quand qty totale > 0.
//
// Stratégie :
//   1. Calcul du prix unitaire au 0,10 $ près (10 cents entiers)
//   2. Si delta vs target > 0,10×qty : steps de 0,10 sur les lignes à plus
//      grande qty (max 30 steps par ligne pour éviter dérives extrêmes)
//   3. Si résiduel < 0,10×qty : ajustement final en cents sur la plus grande
//      ligne pour absorber le reste

export interface BalanceableLine {
  qty: number
  amount: number          // sera mis à jour pour balancer
  prix_unitaire: number    // sera mis à jour
}

export function balanceLignes<T extends BalanceableLine>(
  lines: T[],
  targetTotal: number
): { adjustments: number; delta_residuel: number } {
  const toCents = (n: number) => Math.round(n * 100)
  const toDollars = (c: number) => c / 100

  // Étape 1 : prix unitaire au 0,10 près. On garde le signe de amount sur la
  // ligne (positif pour Doc 1 ventes, négatif pour Doc 2 notes de crédit).
  for (const l of lines) {
    const absQty = Math.abs(l.qty)
    if (absQty === 0) { l.prix_unitaire = 0; l.amount = 0; continue }
    const sign = l.amount < 0 ? -1 : 1
    const rawCents = Math.abs(l.amount * 100) / absQty
    const roundedTenCents = Math.round(rawCents / 10) * 10
    l.prix_unitaire = toDollars(roundedTenCents)
    l.amount = toDollars(absQty * roundedTenCents) * sign
  }

  // Étape 2 : delta vs target
  const sumCents = lines.reduce((s, l) => s + toCents(l.amount), 0)
  const targetCents = toCents(targetTotal)
  let deltaCents = targetCents - sumCents
  if (deltaCents === 0) return { adjustments: 0, delta_residuel: 0 }

  const direction = deltaCents > 0 ? 1 : -1
  let remainingCents = Math.abs(deltaCents)
  let adjustments = 0
  const sorted = [...lines].filter(l => Math.abs(l.qty) > 0)
    .sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty))

  // Étape 3 : steps de 10 cents (= 0,10 $) sur les lignes à plus grande qty
  for (const l of sorted) {
    if (remainingCents <= 0) break
    const absQty = Math.abs(l.qty)
    const stepCents = absQty * 10
    const maxSteps = Math.floor(remainingCents / stepCents)
    if (maxSteps > 0) {
      const steps = Math.min(maxSteps, 30)
      const sign = l.amount < 0 ? -1 : 1
      const newPriceCents = toCents(l.prix_unitaire) + direction * steps * 10
      l.prix_unitaire = toDollars(newPriceCents)
      l.amount = toDollars(absQty * newPriceCents) * sign
      remainingCents -= steps * stepCents
      adjustments++
    }
  }

  // Étape 4 : résiduel < stepCents = 10×qty. On ajuste en cents sur la plus
  // grande ligne. Chaque +1 cent sur le prix ajoute absQty cents au montant.
  if (remainingCents > 0 && sorted.length > 0) {
    const biggest = sorted[0]
    const absQty = Math.abs(biggest.qty)
    if (absQty > 0) {
      const priceCentsChange = Math.round(remainingCents / absQty)
      if (priceCentsChange > 0) {
        const sign = biggest.amount < 0 ? -1 : 1
        const newPriceCents = toCents(biggest.prix_unitaire) + direction * priceCentsChange
        biggest.prix_unitaire = toDollars(newPriceCents)
        biggest.amount = toDollars(absQty * newPriceCents) * sign
        adjustments++
      }
    }
  }

  // Résiduel final
  const finalSumCents = lines.reduce((s, l) => s + toCents(l.amount), 0)
  return {
    adjustments,
    delta_residuel: toDollars(Math.abs(targetCents - finalSumCents)),
  }
}
