import { NextResponse } from 'next/server'

// Retourne un ID unique basé sur le moment du build
// Next.js recompile ce fichier à chaque déploiement
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || process.env.BUILD_ID || Date.now().toString()

export async function GET() {
  return NextResponse.json({ buildId: BUILD_ID })
}
