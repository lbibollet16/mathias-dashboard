const XLSX = require('xlsx')
const https = require('https')
const path = require('path')

const SUPABASE_URL = 'https://ieiuazdplejyiqdtcvzk.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllaXVhemRwbGVqeWlxZHRjdnprIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDgyNzIxMywiZXhwIjoyMDkwNDAzMjEzfQ.r0ZfYuABq9sAIMBu4pOJ20gAic5vd-CBDzvV74xmJVk'

const FICHIER = process.argv[2] || 'localisations.xlsx'

function httpReq(method, url, headers, body) {
  return new Promise(function(resolve, reject) {
    const urlObj = new URL(url)
    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method, headers }
    const req = https.request(options, function(res) {
      let data = ''
      res.on('data', function(chunk) { data += chunk })
      res.on('end', function() { resolve({ status: res.statusCode, body: data }) })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('Lance avec:')
    console.log('  set NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co')
    console.log('  set SUPABASE_SERVICE_KEY=eyJ...')
    console.log('  node import-localisations.js MonFichier.xlsx')
    return
  }

  console.log('Lecture du fichier:', FICHIER)
  const wb = XLSX.readFile(path.resolve(FICHIER))
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  console.log('Lignes lues:', rows.length)

  // Parser selon mapping: B=1, C=2, D=3, E=4, F=5, G=6, H=7
  const paires = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const code = String(row[1] || '').trim()
    if (!code) continue
    paires.push({
      code_piece: code,
      fournisseur: String(row[2] || '').trim() || null,
      description: String(row[3] || '').trim() || null,
      localisation1: String(row[4] || '').trim() || null,
      localisation2: String(row[5] || '').trim() || null,
      localisation3: String(row[6] || '').trim() || null,
      localisation4: String(row[7] || '').trim() || null,
    })
  }
  console.log('Pièces valides:', paires.length)

  // Vider la table
  console.log('Suppression des anciennes données...')
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  }
  await httpReq('DELETE', SUPABASE_URL + '/rest/v1/inventaire_localisations?id=gte.0', headers, null)

  // Insérer par batch de 500
  let total = 0
  const BATCH = 500
  for (let i = 0; i < paires.length; i += BATCH) {
    const batch = paires.slice(i, i + BATCH)
    const body = JSON.stringify(batch)
    const h = { ...headers, 'Content-Length': Buffer.byteLength(body) }
    const res = await httpReq('POST', SUPABASE_URL + '/rest/v1/inventaire_localisations', h, body)
    if (res.status >= 300) {
      console.log('ERREUR batch', i, ':', res.body.substring(0, 200))
      break
    }
    total += batch.length
    process.stdout.write('\r' + total + '/' + paires.length + ' importées...')
  }
  console.log('\nTerminé! ' + total + ' localisations importées.')
}

main().catch(console.error)
