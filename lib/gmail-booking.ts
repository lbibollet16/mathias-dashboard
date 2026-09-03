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

export function lireConfigGmail(): ConfigGmail | null {
  const email = process.env.GMAIL_SA_EMAIL
  // Vercel stocke les sauts de ligne echappes : on les restaure, sinon la
  // signature RS256 echoue avec une erreur de cle illisible.
  const clePrivee = process.env.GMAIL_SA_PRIVATE_KEY?.replace(/\\n/g, '\n')
  const boite = process.env.GMAIL_BOOKING_MAILBOX || 'booking@mathiasms.com'
  if (!email || !clePrivee) return null
  return { email, clePrivee, boite }
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

  const signeur = createSign('RSA-SHA256')
  signeur.update(`${entete}.${charge}`)
  const signature = b64url(signeur.sign(cfg.clePrivee))
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
