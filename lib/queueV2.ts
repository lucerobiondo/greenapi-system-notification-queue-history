// ============================================================
// lib/queue.ts — Lógica de Cola con Upstash Redis
// ============================================================

import redis from "./redis";
import type { QueuedMessage, MessageStatus, QueueStats } from "../types";

// ──────────────────────────────────────────────
// CLAVES REDIS
// ──────────────────────────────────────────────
const KEYS = {
    queue: "whatsapp:queue",
    message: (id: string) => `whatsapp:msg:${id}`,
    history: "whatsapp:history",
} as const;

const MAX_HISTORY = 1000;
const TTL_DAYS = 30;

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
function generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toHash(msg: QueuedMessage): Record<string, string> {
    return {
        id: msg.id,
        telefono: msg.telefono,
        contenido: msg.contenido,
        metadata: JSON.stringify(msg.metadata ?? {}),
        status: msg.status,
        intentos: String(msg.intentos),
        maxIntentos: String(msg.maxIntentos),
        creadoEn: String(msg.creadoEn),
        actualizadoEn: String(msg.actualizadoEn),
        proximoIntento: String(msg.proximoIntento ?? ""),
        error: msg.error ?? "",
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromHash(hash: Record<string, any>): QueuedMessage {
    // @upstash/redis auto-deserializa valores JSON, forzamos string en todos los campos de texto
    const str = (v: unknown) => (v == null ? "" : String(v));
    return {
        id: str(hash.id),
        telefono: str(hash.telefono),
        contenido: str(hash.contenido),
        metadata: typeof hash.metadata === "object" && hash.metadata !== null
            ? hash.metadata
            : JSON.parse(str(hash.metadata) || "{}"),
        status: str(hash.status) as MessageStatus,
        intentos: Number(hash.intentos),
        maxIntentos: Number(hash.maxIntentos),
        creadoEn: Number(hash.creadoEn),
        actualizadoEn: Number(hash.actualizadoEn),
        proximoIntento: hash.proximoIntento ? Number(hash.proximoIntento) : undefined,
        error: hash.error ? str(hash.error) : undefined,
    };
}

// ──────────────────────────────────────────────
// OPERACIONES PRINCIPALES
// ──────────────────────────────────────────────

/**
 * 1. ENCOLAR MENSAJE
 * Upstash no soporta pipeline con hset+expire+rpush en una sola llamada,
 * usamos multi() para atomicidad.
 */
export async function enqueueMessage(params: {
    telefono: string;
    contenido: string;
    metadata?: Record<string, unknown>;
    maxIntentos?: number;
}): Promise<QueuedMessage> {
    const now = Date.now();
    const msg: QueuedMessage = {
        id: generateId(),
        telefono: params.telefono,
        contenido: params.contenido,
        metadata: params.metadata,
        status: "Pendiente",
        intentos: 0,
        maxIntentos: params.maxIntentos ?? 3,
        creadoEn: now,
        actualizadoEn: now,
    };

    // Upstash multi() — transacción atómica
    await redis
        .multi()
        .hset(KEYS.message(msg.id), toHash(msg))
        .expire(KEYS.message(msg.id), TTL_DAYS * 86400)
        .rpush(KEYS.queue, msg.id)
        .exec();

    return msg;
}

/**
 * 2. OBTENER SIGUIENTE (FIFO)
 */
export async function dequeueNext(): Promise<QueuedMessage | null> {
    // lpop de @upstash/redis devuelve string | null directamente
    const id = await redis.lpop<string>(KEYS.queue);
    if (!id) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hash = await redis.hgetall<Record<string, any>>(KEYS.message(id));
    if (!hash || !hash.id) return null;

    return fromHash(hash);
}

/**
 * 3. ACTUALIZAR ESTADO
 */
export async function updateMessageStatus(
    id: string,
    updates: Partial<Pick<QueuedMessage, "status" | "intentos" | "error" | "proximoIntento">>
): Promise<void> {
    const now = Date.now();
    const patch: Record<string, string> = { actualizadoEn: String(now) };

    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.intentos !== undefined) patch.intentos = String(updates.intentos);
    if (updates.error !== undefined) patch.error = updates.error;
    if (updates.proximoIntento !== undefined) patch.proximoIntento = String(updates.proximoIntento);

    await redis.hset(KEYS.message(id), patch);
}

/**
 * 4. GUARDAR EN HISTORIAL (más reciente primero, sin duplicados)
 */
export async function saveToHistory(msg: QueuedMessage): Promise<void> {
    await redis
        .multi()
        .lrem(KEYS.history, 0, msg.id)           // elimina duplicados previos
        .lpush(KEYS.history, msg.id)             // inserta al frente
        .ltrim(KEYS.history, 0, MAX_HISTORY - 1) // limita tamaño
        .exec();
}

/**
 * 5. PROGRAMAR REINTENTO — delays progresivos: 1s → 5s → 30s → 2min → 5min
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000];

export async function scheduleRetry(msg: QueuedMessage): Promise<boolean> {
    const esTemporalError =
        !msg.error?.toLowerCase().includes("bloqueado") &&
        !msg.error?.toLowerCase().includes("inválido");

    const puedeReintentar = msg.intentos < msg.maxIntentos && esTemporalError;

    if (!puedeReintentar) {
        const finalStatus = msg.error?.toLowerCase().includes("bloqueado")
            ? "Bloqueado"
            : "NoEnviado";
        await updateMessageStatus(msg.id, { status: finalStatus });
        await saveToHistory({ ...msg, status: finalStatus });
        return false;
    }

    const delayMs = RETRY_DELAYS_MS[msg.intentos] ?? RETRY_DELAYS_MS.at(-1)!;
    const proximoIntento = Date.now() + delayMs;

    await updateMessageStatus(msg.id, {
        status: "Pendiente",
        intentos: msg.intentos,
        proximoIntento,
    });

    await redis.rpush(KEYS.queue, msg.id);
    return true;
}

// ──────────────────────────────────────────────
// CONSULTAS
// ──────────────────────────────────────────────

export async function getMessageById(id: string): Promise<QueuedMessage | null> {
    const hash = await redis.hgetall<Record<string, any>>(KEYS.message(id));
    if (!hash?.id) return null;
    return fromHash(hash);
}

/**
 * Historial paginado — lecturas en paralelo con Promise.all
 * (más eficiente que pipeline en Upstash HTTP)
 */
export async function getHistory(page = 0, limit = 20): Promise<QueuedMessage[]> {
    const start = page * limit;
    const end = start + limit - 1;
    const ids = await redis.lrange(KEYS.history, start, end);

    if (!ids.length) return [];

    const hashes = await Promise.all(
        ids.map((id) => redis.hgetall<Record<string, any>>(KEYS.message(id)))
    );

    return hashes
        .filter((h): h is Record<string, string> => !!h?.id)
        .map(fromHash);
}

/**
 * Estadísticas — lecturas en paralelo
 */
export async function getQueueStats(): Promise<QueueStats> {
    const [queueLength, historyIds] = await Promise.all([
        redis.llen(KEYS.queue),
        redis.lrange(KEYS.history, 0, -1),
    ]);

    const stats: QueueStats = {
        pendiente: 0,
        procesando: 0,
        enviado: 0,
        noEnviado: 0,
        bloqueado: 0,
        total: 0,
    };

    if (historyIds.length) {
        const statuses = await Promise.all(
            historyIds.map((id) => redis.hget<string>(KEYS.message(id), "status"))
        );

        for (const status of statuses) {
            if (!status) continue;
            const s = status.toLowerCase();
            if (s === "enviado") stats.enviado++;
            if (s === "noenviado") stats.noEnviado++;
            if (s === "bloqueado") stats.bloqueado++;
            if (s === "procesando") stats.procesando++;
        }
    }

    stats.pendiente = queueLength;
    stats.total = historyIds.length + queueLength;

    return stats;
}

/**
 * Limpieza automática de mensajes viejos
 */
export async function cleanOldMessages(olderThanDays = 30): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const allIds = await redis.lrange(KEYS.history, 0, -1);
    let removed = 0;

    // Fetch fechas en paralelo
    const createdAts = await Promise.all(
        allIds.map((id) => redis.hget<string>(KEYS.message(id), "creadoEn"))
    );

    for (let i = 0; i < allIds.length; i++) {
        const createdAt = createdAts[i];
        if (createdAt && Number(createdAt) < cutoff) {
            await redis.lrem(KEYS.history, 1, allIds[i]);
            await redis.del(KEYS.message(allIds[i]));
            removed++;
        }
    }

    return removed;
}