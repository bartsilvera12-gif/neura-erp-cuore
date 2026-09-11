import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Quitar el header "X-Powered-By: Next.js" — leak innecesario de tech stack
  // a clientes/atacantes. Cuesta 0 perf-wise.
  poweredByHeader: false,

  // gzip de respuestas en produccion. Es el default pero declararlo explicito
  // evita sorpresas si Coolify/Traefik intentan re-comprimir.
  compress: true,

  // NOTA: NO usamos output: "standalone" porque Coolify+Nixpacks corre
  // `next start` con .next/ regular, no usa .next/standalone/. Si en el futuro
  // hacemos un Dockerfile custom para reducir imagen, agregar standalone ahi.

  experimental: {
    // Tree-shake agresivo para barrels grandes. Cuando importas
    //   import { ChevronDown, X, Search } from "lucide-react"
    // Next solo bundlea esas 3 icons en vez del barrel completo de la libreria.
    // Aplica tambien a recharts (aunque ya hicimos dynamic import del chart).
    optimizePackageImports: ["lucide-react", "recharts"],
  },

  // Headers HTTP para caching agresivo de assets estaticos generados por Next
  // (fingerprinted, immutable por hash). El navegador los cachea 1 ano.
  // Reduce dramaticamente requests al server en navegaciones siguientes
  // del mismo user (vuelve al dashboard, los chunks JS/CSS ya estan locales).
  async headers() {
    return [
      {
        source: "/_next/static/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/_next/image(.*)",
        headers: [
          // Imagenes optimizadas tambien son fingerprinted, mismo trato.
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
