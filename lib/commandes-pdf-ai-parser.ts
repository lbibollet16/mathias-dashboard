// Parser IA des PDF "Liste commande" Traction.
// On envoie le PDF DIRECTEMENT à Claude (vision native, supportée via le
// Vercel AI Gateway). Pas besoin d'extraction texte préalable — Claude lit
// la mise en page du tableau et nous renvoie un JSON structuré.
//
// Requiert AI_GATEWAY_API_KEY dans l'env.

import { generateText, Output } from 'ai'
import { z } from 'zod'

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
  duree_ms?:  number
  erreur?:    string
}

const CommandeSchema = z.object({
  num_commande:    z.string(),
  statut:          z.string(),
  date_commande:   z.string().nullable(),
  num_fournisseur: z.string().nullable(),
  nom_fournisseur: z.string().nullable(),
  commande_par:    z.string().nullable(),
  num_piece:       z.string(),
  qte_commandee:   z.number(),
  description:     z.string().nullable(),
  nom_employe:     z.string().nullable(),
})

const ResponseSchema = z.object({
  commandes: z.array(CommandeSchema),
})

const SYSTEM_PROMPT = `Tu extrais les lignes d'un tableau "Liste des commandes" Traction (logiciel de pièces marine au Québec).

Le PDF contient un tableau avec ces colonnes :
- # Commande (ex: M1C0036824)
- Statut (Transmise / Fermée / Réception Partielle / Annulée)
- Date (YYYY-MM-DD)
- # Fournisseur (4-6 chiffres)
- Nom du fournisseur
- Commandé Par (Nom, Prénom)
- # Pièce (alphanumérique)
- Qte Comm (entier)
- Description
- Nom Employé (Nom, Prénom)

Extrais TOUTES les lignes. Une même commande peut apparaître plusieurs fois (plusieurs pièces). IGNORE les en-têtes, pieds de page, numéros de page et totaux. Si une valeur manque : retourne null. num_commande, statut, num_piece et qte_commandee sont obligatoires.`

export async function parseCommandesPdfAvecIA(buffer: Buffer | Uint8Array): Promise<AiParseResult> {
  const t0 = Date.now()
  try {
    // On envoie le PDF directement à Claude (vision/file native via AI Gateway).
    // Note : la donnée doit être un Uint8Array pur (pas un Buffer Node).
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as any)
    const ab = new ArrayBuffer(src.byteLength)
    const data = new Uint8Array(ab)
    data.set(src)

    const result = await generateText({
      model: 'anthropic/claude-haiku-4.5',
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'application/pdf',
              data,
              filename: 'liste-commande.pdf',
            },
            {
              type: 'text',
              text: 'Extrais toutes les lignes de commande de ce PDF.',
            },
          ],
        },
      ],
      output: Output.object({ schema: ResponseSchema }),
      temperature: 0,
    })

    const object = result.output as z.infer<typeof ResponseSchema>
    const commandes: AiParsedCommande[] = (object.commandes || []).map((c: any) => ({
      num_commande:    String(c.num_commande || ''),
      statut:          String(c.statut || ''),
      date_commande:   c.date_commande ?? null,
      num_fournisseur: c.num_fournisseur ?? null,
      nom_fournisseur: c.nom_fournisseur ?? null,
      commande_par:    c.commande_par ?? null,
      num_piece:       String(c.num_piece || ''),
      qte_commandee:   typeof c.qte_commandee === 'number' ? c.qte_commandee : 0,
      description:     c.description ?? null,
      nom_employe:     c.nom_employe ?? null,
    })).filter(c => c.num_commande && c.num_piece)

    return {
      success: true,
      commandes,
      duree_ms: Date.now() - t0,
    }
  } catch (e: any) {
    return {
      success: false,
      commandes: [],
      duree_ms: Date.now() - t0,
      erreur: e.message || String(e),
    }
  }
}
