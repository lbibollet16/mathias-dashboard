/**
 * Ce que disent les pannes d'acces a Claude, et ce qu'il faut en faire.
 *
 * Deux fonctionnalites l'appellent — le parseur de PDF de commandes Traction
 * et l'extraction des programmes de booking — et deux chemins d'acces peuvent
 * echouer : l'API Anthropic directe et le Vercel AI Gateway.
 *
 * DEUX LECONS APPRISES A LA DURE, LE 3 SEPTEMBRE 2026
 *
 * 1. Une traduction qui ne sait pas QUI a echoue envoie corriger la mauvaise
 *    chose. La premiere version disait « la cle AI_GATEWAY_API_KEY est
 *    absente ou refusee » alors que c'etait l'API Anthropic qui refusait la
 *    sienne. Le fournisseur est donc un parametre, pas une supposition.
 *
 * 2. Une traduction qui REMPLACE le message d'origine detruit le diagnostic.
 *    « La cle est refusee » ne dit pas si elle est mal copiee, revoquee, ou
 *    si c'est le compte qui n'a plus de credit — trois causes, trois gestes
 *    differents. Le texte brut est desormais toujours conserve en queue.
 */

export type Fournisseur = 'anthropic' | 'gateway'

/**
 * Une panne d'ENVIRONNEMENT, par opposition a un document illisible.
 *
 * Le solde de credits vient en tete parce que c'est celle qui frappe tout
 * d'un coup : la premiere releve de booking@ a echoue sur ses 23 documents
 * en quelques secondes, sans qu'un seul appel ne parte.
 */
export function pannePassagere(erreur: string | undefined | null): boolean {
  if (!erreur) return false
  const e = String(erreur)

  // Un nom de modele invalide n'est pas « passager » au sens ou reessayer
  // suffirait — il faut corriger le code. Mais il frappe TOUS les documents
  // de la meme facon qu'un solde a zero, et les classer definitifs perdrait
  // toute une boite pour une faute de frappe. Ce qui compte ici n'est pas
  // « est-ce que ca guerira tout seul » mais « le document a-t-il ete lu ».
  if (/no such model|unsupported model/i.test(e)) return true
  if (/model/i.test(e) && /not found|does not exist|unavailable/i.test(e)) return true

  return /credit balance|insufficient|quota|rate limit|429|50[234]|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|overloaded|unavailable|API key|unauthorized|authentication|invalid_api_key|Streaming is required/i
    .test(e)
}

/** Ou l'on corrige, selon le chemin qui a echoue. */
const OU_CORRIGER: Record<Fournisseur, { variable: string; solde: string }> = {
  anthropic: {
    variable: 'ANTHROPIC_API_KEY',
    solde: 'console.anthropic.com > Billing',
  },
  gateway: {
    variable: 'AI_GATEWAY_API_KEY',
    solde: 'Vercel > ton equipe > AI > Top up',
  },
}

/**
 * Traduit l'erreur brute en une phrase qui dit quoi faire, SANS jamais perdre
 * le texte d'origine : c'est lui qu'on cherchera le jour ou la cause sera
 * ailleurs que dans les cas prevus.
 */
export function messageErreurIA(
  erreur: string | undefined | null,
  fournisseur: Fournisseur = 'gateway',
): string {
  const e = String(erreur || '').trim()
  if (!e) return 'Appel a Claude sans reponse ni message d\'erreur.'

  const ou = OU_CORRIGER[fournisseur]
  const brut = ` [${fournisseur} a repondu : ${e.slice(0, 220)}]`

  if (/credit balance|insufficient (funds|credit)|balance is too low/i.test(e)) {
    return `Le solde est a zero : aucun appel ne part. Charge des credits dans ${ou.solde}.${brut}`
  }
  if (/rate limit|429|too many requests/i.test(e)) {
    return `Le service limite le debit en ce moment. Reessaie dans quelques minutes — ` +
           `rien n'est perdu, l'operation est rejouable.${brut}`
  }
  if (/quota/i.test(e)) {
    return `Le quota est atteint. Verifie les limites du compte.${brut}`
  }
  if (/authentication|invalid x-api-key|invalid_api_key|API key|unauthorized|\b401\b|\b403\b/i.test(e)) {
    return `La cle ${ou.variable} est absente, mal copiee ou revoquee. Verifie-la dans ` +
           `Vercel > Settings > Environment Variables, puis redeploie. Verifie aussi qu'elle ` +
           `est encore active et que le compte a du credit (${ou.solde}).${brut}`
  }
  if (/Streaming is required/i.test(e)) {
    return `Le SDK exige le streaming pour une reponse de cette taille. C'est un defaut de ` +
           `code, pas de configuration.${brut}`
  }
  if (/no such model|unsupported model/i.test(e) || (/model/i.test(e) && /not found/i.test(e))) {
    return `Le modele demande n'est pas disponible sur ce chemin d'acces.${brut}`
  }
  if (/overloaded|unavailable|50[234]/i.test(e)) {
    return `Le service est momentanement indisponible. Reessaie dans quelques minutes.${brut}`
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(e)) {
    return `L'appel n'a pas abouti (reseau ou delai depasse).${brut}`
  }
  return e
}
