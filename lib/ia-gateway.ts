/**
 * Ce que disent les pannes du Vercel AI Gateway, et ce qu'il faut en faire.
 *
 * Deux fonctionnalites l'appellent — le parseur de PDF de commandes Traction
 * et l'extraction des programmes de booking — et toutes deux ont besoin des
 * memes deux reponses :
 *
 *   · l'echec est-il PASSAGER ? De la reponse depend si on rejoue plus tard
 *     ou si on classe definitivement. Etiqueter « traite » un courriel dont
 *     l'appel n'a jamais quitte le serveur perd son programme pour de bon.
 *
 *   · que dire a l'utilisateur ? Le gateway renvoie des phrases exactes mais
 *     opaques dans leur contexte. « A positive credit balance is required for
 *     all requests, including BYOK, so fallback providers remain available »
 *     est parfaitement juste, et parfaitement inutile pour qui voit
 *     « IA indisponible » dans un ecran d'import de commandes.
 */

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

  return /credit balance|insufficient|quota|rate limit|429|50[234]|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|overloaded|unavailable|API key|unauthorized|invalid_api_key/i
    .test(e)
}

/**
 * Traduit l'erreur brute du gateway en une phrase qui dit quoi faire.
 *
 * On garde le texte d'origine en queue : c'est lui qu'on cherchera dans les
 * journaux le jour ou la cause sera ailleurs.
 */
export function messageErreurIA(erreur: string | undefined | null): string {
  const e = String(erreur || '').trim()
  if (!e) return 'Appel a l\'IA sans reponse ni message d\'erreur.'

  if (/credit balance|insufficient (funds|credit)/i.test(e)) {
    return 'Le solde du Vercel AI Gateway est a zero : aucun appel ne part. ' +
           'Charge des credits dans Vercel > ton equipe > AI > Top up.'
  }
  if (/rate limit|429|too many requests/i.test(e)) {
    return 'Le gateway limite le debit en ce moment. Reessaie dans quelques minutes — ' +
           'rien n\'est perdu, l\'operation est rejouable.'
  }
  if (/quota/i.test(e)) {
    return 'Le quota du gateway est atteint. Verifie les limites du projet dans Vercel > AI.'
  }
  if (/API key|invalid_api_key|unauthorized|401|403/i.test(e)) {
    return 'La cle AI_GATEWAY_API_KEY est absente ou refusee. ' +
           'Verifie-la dans Vercel > Settings > Environment Variables, puis redeploie.'
  }
  if (/not found|no such model|unsupported model/i.test(e) && /model/i.test(e)) {
    return `Le modele demande n'est pas disponible sur ce gateway. ${e}`
  }
  if (/overloaded|unavailable|50[234]/i.test(e)) {
    return 'Le service d\'IA est momentanement indisponible. Reessaie dans quelques minutes.'
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(e)) {
    return `L'appel a l'IA n'a pas abouti (reseau ou delai depasse). ${e}`
  }
  return e
}
