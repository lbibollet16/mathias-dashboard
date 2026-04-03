import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Mathias Marine Sports - Dashboard',
    short_name: 'Mathias',
    description: 'Dashboard de gestion Mathias Marine Sports',
    start_url: '/',
    display: 'standalone',
    background_color: '#0d0d0d',
    theme_color: '#2563eb',
    icons: [
      { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
      { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
    ],
  }
}
