// Script à exécuter dans ton terminal pour importer tous les fichiers XLS
// Commande : node import-ventes-batch.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Correspondance nom de fichier → mois au format YYYY-MM
const MOIS_MAP = {
  'janv2025':      '2025-01',
  'janv2026':      '2026-01',
  'fev2025':       '2025-02',
  'fev2026':       '2026-02',
  'mars2024':      '2024-03',
  'mars2025':      '2025-03',
  'avril2024':     '2024-04',
  'avril 2025':    '2025-04',
  'mai2024':       '2024-05',
  'mai2025':       '2025-05',
  'juin2024':      '2024-06',
  'juin2026':      '2026-06',
  'juillet2024':   '2024-07',
  'juillet2025':   '2025-07',
  'aout2024':      '2024-08',
  'aout2025':      '2025-08',
  'septembre2024': '2024-09',
  'septembre2025': '2025-09',
  'oct2024':       '2024-10',
  'oct2025':       '2025-10',
  'nov2024':       '2024-11',
  'nov2025':       '2025-11',
  'dec2024':       '2024-12',
  'dec2025':       '2025-12',
};

// Trouver le dossier vente (à côté de ce script ou dans un sous-dossier)
function trouverDossierVente() {
  const candidats = [
    path.join(__dirname, 'vente'),
    path.join(process.env.USERPROFILE || '', 'Desktop', 'vente'),
    path.join(process.env.USERPROFILE || '', 'Downloads', 'vente'),
  ];
  for (const c of candidats) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function importerFichier(filePath, mois) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);
    
    const boundary = '----FormBoundary' + Date.now();
    
    // Construire le multipart/form-data manuellement
    const parts = [];
    
    // Champ mois_annee
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="mois_annee"\r\n\r\n` +
      `${mois}\r\n`
    );
    
    // Champ fichier
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="data"; filename="${fileName}"\r\n` +
      `Content-Type: application/vnd.ms-excel\r\n\r\n`
    );
    
    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/import-ventes',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ erreur: 'Réponse invalide: ' + data });
        }
      });
    });
    
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== Import massif des ventes ===\n');
  
  // Trouver le dossier vente
  let dossierVente = trouverDossierVente();
  
  if (!dossierVente) {
    // Chercher dans le répertoire courant
    const fichiersDansDossierCourant = fs.readdirSync(__dirname).filter(f => f.endsWith('.xls'));
    if (fichiersDansDossierCourant.length > 0) {
      dossierVente = __dirname;
    } else {
      console.error('❌ Dossier "vente" introuvable !');
      console.log('Place le dossier "vente" (avec tous tes fichiers .xls) à côté de ce script.');
      process.exit(1);
    }
  }
  
  console.log(`📁 Dossier trouvé : ${dossierVente}\n`);
  
  const fichiers = fs.readdirSync(dossierVente).filter(f => f.endsWith('.xls'));
  console.log(`📊 ${fichiers.length} fichiers à importer\n`);
  
  let succes = 0, echecs = 0;
  
  for (const fichier of fichiers) {
    // Trouver le mois correspondant
    const nomSanExt = fichier.replace('.xls', '').trim();
    const mois = MOIS_MAP[nomSanExt];
    
    if (!mois) {
      console.log(`⚠️  ${fichier} → mois non reconnu, ignoré`);
      echecs++;
      continue;
    }
    
    const filePath = path.join(dossierVente, fichier);
    process.stdout.write(`⏳ ${fichier} (${mois})... `);
    
    try {
      const result = await importerFichier(filePath, mois);
      if (result.success) {
        console.log(`✅ ${result.lignes_importees} lignes`);
        succes++;
      } else {
        console.log(`❌ ${result.erreur}`);
        echecs++;
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      echecs++;
    }
    
    // Petite pause entre chaque fichier
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`\n=== Terminé ===`);
  console.log(`✅ ${succes} fichiers importés avec succès`);
  if (echecs > 0) console.log(`❌ ${echecs} échecs`);
  
  if (succes > 0) {
    console.log('\n🔄 Lancement du calcul du cache...');
    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost', port: 3000,
          path: '/api/calculateur/recalculer',
          method: 'POST',
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
        req.end();
      });
      
      if (result.success) {
        console.log(`✅ Cache calculé : ${result.nb_pieces} pièces`);
        console.log('\n🎉 Tout est prêt ! Recharge http://localhost:3000');
      } else {
        console.log('❌ Erreur calcul cache:', result.erreur);
      }
    } catch (e) {
      console.log('❌ Erreur:', e.message);
    }
  }
}

main().catch(console.error);
