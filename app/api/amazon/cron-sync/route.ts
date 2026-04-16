import { NextResponse } from 'next/server'
import { syncTractionFeed } from '@/lib/amazon-traction-sync'

// GET — appelé par le Vercel Cron quotidien pour synchroniser
// les lignes Traction AMA/FBA/FBM automatiquement.
export async function GET() {
  const r = await syncTractionFeed()
  return NextResponse.json(r, { status: r.success ? 200 : 500 })
}
