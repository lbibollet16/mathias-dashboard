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

const SYSTEM_PROMPT = `Tu extrais les lignes de commande d'un rapport PDF Traction intitulé "Liste des Pièces sur la commande" (logiciel de pièces marine).

FORMAT DU RAPPORT — c'est un rapport MULTI-PAGES. CHAQUE PAGE = UNE commande. Structure d'une page :

1. En-tête de page : "(247) Mathias Marine Sports DATE HEURE"
2. Titre : "Liste des Pièces sur la commande"
3. Ligne d'en-tête de la commande : "#Commande Statut Date Réception #Fourn Nom Type de Commande Commandé Par Autorisé Par ..."
4. UNE ligne avec les valeurs de la commande, dans cet ordre :
   <#Commande> <Statut> <Date YYYY-MM-DD> [<Date Réception YYYY-MM-DD optionnelle>] <#Fourn> <Nom Fournisseur (mots, peut contenir parenthèses)> <Type (Stock|Retour au Fournisseur|...)> <Commandé Par "Nom, Prénom"> <Autorisé Par "Nom, Prénom">

   EXEMPLE : "M1C0036824 Transmise/Fermée 2024-11-28 100423 Ennis Fabrics Ltd. Stock Voghel, Cynthia Voghel, Cynthia"
   → num_commande="M1C0036824", statut="Transmise/Fermée", date_commande="2024-11-28", num_fournisseur="100423", nom_fournisseur="Ennis Fabrics Ltd.", commande_par="Voghel, Cynthia"

5. (Optionnel) "Remarque: ..."
6. Ligne d'en-tête des pièces : "# Pièce #Fourn Comm Réserv Local.1 Local.2 Local.3 Lgn Description Coût ..."
7. ZÉRO, UNE ou PLUSIEURS lignes de pièces, format :
   <#Pièce> <#Fourn> <Qte Comm> [colonnes optionnelles : Réserv, Localisations, Ligne] <Description (peut contenir espaces)> <Coût> ...

   EXEMPLE : "365005 100010 1 PS2AA 23 MBTZ10S BATTERIE QUADFLEX MO 87,49 N N 1"
   → num_piece="365005", qte_commandee=1, description="BATTERIE QUADFLEX MO" (la 1re colonne après #Pièce est #Fourn, la 2e est Qte Comm)

   EXEMPLE : "9931-819 44405 1 1 7 DECK LIGHT,WHT10-30V,LED,680 96,52 N N D 1"
   → num_piece="9931-819", qte_commandee=1, description="DECK LIGHT,WHT10-30V,LED,680"

   EXEMPLE : "301612 36485 1 1 11 Deck Suction Fitting 1 1/2\" 61,99 N N 1"
   → num_piece="301612", qte_commandee=1, description="Deck Suction Fitting 1 1/2\""

8. (Optionnel) Bloc "Commande" ou "Réservation" :
   "Date # Employé Nom Employé Qte Remarque:"
   "<Date> <#Employé> <Nom Employé "Nom, Prénom"> <Qte> ..."

   EXEMPLE : "2026-05-07 945 Pothier, Anthony 1"
   → nom_employe="Pothier, Anthony"

9. Pied de page : "Coût Total de la Commande: ..."
10. "X / Y" (numéro de page)

RÈGLES STRICTES :
- Retourne UNE LIGNE PAR PIÈCE. Si une commande a 3 pièces, ça fait 3 entrées (avec le même num_commande mais des num_piece différents).
- Si une commande n'a AUCUNE pièce visible, IGNORE-la totalement (pas d'entrée).
- Retourne null pour les champs absents. SEULS num_commande, statut, num_piece et qte_commandee sont obligatoires.
- Le statut peut être : "Transmise", "Fermée", "Transmise/Fermée", "Réception Partielle", "Annulée".
- IGNORE les en-têtes répétés, "Coût Total de la Commande", "Nombre d'Items", numéros de page "X / Y", lignes "Réservation"/"Commande" qui ne sont pas des pièces.
- Le nom_employe vient du bloc Commande/Réservation, PAS du "Commandé Par".`

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
