import { Redis } from "@upstash/redis";
import type { QueuedMessage } from "../types";

declare global {
    var _redis: Redis | undefined;
}

function createClient(): Redis {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
        throw new Error("Faltan variables de entorno de Upstash");
    }
    return new Redis({ url, token });
}

const redis: Redis =
    process.env.NODE_ENV === "development"
        ? (globalThis._redis ?? (globalThis._redis = createClient()))
        : createClient();

export default redis;

// ──────────────────────────────────────────────

const QUEUE_KEY = "whatsapp:queue";
const MSG_PREFIX = "whatsapp:msg:";
const TTL = 7 * 86400; // 7 días

// ──────────────────────────────────────────────
// ENQUEUE — atómico (SET + RPUSH)
// ──────────────────────────────────────────────

export async function redisEnqueue(msg: QueuedMessage): Promise<void> {
    const key = `${MSG_PREFIX}${msg.id}`;

    const res = await redis
        .multi()
        .set(key, JSON.stringify(msg), { ex: TTL })
        .rpush(QUEUE_KEY, msg.id)
        .exec();

    console.log("ENQUEUE OK →", msg.id);
    console.log("MULTI RESULT:", res);
}

// ──────────────────────────────────────────────
// DEQUEUE — robusto + limpieza de basura
// ──────────────────────────────────────────────

export async function redisDequeue(): Promise<QueuedMessage | null> {
    let attempts = 0;
    const MAX_ATTEMPTS = 5;

    while (attempts < MAX_ATTEMPTS) {
        const id = await redis.lpop<string>(QUEUE_KEY);

        if (!id) return null;

        const key = `${MSG_PREFIX}${id}`;
        const raw = await redis.get<string>(key);

        if (!raw) {
            console.warn(`⚠️ ID huérfano eliminado: ${id}`);
            attempts++;
            continue; // intenta con el siguiente
        }

        // borrar payload (equivalente a GETDEL pero seguro)
        await redis.del(key);

        try {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

            const str = (v: unknown) => (v == null ? "" : String(v));

            return {
                ...parsed,
                id: str(parsed.id),
                telefono: str(parsed.telefono),
                contenido: str(parsed.contenido),
                status: str(parsed.status),
                intentos: Number(parsed.intentos),
                maxIntentos: Number(parsed.maxIntentos),
                creadoEn: Number(parsed.creadoEn),
                actualizadoEn: Number(parsed.actualizadoEn),
                error: parsed.error ? str(parsed.error) : undefined,
            };
        } catch (e) {
            console.error(`❌ JSON inválido para ID: ${id}, ${e}`);
            return null;
        }
    }

    return null;
}

// ──────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────

export async function redisQueueLength(): Promise<number> {
    return redis.llen(QUEUE_KEY);
}

export async function redisClearQueue(): Promise<void> {
    await redis.del(QUEUE_KEY);
    console.log("🧹 Cola limpiada");
}
