const XLSX = require('xlsx')
const fs   = require('fs')
const path = require('path')
const https = require('https')

const SUPABASE_URL ='https://ieiuazdplejyiqdtcvzk.supabase.co' 
const SUPABASE_KEY ='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllaXVhemRwbGVqeWlxZHRjdnprIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDgyNzIxMywiZXhwIjoyMDkwNDAzMjEzfQ.r0ZfYuABq9sAIMBu4pOJ20gAic5vd-CBDzvV74xmJVk'

const MOIS_MAP = {
  'janv': '01', 'jan': '01', 'janvier': '01',
  'fev': '02', 'fevrier': '02',
  'mars': '03',
  'avril': '04', 'avr': '04',
  'mai': '05',
  'juin': '06',
  'juillet': '07', 'juil': '07',
  'aout': '08',
  'septembre': '09', 'sept': '09', 'sep': '09',
  'octobre': '10', 'oct': '10',
  'novembre': '11', 'nov': '11',
  'decembre': '12', 'dec': '12',
}

function detecterMois(nomFichier) {
  const base = path.basename(nomFichier, path.extname(nomFichier)).toLowerCase()
  const anneeMatch = base.match(/(\d{4})/)
  if (!anneeMatch) return null
  const annee = anneeMatch[1]
  const nomSansAnnee = base.replace(annee, '').replace(/[^a-z]/g, '')
  for (const cle of Object.keys(MOIS_MAP)) {
    if (nomSansAnnee.includes(cle)) return annee + '-' + MOIS_MAP[cle]
  }
  return null
}

function parseFrNum(v) {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number') return v
  return parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) || 0
}

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

function importerFichier(fichier, moisAnnee) {
  const buffer = fs.readFileSync(fichier)
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sheet)

  const toInsert = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const keys = Object.keys(row)
    const keyCode   = keys.find(function(k) { return k.trim().toLowerCase() === 'code' })
    const keyQte    = keys.find(function(k) { return k.trim().toLowerCase() === 'qte' || k.trim().toLowerCase() === 'qty' })
    const keyRev    = keys.find(function(k) { return k.trim().toLowerCase() === 'revenus' })
    const keyProfit = keys.find(function(k) { return k.trim().toLowerCase() === 'total $' })

    if (!keyCode || !row[keyCode]) continue
    const codePiece = String(row[keyCode]).trim()
    if (!codePiece || codePiece.toLowerCase().includes('total')) continue

    const quantite = parseFrNum(keyQte ? row[keyQte] : 0)
    const revenus  = parseFrNum(keyRev ? row[keyRev] : 0)
    const profit   = parseFrNum(keyProfit ? row[keyProfit] : 0)

    if (quantite !== 0 || revenus !== 0) {
      toInsert.push({ code_piece: codePiece, mois: moisAnnee, quantite: quantite, revenus: revenus, profit: profit })
    }
  }

  if (toInsert.length === 0) return Promise.resolve(0)

  const batches = []
  for (let i = 0; i < toInsert.length; i += 500) {
    batches.push(toInsert.slice(i, i + 500))
  }

  let total = 0
  function sendBatch(idx) {
    if (idx >= batches.length) return Promise.resolve(total)
    const body = JSON.stringify(batches[idx])
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=minimal'
    }
    return httpPost(SUPABASE_URL + '/rest/v1/historique_ventes', headers, body).then(function(res) {
      if (res.status >= 300) throw new Error(res.body)
      total += batches[idx].length
      return sendBatch(idx + 1)
    })
  }
  return sendBatch(0)
}

function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('ERREUR: Lance le script avec:')
    console.log('  set NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co')
    console.log('  set SUPABASE_SERVICE_KEY=eyJ...')
    console.log('  node import-ventes-batch.js')
    return
  }

  const dossier = 'ventes'
  if (!fs.existsSync(dossier)) {
    fs.mkdirSync(dossier)
    console.log('Dossier "ventes/" cree. Mets tes fichiers XLS dedans et relance.')
    return
  }

  const fichiers = fs.readdirSync(dossier)
    .filter(function(f) { return f.match(/\.(xls|xlsx)$/i) })
    .sort()

  if (fichiers.length === 0) {
    console.log('Aucun fichier XLS dans le dossier "ventes/"')
    return
  }

  console.log('\n' + fichiers.length + ' fichiers trouves\n')

  let succes = 0
  let erreurs = 0
  let idx = 0

  function traiterSuivant() {
    if (idx >= fichiers.length) {
      console.log('\nTermine: ' + succes + ' OK, ' + erreurs + ' erreurs')
      console.log('\nLance maintenant:')
      console.log('curl -X POST https://mathias-dashboard.vercel.app/api/calculateur/recalculer')
      return
    }
    const fichier = fichiers[idx]
    idx++
    const mois = detecterMois(fichier)
    if (!mois) {
      console.log('SKIP ' + fichier + ' (mois non detecte)')
      erreurs++
      return traiterSuivant()
    }
    process.stdout.write(fichier + ' -> ' + mois + ' ... ')
    importerFichier(path.join(dossier, fichier), mois).then(function(n) {
      console.log('OK ' + n + ' lignes')
      succes++
      traiterSuivant()
    }).catch(function(e) {
      console.log('ERREUR ' + e.message)
      erreurs++
      traiterSuivant()
    })
  }

  traiterSuivant()
}

main()
