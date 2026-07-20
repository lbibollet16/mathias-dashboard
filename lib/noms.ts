// Clé de rapprochement d'un nom de personne, insensible :
//   - à la casse et aux espaces multiples,
//   - à la virgule (« Gental, Laura » == « Gental Laura »),
//   - à l'ORDRE des mots (« Gental, Laura » == « Laura Gental »),
//   - aux accents (« Pégourié » == « Pegourie »).
//
// Les rapports Traction sortent les noms en « Nom, Prénom », mais un aviseur
// peut avoir été renommé à la main en « Prénom Nom » : sans cette clé, le
// rattachement du rapport de performance échouait silencieusement.
export function cleNom(nom: string): string {
  return String(nom || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // enlève les accents
    .toLowerCase()
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}
