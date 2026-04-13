import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Permite que ioredis funcione en el servidor
  // serverExternalPackages: ["ioredis"],

  // @upstash/redis usa fetch nativo, no necesita configuración extra
};

export default nextConfig;