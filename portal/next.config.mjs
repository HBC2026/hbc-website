// Security headers for every response (site, portal and API).
const csp = [
  "default-src 'self'",
  // Next.js and the static site use inline bootstrap scripts; OpenCV (scanner) loads from jsDelivr and needs WebAssembly.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.supabase.co",
  "media-src 'self' blob:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: https://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },   // petty-cash links carry a secret token in the URL
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // One Vercel project serves both: the static HBC website (public/index.html) at /
  // and the admin portal (src/app/adminconsole) at /adminconsole.
  async rewrites() {
    return { beforeFiles: [{ source: '/', destination: '/index.html' }] };
  },
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      // pages that show private data or carry a token must never be cached or indexed
      { source: '/pettycash/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
      { source: '/adminconsole/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ];
  },
};
export default nextConfig;
