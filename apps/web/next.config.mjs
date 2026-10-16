/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@nerox/x402", "@nerox/contracts"],
  // CSP: scripts only from self; RPC and service calls only to the configured hosts.
  async headers() {
    const connect = [
      "'self'",
      process.env.NEXT_PUBLIC_BASE_RPC || "http://127.0.0.1:8545",
      process.env.NEXT_PUBLIC_ETH_RPC || "http://127.0.0.1:8546",
      "http://localhost:4020", "http://localhost:4021", "http://localhost:4022", "http://localhost:4023",
      "ws:", "http://127.0.0.1:8545", "http://127.0.0.1:8546",
    ].join(" ");
    const dev = process.env.NODE_ENV !== "production";
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: http://localhost:4021",
      "font-src 'self' data:",
      `connect-src ${connect}`,
      "frame-ancestors 'none'",
    ].join("; ");
    return [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: csp }, { key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] }];
  },
};
export default nextConfig;
