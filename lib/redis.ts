// ============================================================
// lib/redis.ts — Cliente Upstash Redis (HTTP, serverless-ready)
// ============================================================
// Requiere: npm install @upstash/redis
//
// Variables de entorno (Vercel las inyecta automáticamente si
// conectás la integración de Upstash desde el dashboard):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

import { Redis } from "@upstash/redis";

declare global {
    // eslint-disable-next-line no-var
    var _redis: Redis | undefined;
}

function createRedisClient(): Redis {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        throw new Error(
            "Faltan variables de entorno: UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN"
        );
    }

    return new Redis({ url, token });
}

// En desarrollo reutilizamos la instancia entre hot-reloads de Next.js
const redis: Redis =
    process.env.NODE_ENV === "development"
        ? (globalThis._redis ?? (globalThis._redis = createRedisClient()))
        : createRedisClient();

export default redis;


// // ============================================================
// // lib/redis.ts — Cliente Redis (singleton)
// // ============================================================
// // Requiere: npm install ioredis
// // Variable de entorno: REDIS_URL=redis://localhost:6379

// import Redis from "ioredis";

// declare global {
//     // eslint-disable-next-line no-var
//     var _redis: Redis | undefined;
// }

// function createRedisClient(): Redis {
//     const url = process.env.REDIS_URL || "redis://localhost:6379";
//     const client = new Redis(url, {
//         maxRetriesPerRequest: 3,
//         lazyConnect: false,
//     });

//     client.on("error", (err) => {
//         console.error("[Redis] Error de conexión:", err.message);
//     });

//     client.on("connect", () => {
//         console.log("[Redis] Conectado correctamente");
//     });

//     return client;
// }

// // En desarrollo reutilizamos la instancia entre hot-reloads
// const redis: Redis =
//     process.env.NODE_ENV === "development"
//         ? (globalThis._redis ?? (globalThis._redis = createRedisClient()))
//         : createRedisClient();

// export default redis;