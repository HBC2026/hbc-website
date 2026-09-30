/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // One Vercel project serves both: the static HBC website (public/index.html) at /
  // and the admin portal (src/app/adminconsole) at /adminconsole.
  async rewrites() {
    return { beforeFiles: [{ source: '/', destination: '/index.html' }] };
  },
};
export default nextConfig;
