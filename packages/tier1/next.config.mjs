/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // T6.4 (§10.3): strict body-size limit on every ordinary form/server
  // action submission. The one deliberate exception is the plugin-bundle
  // upload route, which streams to disk under its own much larger,
  // explicit 50 MB cap (`MAX_UPLOAD_BYTES`, T2.10) rather than buffering
  // in memory -- a plain Route Handler, not a server action, so this limit
  // does not apply to it at all.
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
};

export default nextConfig;
