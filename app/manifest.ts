import type { MetadataRoute } from 'next';

// Installable web app. iOS only delivers Web Push to apps added to the Home Screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Loo Queue',
    short_name: 'Loo Queue',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#0f172a',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
