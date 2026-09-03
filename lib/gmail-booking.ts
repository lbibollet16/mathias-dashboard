/**
 * Lecture de la boite booking@mathiasms.com par l'API Gmail.
 *
 * AUTHENTIFICATION : compte de service avec delegation au niveau du domaine.
 * mathiasms.com est sur Google Workspace, ce qui permet a un compte de service
 * d'emprunter l'identite d'une boite du domaine sans consentement interactif.
 * Consequences, toutes bonnes pour un cron :
 *   · aucun refresh token a stocker ni a faire tourner
 *   · aucune verification Google a passer — l'app est interne au domaine
 *   · le rattrapage d'historique marche : la boite contient deja tout
 *
 * On signe le JWT avec le `crypto` de Node plutot que d'ajouter `googleapis`,
 * qui pese plusieurs megaoctets pour trois appels REST.
 *
 * VARIABLES D'ENVIRONNEMENT (a mettre dans Vercel, jamais dans le depot) :
 *   GMAIL_SA_EMAIL        courriel du compte de service
 *   GMAIL_SA_PRIVATE_KEY  la cle privee PEM du fichier JSON, champ private_key
 *   GMAIL_BOOKING_MAILBOX la boite a lire (defaut booking@mathiasms.com)
 */

import { createSign } from 'node:crypto'

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://gmail.googleapis.com/gmail/v1'

/** Le libelle pose sur un message analyse, pour ne jamais le relire. */
export const LIBELLE_TRAITE = 'Booking traité'

export interface ConfigGmail {
  email: string
  clePrivee: string
  boite: string
}

/**
 * Remet une cle privee en forme PEM, quelle que soit la facon dont elle a ete
 * collee dans Vercel.
 *
 * OpenSSL refuse tout ecart avec un message opaque —
 * `error:1E08010C:DECODER routines::unsupported` — qui ne dit pas ce qui
 * cloche. Quatre accidents arrivent en pratique, et tous les quatre donnent
 * exactement ce meme message :
 *   · les guillemets du JSON colles avec la valeur
 *   · les \n restes litteraux, ou au contraire deja convertis
 *   · des retours chariot Windows glisses par le copier-coller
 *   · le fichier JSON ENTIER colle au lieu du seul champ private_key
 * On les rattrape tous ici plutot que de renvoyer l'utilisateur a l'aveugle.
 */
export function normaliserClePrivee(brut: string): string {
  let k = brut.trim()

  // Le fichier JSON complet : on en extrait le champ qui nous interesse.
  if (k.startsWith('{')) {
    try {
      const j = JSON.parse(k)
      if (typeof j.private_key === 'string') k = j.private_key.trim()
    } catch { /* on continue avec la valeur brute */ }
  }

  // Guillemets englobants, simples ou doubles.
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim()
  }

  // Sauts de ligne echappes, puis retours chariot.
  k = k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r/g, '')

  // Un PEM arrive parfois sur une seule ligne : on recoupe le base64 en 64.
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/)
  if (m && !m[2].trim().includes('\n')) {
    const lignes = m[2].replace(/\s+/g, '').match(/.{1,64}/g) || []
    k = `-----BEGIN ${m[1]}-----\n${lignes.join('\n')}\n-----END ${m[1]}-----\n`
  }

  if (!k.endsWith('\n')) k += '\n'
  return k
}

/**
 * Ce qui cloche dans la cle, en clair, sans jamais l'afficher. C'est ce que le
 * diagnostic renvoie a l'ecran quand la signature echoue.
 */
export function diagnostiquerCle(brut: string | undefined): string | null {
  if (!brut) return 'GMAIL_SA_PRIVATE_KEY est vide ou absente.'

  // On juge le resultat de la normalisation, pas la forme d'entree : coller le
  // fichier JSON entier, ou une cle a guillemets, ou en une seule ligne, se
  // rattrape sans probleme. Ne signaler que ce qui est vraiment perdu — sinon
  // on refuse une cle qui aurait parfaitement fonctionne.
  const k = normaliserClePrivee(brut)

  if (!k.includes('-----BEGIN')) {
    if (brut.trim().startsWith('{')) {
      return 'La valeur ressemble a un fichier JSON, mais son champ private_key est illisible. ' +
             'Colle plutot le contenu de ce champ seul, de « -----BEGIN PRIVATE KEY----- » a ' +
             '« -----END PRIVATE KEY----- ».'
    }
    return 'La cle ne commence pas par « -----BEGIN PRIVATE KEY----- ». C\'est peut-etre le champ ' +
           'private_key_id — un identifiant court — qui a ete colle au lieu de private_key.'
  }
  if (!k.includes('-----END')) {
    return 'La cle n\'a pas de ligne « -----END PRIVATE KEY----- » : elle a ete tronquee au ' +
           'copier-coller. Recolle-la en entier.'
  }
  const corps = k.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  if (corps.length < 1000) {
    return `Le corps de la cle ne fait que ${corps.length} caracteres — une cle de compte de ` +
           `service en fait environ 1 600. Elle est incomplete.`
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(corps)) {
    return 'Le corps de la cle contient des caracteres qui ne sont pas du base64 : des guillemets ' +
           'ou des espaces se sont glisses dedans.'
  }
  return null
}

export function lireConfigGmail(): ConfigGmail | null {
  // Les guillemets se collent facilement avec le courriel aussi, et Gmail
  // repondrait alors un 400 incomprehensible sur l'adresse.
  const email = process.env.GMAIL_SA_EMAIL?.trim().replace(/^["']|["']$/g, '')
  const brut = process.env.GMAIL_SA_PRIVATE_KEY
  const boite = (process.env.GMAIL_BOOKING_MAILBOX || 'booking@mathiasms.com')
    .trim().replace(/^["']|["']$/g, '')
  if (!email || !brut) return null
  return { email, clePrivee: normaliserClePrivee(brut), boite }
}

function b64url(x: Buffer | string): string {
  return Buffer.from(x).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Echange un JWT signe contre un jeton d'acces, en empruntant l'identite de
 * la boite. `sub` est la cle de la delegation : sans lui, le compte de service
 * n'a acces qu'a lui-meme et Gmail repond 400.
 */
export async function jetonAcces(cfg: ConfigGmail): Promise<string> {
  const maintenant = Math.floor(Date.now() / 1000)
  const entete = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const charge = b64url(JSON.stringify({
    iss: cfg.email,
    sub: cfg.boite,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: maintenant,
    exp: maintenant + 3600,
  }))

  let signature: string
  try {
    const signeur = createSign('RSA-SHA256')
    signeur.update(`${entete}.${charge}`)
    signature = b64url(signeur.sign(cfg.clePrivee))
  } catch (e: any) {
    // OpenSSL ne dit jamais CE qui cloche dans le PEM. On le dit a sa place.
    const detail = diagnostiquerCle(process.env.GMAIL_SA_PRIVATE_KEY)
    throw new Error(
      `La cle privee est illisible (${e?.message || e}). ` +
      (detail || 'Le format du PEM semble correct mais OpenSSL le refuse : regenere une cle ' +
                 'JSON depuis la console Google et recolle-la.'))
  }
  const jwt = `${entete}.${charge}.${signature}`

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const j = await r.json()
  if (!r.ok || !j.access_token) {
    // Les deux echecs classiques valent une explication : ils envoient vers
    // deux consoles differentes.
    const detail = j.error_description || j.error || `HTTP ${r.status}`
    if (String(detail).includes('unauthorized_client')) {
      throw new Error(
        `Google refuse la delegation (${detail}). Le Unique ID du compte de service n'est pas ` +
        `autorise dans admin.google.com > Securite > Controle des API > Delegation au niveau du ` +
        `domaine, ou le scope ${SCOPE} n'y est pas inscrit.`)
    }
    if (String(detail).includes('invalid_grant')) {
      throw new Error(
        `Google refuse l'emprunt d'identite de « ${cfg.boite} » (${detail}). Verifie que c'est une ` +
        `vraie boite du domaine et non un groupe ou un alias : la delegation ne fonctionne que sur ` +
        `une boite.`)
    }
    throw new Error(`Authentification Gmail refusee : ${detail}`)
  }
  return j.access_token as string
}

async function appel(cfg: ConfigGmail, jeton: string, chemin: string, init?: RequestInit) {
  const r = await fetch(`${API}/users/${encodeURIComponent(cfg.boite)}${chemin}`, {
    ...init,
    headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`Gmail ${r.status} sur ${chemin} : ${txt.slice(0, 300)}`)
  }
  return r.json()
}

/** Le libelle « traite », cree au besoin. Son id est stable ensuite. */
export async function idLibelleTraite(cfg: ConfigGmail, jeton: string): Promise<string> {
  const liste = await appel(cfg, jeton, '/labels')
  const existant = (liste.labels || []).find((l: any) => l.name === LIBELLE_TRAITE)
  if (existant) return existant.id
  const cree = await appel(cfg, jeton, '/labels', {
    method: 'POST',
    body: JSON.stringify({
      name: LIBELLE_TRAITE,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  })
  return cree.id
}

export interface MessageBooking {
  id: string
  threadId: string
  expediteur: string
  destinataire: string
  objet: string
  recuLe: string
  corps: string
  pieces: { nomFichier: string; mimeType: string; attachmentId: string; taille: number }[]
  liens: string[]
}

/**
 * La requete Gmail. On ne prend PAS tout : un programme se reconnait a son
 * objet ou a une piece jointe. Le filtre reste large — c'est l'extraction qui
 * tranche ensuite si le document est un programme ou non.
 */
export function requeteRecherche(depuis?: string): string {
  const morceaux = [`-label:"${LIBELLE_TRAITE}"`, 'has:attachment OR subject:(booking OR réservation OR reservation OR precommande OR précommande OR stocking OR program OR programme)']
  if (depuis) morceaux.push(`after:${depuis}`)
  return morceaux.join(' ')
}

export async function listerMessages(
  cfg: ConfigGmail, jeton: string, requete: string, max = 25,
): Promise<{ id: string; threadId: string }[]> {
  const j = await appel(cfg, jeton,
    `/messages?q=${encodeURIComponent(requete)}&maxResults=${max}`)
  return j.messages || []
}

function entete(charge: any, nom: string): string {
  const h = (charge?.payload?.headers || []).find(
    (x: any) => String(x.name).toLowerCase() === nom.toLowerCase())
  return h?.value || ''
}

function decoder(data?: string): string {
  if (!data) return ''
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

/** Descend l'arbre MIME : le corps texte d'un cote, les pieces jointes de l'autre. */
function parcourir(partie: any, res: { corps: string[]; pieces: MessageBooking['pieces'] }) {
  if (!partie) return
  const mime = partie.mimeType || ''
  if (partie.filename && partie.body?.attachmentId) {
    res.pieces.push({
      nomFichier: partie.filename,
      mimeType: mime,
      attachmentId: partie.body.attachmentId,
      taille: Number(partie.body.size) || 0,
    })
  } else if (mime === 'text/plain' && partie.body?.data) {
    res.corps.push(decoder(partie.body.data))
  } else if (mime === 'text/html' && partie.body?.data && res.corps.length === 0) {
    // Repli quand le courriel n'a pas de version texte — Mercury arrive comme
    // ca, et c'est le corps qui porte tout le programme.
    res.corps.push(decoder(partie.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim())
  }
  for (const enfant of partie.parts || []) parcourir(enfant, res)
}

export async function lireMessage(cfg: ConfigGmail, jeton: string, id: string): Promise<MessageBooking> {
  const m = await appel(cfg, jeton, `/messages/${id}?format=full`)
  const res = { corps: [] as string[], pieces: [] as MessageBooking['pieces'] }
  parcourir(m.payload, res)
  const corps = res.corps.join('\n\n').slice(0, 100_000)

  // Les liens de portail : c'est ce qui distingue « rien a extraire » de
  // « echec d'extraction ». eBiz, K-Web et DEX demandent un login.
  const liens = [...new Set(
    (corps.match(/https?:\/\/[^\s<>"')]+/g) || [])
      .filter(u => /ebiz|honda|kweb|k-web|kawasaki|dex|polaris|centralforce|central-force|partslinq|ktm|dealer/i.test(u))
      .slice(0, 12))]

  return {
    id: m.id,
    threadId: m.threadId,
    expediteur: entete(m, 'From'),
    destinataire: entete(m, 'To'),
    objet: entete(m, 'Subject'),
    recuLe: m.internalDate
      ? new Date(Number(m.internalDate)).toISOString()
      : new Date().toISOString(),
    corps,
    pieces: res.pieces,
    liens,
  }
}

export async function telechargerPiece(
  cfg: ConfigGmail, jeton: string, idMessage: string, attachmentId: string,
): Promise<Uint8Array> {
  const j = await appel(cfg, jeton, `/messages/${idMessage}/attachments/${attachmentId}`)
  const b64 = String(j.data || '').replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export async function marquerTraite(
  cfg: ConfigGmail, jeton: string, idMessage: string, idLibelle: string,
): Promise<void> {
  await appel(cfg, jeton, `/messages/${idMessage}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: [idLibelle] }),
  })
}
