// Parser IA des PDF "Liste commande" Traction.
// On extrait le texte brut avec unpdf puis on demande à Claude (via Vercel
// AI Gateway) de produire un JSON structuré conforme au schéma Zod.
// C'est plus robuste qu'un parser regex parce que le PDF Traction a des
// colonnes de longueur variable (descriptions, noms de fournisseurs).
//
// Requiert AI_GATEWAY_API_KEY dans l'env (Vercel déploie aussi via OIDC
// si l'API key n'est pas définie).

import { generateObject } from 'ai'
import { z } from 'zod'
import { extractText } from 'unpdf'

export interface AiParsedCommande {
  num_commande:    string
  statut:          string
  date_commande:   string | null
  num_fournisseur: string | null
  nom_fournisseur: string | null
  commande_par:    string | null
  num_piece:       string
  qte_commandee:   number
  description:     string | null
  nom_employe:     string | null
}

export interface AiParseResult {
  success:    boolean
  commandes:  AiParsedCommande[]
  rawText:    string
  erreur?:    string
}

const CommandeSchema = z.object({
  num_commande:    z.string().describe('Numéro de commande Traction (ex: M1C0036824)'),
  statut:          z.string().describe('Statut : "Transmise", "Fermée", "Réception Partielle", etc.'),
  date_commande:   z.string().nullable().describe('Date au format YYYY-MM-DD, ou null si absente'),
  num_fournisseur: z.string().nullable().describe('Numéro fournisseur (ex: 20740)'),
  nom_fournisseur: z.string().nullable().describe('Nom du fournisseur (ex: "Kawasaki Canada Inc (Andre)")'),
  commande_par:    z.string().nullable().describe('Personne qui a passé la commande (format "Nom, Prénom")'),
  num_piece:       z.string().describe('Numéro de pièce (ex: 2020 ou KAW-1234)'),
  qte_commandee:   z.number().describe('Quantité commandée (entier)'),
  description:     z.string().nullable().describe('Description de la pièce'),
  nom_employe:     z.string().nullable().describe('Nom de l\'employé qui suit la commande (format "Nom, Prénom")'),
})

const ResponseSchema = z.object({
  commandes: z.array(CommandeSchema).describe('Liste de toutes les commandes trouvées dans le document'),
})

const SYSTEM_PROMPT = `Tu es un assistant qui extrait les lignes de commande d'un PDF de gestion des commandes Traction (logiciel de pièces marine au Québec).

Le document contient un tableau avec les colonnes suivantes :
- # Commande (ex: M1C0036824)
- Statut (Transmise / Fermée / Réception Partielle / Annulée)
- Date (format YYYY-MM-DD)
- # Fournisseur (4-6 chiffres, ex: 20740)
- Nom du fournisseur (peut contenir des espaces et des parenthèses)
- Commandé Par (format "Nom, Prénom")
- # Pièce (alphanumérique, ex: 2020 ou KAW-1234)
- Qte Comm (quantité, entier)
- Description (description de la pièce, peut contenir des tirets)
- Nom Employé (format "Nom, Prénom")

Extrais TOUTES les lignes de commande du document. Une même commande (#Commande) peut apparaître plusieurs fois si elle contient plusieurs pièces — dans ce cas, crée une entrée par ligne.

IGNORE les en-têtes de colonnes, les pieds de page, les numéros de page et les totaux.

Si une valeur n'est pas présente, retourne null (sauf pour num_commande, statut, num_piece et qte_commandee qui sont obligatoires).

Sois rigoureux : ne saute aucune ligne, même si le formatage est inhabituel.`

export async function parseCommandesPdfAvecIA(buffer: Buffer | Uint8Array): Promise<AiParseResult> {
  try {
    // Étape 1 — extraire le texte brut du PDF avec unpdf
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as any)
    const ab = new ArrayBuffer(src.byteLength)
    const data = new Uint8Array(ab)
    data.set(src)
    const ext = await extractText(data, { mergePages: true })
    const rawText = (typeof ext.text === 'string' ? ext.text : (ext.text as string[]).join('\n')).trim()

    if (!rawText || rawText.length < 50) {
      return {
        success: false,
        commandes: [],
        rawText,
        erreur: 'PDF vide ou texte non extractible',
      }
    }

    // Étape 2 — envoyer le texte à l'IA pour structuration
    const { object } = await generateObject({
      model: 'anthropic/claude-haiku-4.5',
      schema: ResponseSchema,
      schemaName: 'CommandesTraction',
      schemaDescription: 'Liste des commandes Traction extraites du PDF',
      system: SYSTEM_PROMPT,
      prompt: `Voici le texte extrait du PDF "Liste commande" Traction. Extrais toutes les commandes.

\`\`\`
${rawText}
\`\`\``,
      temperature: 0,
    })

    // Normalisation : zod .nullable() peut produire `undefined`, on uniformise en null
    const commandes: AiParsedCommande[] = object.commandes.map((c: any) => ({
      num_commande:    c.num_commande,
      statut:          c.statut,
      date_commande:   c.date_commande ?? null,
      num_fournisseur: c.num_fournisseur ?? null,
      nom_fournisseur: c.nom_fournisseur ?? null,
      commande_par:    c.commande_par ?? null,
      num_piece:       c.num_piece,
      qte_commandee:   typeof c.qte_commandee === 'number' ? c.qte_commandee : 0,
      description:     c.description ?? null,
      nom_employe:     c.nom_employe ?? null,
    }))

    return {
      success: true,
      commandes,
      rawText,
    }
  } catch (e: any) {
    return {
      success: false,
      commandes: [],
      rawText: '',
      erreur: e.message || String(e),
    }
  }
}
