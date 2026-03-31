const https = require('https')

const SUPABASE_URL = 'https://ieiuazdplejyiqdtcvzk.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllaXVhemRwbGVqeWlxZHRjdnprIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDgyNzIxMywiZXhwIjoyMDkwNDAzMjEzfQ.r0ZfYuABq9sAIMBu4pOJ20gAic5vd-CBDzvV74xmJVk'



const POLITIQUES = [
  { id_fournisseur: '100010', nom_fournisseur: 'Kimpex', jours_retour: 30 },
  { id_fournisseur: '20714',  nom_fournisseur: 'Polaris Canada (GE)', jours_retour: 60 },
  { id_fournisseur: '20757',  nom_fournisseur: 'Ktm Canada Inc. (GE)', jours_retour: 60 },
  { id_fournisseur: '49048',  nom_fournisseur: 'Canada Motor Import (CF Mo', jours_retour: 60 },
  { id_fournisseur: '31886',  nom_fournisseur: 'Husqvarna Motorcycles Nort', jours_retour: 60 },
  { id_fournisseur: '28665',  nom_fournisseur: 'Honda Canada Inc.', jours_retour: 60 },
  { id_fournisseur: '20847',  nom_fournisseur: 'Parts Canada', jours_retour: 30 },
  { id_fournisseur: '20784',  nom_fournisseur: 'Motovan Corporation', jours_retour: 30 },
  { id_fournisseur: '48312',  nom_fournisseur: 'HLC-VELO', jours_retour: 30 },
  { id_fournisseur: '58994',  nom_fournisseur: 'Live To Play Sports', jours_retour: 30 },
  { id_fournisseur: '65356',  nom_fournisseur: 'Indian Motorcycle', jours_retour: 60 },
]

function httpPost(url, headers, body) {
  return new Promise(function(resolve, reject) {
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: headers
    }
    const req = https.request(options, function(res) {
      let data = ''
      res.on('data', function(chunk) { data += chunk })
      res.on('end', function() { resolve({ status: res.statusCode, body: data }) })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('Lance avec:')
    console.log('  set NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co')
    console.log('  set SUPABASE_SERVICE_KEY=eyJ...')
    console.log('  node import-politiques.js')
    return
  }

  const body = JSON.stringify(POLITIQUES)
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Prefer': 'return=minimal'
  }

  const res = await httpPost(SUPABASE_URL + '/rest/v1/politiques_fournisseurs', headers, body)
  if (res.status >= 300) {
    console.log('ERREUR: ' + res.body)
  } else {
    console.log('OK - ' + POLITIQUES.length + ' politiques importees:')
    POLITIQUES.forEach(function(p) {
      console.log('  ' + p.nom_fournisseur + ' - ' + p.jours_retour + ' jours')
    })
  }
}

main().catch(console.error)
