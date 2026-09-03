/**
 * Extraction d'un programme de booking depuis son document d'origine.
 *
 * Le PDF part directement chez Claude en vision native via le Vercel AI
 * Gateway — meme mecanique que `commandes-pdf-ai-parser.ts`, parce que la
 * mise en page COMPTE : la grille Parts Canada est un tableau de 22 lignes sur
 * 7 colonnes ou le seuil et le pourcentage alternent. Extraire le texte
 * d'abord melangerait les colonnes et donnerait des paliers faux.
 *
 * POURQUOI CE N'EST PAS UN PARSEUR DETERMINISTE
 * Les 27 programmes lus n'ont aucune structure commune. KTM met sa grille dans
 * un tableau a cinq colonnes, Kawasaki en empile deux avec des sous-minimums,
 * Parts Canada aligne 132 nombres sans en-tetes repetes, Mercury arrive en
 * corps de courriel. Ecrire une regle par fournisseur, c'est reecrire le code
 * a chaque saison.
 *
 * POURQUOI RIEN N'EST ACTIVE AUTOMATIQUEMENT
 * Ces chiffres pilotent des commandes a cinq chiffres. L'extraction sort avec
 * un niveau de confiance et une liste d'incertitudes, et atterrit dans
 * sc_booking_imports en « a valider ». C'est un humain qui la promeut en
 * programme actif.
 *
 * Requiert AI_GATEWAY_API_KEY dans l'env.
 */

import { generateText, Output } from 'ai'
import { z } from 'zod'

// Claude Opus 5 et pas Haiku, contrairement au parseur de commandes Traction.
// Ce dernier lit un tableau regulier a colonnes fixes ; ici il faut tenir 132
// paliers repartis sur 22 baremes, distinguer un seuil en dollars d'un seuil
// en unites, et convertir « 1/3 en avril 2027 » en jours depuis la commande.
// Le volume est de quelques dizaines de documents par an — le surcout est
// negligeable devant une grille mal lue.
const MODELE = 'anthropic/claude-opus-5'

// ═══════════════════════════════════════════════════════════════════════
// Le schema de sortie — il calque sc_booking_programmes / _paliers / _bonus
// ═══════════════════════════════════════════════════════════════════════

const AxeEnum = z.enum(['tout', 'categorie', 'marque', 'ligne', 'codes'])

const EcheanceSchema = z.object({
  part: z.number().describe('Fraction de la facture, entre 0 et 1. Les parts somment a 1.'),
  jours: z.number().describe('Jours entre la facturation et ce versement.'),
})

const SousMinimumSchema = z.object({
  axe: AxeEnum,
  cible: z.array(z.string()),
  montant: z.number(),
  libelle: z.string().nullable(),
})

const PalierSchema = z.object({
  bareme: z.string().describe('Nom de la grille. « global » quand le programme n en a qu une.'),
  axe: AxeEnum,
  cible: z.array(z.string()).describe('Valeurs visees sur cet axe. Vide si axe = tout.'),
  rang: z.number().describe('Ordre croissant du palier dans son bareme, a partir de 1.'),
  niveau: z.string().nullable().describe('Le nom du palier tel qu ecrit : « A », « DIAMOND », « Niveau 3 ».'),
  seuil_montant: z.number(),
  seuil_qte: z.number().nullable().describe('Rempli UNIQUEMENT si le seuil est en unites et non en dollars.'),
  seuil_sur: z.enum(['groupe', 'commande']),
  escompte_pct: z.number(),
  sous_minimums: z.array(SousMinimumSchema),
  echeancier: z.array(EcheanceSchema),
  franco_port: z.boolean(),
  notes: z.string().nullable(),
})

const BonusSchema = z.object({
  type: z.enum(['hatif', 'paiement_rapide', 'sous_ensemble', 'commandes_bonus', 'transport']),
  groupe: z.string().describe('Les bonus d un meme groupe se concurrencent ; deux groupes s additionnent.'),
  libelle: z.string(),
  valeur_pct: z.number(),
  avant_le: z.string().nullable().describe('AAAA-MM-JJ. Date limite pour en beneficier.'),
  jours: z.number().nullable().describe('Pour paiement_rapide : le delai. « 2 % 10 net » -> 10.'),
  axe: AxeEnum,
  cible: z.array(z.string()),
  notes: z.string().nullable(),
})

const ProgrammeSchema = z.object({
  est_un_programme: z.boolean()
    .describe('false si le document n est pas un programme de reservation (facture, catalogue, courriel sans grille).'),
  nom: z.string(),
  fournisseur_annonce: z.string().describe('Le fournisseur tel que le document le nomme.'),
  fournisseur_traction: z.string().nullable()
    .describe('Le nom EXACT tire de la liste fournie, ou null si aucun ne correspond avec certitude.'),
  saison: z.string().nullable(),

  ouvre_le: z.string().nullable().describe('AAAA-MM-JJ'),
  ferme_le: z.string().nullable().describe('AAAA-MM-JJ'),
  livraison_debut: z.string().nullable(),
  livraison_fin: z.string().nullable(),
  couvre_debut: z.string().nullable().describe('Debut de la periode que la commande doit couvrir, si le document le dit.'),
  couvre_fin: z.string().nullable(),

  min_commande: z.number().nullable(),
  min_reappro: z.number().nullable(),
  franco_seuil: z.number().nullable(),
  retour_pct: z.number().nullable(),
  baremes_exclusifs: z.boolean()
    .describe('true si chaque piece ne compte que dans un seul bareme (grille par categorie). false si les baremes se cumulent.'),

  perimetre_lignes: z.array(z.string()),
  perimetre_marques: z.array(z.string()),
  perimetre_categories: z.array(z.string()),
  exclus_codes: z.array(z.string()),

  paliers: z.array(PalierSchema),
  bonus: z.array(BonusSchema),

  liens_portail: z.array(z.string())
    .describe('URL de portail concessionnaire ou le vrai formulaire se trouve (eBiz, K-Web, DEX, Central Force...).'),
  notes: z.string().nullable().describe('Conditions en clair qui ne rentrent dans aucun champ.'),

  confiance: z.number().describe('Entre 0 et 1. Ta confiance globale dans cette extraction.'),
  incertitudes: z.array(z.string())
    .describe('Ce dont tu n es pas sur, en francais, une phrase par point. Vide si tout est clair.'),
})

export type ProgrammeExtrait = z.infer<typeof ProgrammeSchema>

export interface ResultatExtraction {
  success: boolean
  programme?: ProgrammeExtrait
  duree_ms?: number
  modele?: string
  erreur?: string
}

// ═══════════════════════════════════════════════════════════════════════
// Le prompt
// ═══════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Tu lis un programme de reservation ("booking", "precommande", "stocking program") envoye par un distributeur de pieces de sport motorise a un concessionnaire canadien, et tu en extrais la grille commerciale sous forme structuree.

Le document peut etre un PDF, un tableur, ou le corps d'un courriel. Il est en francais ou en anglais.

════════ LE MODELE A REMPLIR ════════

Un programme se decompose en BAREMES, PALIERS et BONUS.

Un BAREME est une grille de paliers qui se concurrencent : un seul palier s'applique, le meilleur atteint. Deux baremes DIFFERENTS se cumulent.

  · Programme simple (un seul escompte de volume) -> un seul bareme, nomme "global", axe "tout".
  · Grille par categorie de produit (ex. une colonne par famille : Pneus, Casques, Batteries...) -> UN BAREME PAR FAMILLE, avec axe "categorie" ou "marque" selon que la famille designe un type de produit ou une marque. Mets alors baremes_exclusifs = true.
  · Escompte general PLUS un supplement sur une sous-famille -> deux baremes qui se cumulent, baremes_exclusifs = false.

seuil_sur : "groupe" quand le seuil se mesure sur le sous-ensemble du bareme ; "commande" quand il se mesure sur le total de la commande. Exemple de "commande" : "20 % sur les roulements pour toute commande de 1 000 $ et plus" — le 1 000 $ porte sur la commande entiere, pas sur les roulements.

seuil_qte : a remplir UNIQUEMENT si le seuil est exprime en UNITES ("une commande de plus de 100 batteries"). Sinon laisse null et mets le montant en dollars dans seuil_montant.

sous_minimums : conditions supplementaires a remplir pour debloquer le palier. "15 000 $ au total DONT 3 000 $ de pieces d'entretien" -> seuil_montant 15000, et un sous_minimum {axe:"categorie", cible:["Filtre","Plaquette","Courroie"], montant:3000, libelle:"pieces d'entretien"}.

echeancier : les termes de paiement du palier, en PARTS et en JOURS depuis la facturation.
  · "net 30" -> [{part:1, jours:30}]
  · "90 jours, 3 paiements" -> [{part:0.3333,jours:30},{part:0.3333,jours:60},{part:0.3334,jours:90}]
  · "1/3 avril 2027, 1/3 mai 2027, 1/3 juin 2027" -> CONVERTIS les dates calendaires en jours depuis la date d'ouverture du programme. Si le programme ouvre en aout 2026, avril 2027 est a environ 240 jours.
  · "1/2 le 15 avril et 1/2 le 15 mai 2027" -> deux parts de 0.5.
  Laisse [] si le document ne dit rien des termes.

BONUS — tout ce qui ne rentre pas dans une grille :
  · "hatif" : un escompte conditionne a une DATE ("3 % si recu au 15 septembre", "+5 % pour commande hative avant le 10 octobre").
  · "paiement_rapide" : un escompte contre un paiement rapide ("2 % 10 net" -> valeur_pct 2, jours 10). ATTENTION : c'est souvent une ALTERNATIVE au dating, pas un cumul.
  · "sous_ensemble" : un pourcentage de plus sur une famille, sans palier.
  · "commandes_bonus" : des commandes ulterieures a taux reduit.
  · "transport" : transport prepaye ou gratuit.

groupe : quand un document offre une ECHELLE de dates decroissante ("3 % au 15 sept, 2 % au 15 oct, 1 % au 15 dec"), ces trois-la sont dans le MEME groupe — un seul s'applique. Un avantage independant ("2 % de plus si confirme au 22 septembre") va dans un groupe DIFFERENT, parce qu'il s'ajoute. Utilise des noms de groupe parlants.

════════ REGLES ABSOLUES ════════

1. N'INVENTE JAMAIS UN CHIFFRE. Si le document annonce "jusqu'a 12 %" sans publier la grille, mets un seul palier a 12 % avec seuil_montant 0, et ecris dans incertitudes que la grille reelle n'est pas dans ce document.

2. Si le document est un formulaire de commande, un catalogue, une facture ou un courriel sans conditions commerciales, mets est_un_programme = false et laisse le reste vide.

3. Les dates sortent en AAAA-MM-JJ. Si l'annee n'est pas ecrite, deduis-la du contexte et signale-le dans incertitudes.

4. Les pourcentages sont des nombres : 12 et non 0.12 ni "12 %".

5. Les montants sont des nombres sans separateur : 47000 et non "47 000 $".

6. RECOPIE les seuils et pourcentages du tableau ligne par ligne, sans en sauter ni en reordonner. Une grille de 22 familles sur 6 niveaux fait 132 paliers : produis-les tous.

7. incertitudes doit etre HONNETE et precis. Signale : une colonne illisible, une annee devinee, une condition que tu n'as pas su modeliser, un tableau qui semble tronque. Un import avec des incertitudes claires vaut mieux qu'un import faussement sur de lui — un humain relira.

8. Ne remplis fournisseur_traction que si un nom de la liste correspond SANS AMBIGUITE. Sinon null : quelqu'un fera le rapprochement a la main, une seule fois.`

/**
 * Le rapprochement au nom Traction est la seule chose que l'IA ne peut pas
 * deviner : le feed tronque les noms a 26 caracteres, si bien que CFMOTO
 * s'appelle « Canada Motor Import (CF Mo ». On lui donne donc la liste.
 */
function promptFournisseurs(noms: string[]): string {
  if (!noms.length) return ''
  return `\n\n════════ LES FOURNISSEURS DU SYSTEME ════════
Voici les noms EXACTS tels qu'ils existent dans l'ERP. Certains sont tronques a 26 caracteres — c'est normal, recopie-les tels quels.

${noms.map(n => `  · ${n}`).join('\n')}

Choisis celui qui correspond au document et mets-le dans fournisseur_traction, a la lettre pres. Si aucun ne correspond avec certitude, mets null.`
}

export interface DemandeExtraction {
  /** Le document. PDF ou image -> `data` + `mediaType`. Courriel ou tableur -> `texte`. */
  data?: Uint8Array
  mediaType?: string
  texte?: string
  nomFichier?: string
  /** Les noms de fournisseurs de l'ERP, pour le rapprochement. */
  fournisseurs?: string[]
  /** Contexte utile : expediteur du courriel, objet, date de reception. */
  contexte?: string
}

export async function extraireProgramme(d: DemandeExtraction): Promise<ResultatExtraction> {
  const t0 = Date.now()
  try {
    if (!d.data && !d.texte) {
      return { success: false, erreur: 'Ni fichier ni texte a analyser.' }
    }

    const consigne = [
      'Extrais le programme de reservation de ce document.',
      d.contexte ? `\nContexte du courriel :\n${d.contexte}` : '',
      d.texte ? `\n════════ CONTENU ════════\n${d.texte}` : '',
    ].filter(Boolean).join('\n')

    const contenu: any[] = []
    if (d.data) {
      // La donnee doit etre un Uint8Array pur, pas un Buffer Node.
      const src = d.data
      const ab = new ArrayBuffer(src.byteLength)
      const copie = new Uint8Array(ab)
      copie.set(src)
      contenu.push({
        type: 'file',
        mediaType: d.mediaType || 'application/pdf',
        data: copie,
        filename: d.nomFichier || 'programme.pdf',
      })
    }
    contenu.push({ type: 'text', text: consigne })

    const result = await generateText({
      model: MODELE,
      system: SYSTEM_PROMPT + promptFournisseurs(d.fournisseurs || []),
      messages: [{ role: 'user', content: contenu }],
      output: Output.object({ schema: ProgrammeSchema }),
      // Une grille de 132 paliers fait un gros JSON. Trop serrer ici tronque
      // l'extraction en plein tableau, et le programme ressort ampute.
      maxOutputTokens: 32000,
      temperature: 0,
    })

    const programme = result.output as ProgrammeExtrait
    return {
      success: true,
      programme: normaliser(programme),
      duree_ms: Date.now() - t0,
      modele: MODELE,
    }
  } catch (e: any) {
    return { success: false, erreur: e?.message || String(e), duree_ms: Date.now() - t0 }
  }
}

/**
 * Garde-fous sur ce qui revient du modele. On ne corrige pas les chiffres —
 * on refuse seulement les formes qui feraient planter l'insertion, et on
 * signale ce qui a ete redresse pour que le relecteur le voie.
 */
function normaliser(p: ProgrammeExtrait): ProgrammeExtrait {
  const incertitudes = [...(p.incertitudes || [])]
  const dateOk = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null)

  for (const champ of ['ouvre_le', 'ferme_le', 'livraison_debut', 'livraison_fin', 'couvre_debut', 'couvre_fin'] as const) {
    if (p[champ] && !dateOk(p[champ])) {
      incertitudes.push(`La date « ${champ} » n'etait pas au format AAAA-MM-JJ et a ete ignoree.`)
      ;(p as any)[champ] = null
    }
  }

  const paliers = (p.paliers || []).filter(pl => {
    const bon = Number.isFinite(pl.escompte_pct) && Number.isFinite(pl.seuil_montant)
    if (!bon) incertitudes.push(`Un palier du bareme « ${pl.bareme} » avait un seuil ou un escompte illisible et a ete ecarte.`)
    return bon
  })

  // Un echeancier dont les parts ne somment pas a 1 fausserait le calcul du
  // dating sans jamais lever d'erreur. On le signale plutot que de le corriger
  // en douce : c'est peut-etre le document qui est ambigu.
  for (const pl of paliers) {
    if (!Array.isArray(pl.echeancier) || pl.echeancier.length === 0) continue
    const somme = pl.echeancier.reduce((s, e) => s + (Number(e.part) || 0), 0)
    if (Math.abs(somme - 1) > 0.02) {
      incertitudes.push(
        `Les versements du palier « ${pl.niveau ?? pl.bareme} » totalisent ${(somme * 100).toFixed(0)} % ` +
        `et non 100 % : l'echeancier est a verifier.`)
    }
  }

  return { ...p, paliers, incertitudes }
}
