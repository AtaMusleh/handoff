/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The domain package ships TypeScript source rather than a build artifact.
  transpilePackages: ['@handoff/domain'],
};

export default nextConfig;
