// node import-politiques.js
const https = require('https')
const fs = require('fs')
const path = require('path')

function lireEnv() {
  const envPath = path.join(__dirname, '.env.local')
  if (!fs.existsSync(envPath)) { console.error('❌ .env.local introuvable'); process.exit(1) }
  const env = {}
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=')
    if (key && vals.length) env[key.trim()] = vals.join('=').trim()
  })
  return env
}

async function upsert(url, key, table, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data)
    const urlObj = new URL(`${url}/rest/v1/${table}`)
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + '?on_conflict=id_fournisseur',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'resolution=merge-duplicates',
      }
    }
    const req = https.request(options, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve({ ok: res.statusCode < 300, status: res.statusCode, body: d }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  const env = lireEnv()
  const URL = env['NEXT_PUBLIC_SUPABASE_URL']
  const KEY = env['SUPABASE_SERVICE_KEY']

  const politiques = [
    {"id_fournisseur":"100010","nom_fournisseur":"Kimpex","jours_retour":30},
    {"id_fournisseur":"20714","nom_fournisseur":"Polaris Canada (GE)","jours_retour":60},
    {"id_fournisseur":"20757","nom_fournisseur":"Ktm Canada Inc. (GE)","jours_retour":60},
    {"id_fournisseur":"49048","nom_fournisseur":"Canada Motor Import (CF Mo","jours_retour":60},
    {"id_fournisseur":"31886","nom_fournisseur":"Husqvarna Motorcycles Nort","jours_retour":60},
    {"id_fournisseur":"28665","nom_fournisseur":"Honda Canada Inc.","jours_retour":60},
    {"id_fournisseur":"20847","nom_fournisseur":"Parts Canada","jours_retour":30},
    {"id_fournisseur":"20784","nom_fournisseur":"Motovan Corporation","jours_retour":30},
    {"id_fournisseur":"48312","nom_fournisseur":"HLC-VÉLO","jours_retour":30},
    {"id_fournisseur":"58994","nom_fournisseur":"Live To Play Sports","jours_retour":30},
    {"id_fournisseur":"65356","nom_fournisseur":"Indian Motorcycle","jours_retour":60}
  ]

  console.log(`Import de ${politiques.length} politiques de retour...`)
  const r = await upsert(URL, KEY, 'politiques_fournisseurs', politiques)
  if (r.ok) {
    console.log('✅ Politiques importées !')
    politiques.forEach(p => console.log(`   ${p.nom_fournisseur} → ${p.jours_retour} jours`))
  } else {
    console.log('❌ Erreur:', r.body)
  }
}
main().catch(console.error)
