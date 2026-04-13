// ============================================================
// lib/queue.ts — Lógica de Cola con Redis
// ============================================================

import redis from "./redis";
import type { QueuedMessage, MessageStatus, QueueStats } from "../types";

// ──────────────────────────────────────────────
// CLAVES REDIS
// ──────────────────────────────────────────────
const KEYS = {
    queue: "whatsapp:queue",                         // Lista FIFO (Pendiente)
    message: (id: string) => `whatsapp:msg:${id}`,  // Hash del mensaje
    history: "whatsapp:history",                     // Lista ordenada para historial
} as const;

const MAX_HISTORY = 1000;   // máximo de entradas en historial
const TTL_DAYS = 30;     // días antes de expirar mensajes individuales

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

function fromHash(hash: Record<string, string>): QueuedMessage {
    return {
        id: hash.id,
        telefono: hash.telefono,
        contenido: hash.contenido,
        metadata: JSON.parse(hash.metadata || "{}"),
        status: hash.status as MessageStatus,
        intentos: Number(hash.intentos),
        maxIntentos: Number(hash.maxIntentos),
        creadoEn: Number(hash.creadoEn),
        actualizadoEn: Number(hash.actualizadoEn),
        proximoIntento: hash.proximoIntento ? Number(hash.proximoIntento) : undefined,
        error: hash.error || undefined,
    };
}

// ──────────────────────────────────────────────
// OPERACIONES PRINCIPALES
// ──────────────────────────────────────────────

/**
 * 1. ENCOLAR MENSAJE — guarda en Redis y agrega a la lista FIFO
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

    const pipeline = redis.pipeline();
    pipeline.hset(KEYS.message(msg.id), toHash(msg));
    pipeline.expire(KEYS.message(msg.id), TTL_DAYS * 86400);
    pipeline.rpush(KEYS.queue, msg.id); // FIFO: push al final
    await pipeline.exec();

    return msg;
}

/**
 * 2. OBTENER SIGUIENTE — saca el primer mensaje de la cola (FIFO)
 *    Retorna null si la cola está vacía.
 */
export async function dequeueNext(): Promise<QueuedMessage | null> {
    const id = await redis.lpop(KEYS.queue);
    if (!id) return null;

    const hash = await redis.hgetall(KEYS.message(id));
    if (!hash || !hash.id) return null;

    return fromHash(hash);
}

/**
 * 3. ACTUALIZAR ESTADO — modifica el hash del mensaje
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
 * 4. GUARDAR EN HISTORIAL — agrega el mensaje al historial (más reciente primero)
 */
export async function saveToHistory(msg: QueuedMessage): Promise<void> {
    const pipeline = redis.pipeline();
    pipeline.lrem(KEYS.history, 0, msg.id);            // elimina duplicados previos
    pipeline.lpush(KEYS.history, msg.id);              // inserta al frente (más reciente)
    pipeline.ltrim(KEYS.history, 0, MAX_HISTORY - 1); // limita tamaño
    await pipeline.exec();
}

/**
 * 5. PROGRAMAR REINTENTO — calcula delay progresivo y vuelve a encolar
 *    Delays: 1s → 5s → 30s → 2min → ...
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000];

export async function scheduleRetry(msg: QueuedMessage): Promise<boolean> {
    const esTemporalError = !msg.error?.toLowerCase().includes("bloqueado") &&
        !msg.error?.toLowerCase().includes("inválido");

    const puedeReintentar =
        msg.intentos < msg.maxIntentos &&
        esTemporalError;

    if (!puedeReintentar) {
        // Error definitivo → guarda en historial con el estado correcto
        const finalStatus = msg.error?.toLowerCase().includes("bloqueado") ? "Bloqueado" : "NoEnviado";
        await updateMessageStatus(msg.id, { status: finalStatus });
        await saveToHistory({ ...msg, status: finalStatus });
        return false;
    }

    const delayMs = RETRY_DELAYS_MS[msg.intentos] ?? RETRY_DELAYS_MS.at(-1)!;
    const proximoIntento = Date.now() + delayMs;

    await updateMessageStatus(msg.id, {
        status: "Pendiente",
        intentos: msg.intentos,   // ya fue incrementado por el worker
        proximoIntento,
    });

    // Volver a la cola (al final) — en producción usarías un sorted set con score=timestamp
    await redis.rpush(KEYS.queue, msg.id);

    return true;
}

// ──────────────────────────────────────────────
// CONSULTAS
// ──────────────────────────────────────────────

/**
 * Obtiene un mensaje por ID
 */
export async function getMessageById(id: string): Promise<QueuedMessage | null> {
    const hash = await redis.hgetall(KEYS.message(id));
    if (!hash?.id) return null;
    return fromHash(hash);
}

/**
 * Obtiene el historial paginado (más reciente primero)
 */
export async function getHistory(
    page = 0,
    limit = 20
): Promise<QueuedMessage[]> {
    const start = page * limit;
    const end = start + limit - 1;
    const ids = await redis.lrange(KEYS.history, start, end);

    if (!ids.length) return [];

    const pipeline = redis.pipeline();
    ids.forEach((id) => pipeline.hgetall(KEYS.message(id)));
    const results = await pipeline.exec();

    return (results ?? [])
        .map(([err, hash]) => (!err && hash ? fromHash(hash as Record<string, string>) : null))
        .filter(Boolean) as QueuedMessage[];
}

/**
 * Estadísticas de la cola y el historial
 */
export async function getQueueStats(): Promise<QueueStats> {
    const queueLength = await redis.llen(KEYS.queue);
    const historyIds = await redis.lrange(KEYS.history, 0, -1);

    const stats: QueueStats = {
        pendiente: 0,
        procesando: 0,
        enviado: 0,
        noEnviado: 0,
        bloqueado: 0,
        total: 0,
    };

    if (historyIds.length) {
        const pipeline = redis.pipeline();
        historyIds.forEach((id) => pipeline.hget(KEYS.message(id), "status"));
        const results = await pipeline.exec();

        (results ?? []).forEach(([, status]) => {
            if (!status) return;
            const s = (status as string).toLowerCase();
            if (s === "enviado") stats.enviado++;
            if (s === "noenviado") stats.noEnviado++;
            if (s === "bloqueado") stats.bloqueado++;
            if (s === "procesando") stats.procesando++;
        });
    }

    stats.pendiente = queueLength;
    stats.total = historyIds.length + queueLength;

    return stats;
}

/**
 * Limpieza automática — elimina mensajes del historial con más de N días
 */
export async function cleanOldMessages(olderThanDays = 30): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const allIds = await redis.lrange(KEYS.history, 0, -1);
    let removed = 0;

    for (const id of allIds) {
        const createdAt = await redis.hget(KEYS.message(id), "creadoEn");
        if (createdAt && Number(createdAt) < cutoff) {
            await redis.lrem(KEYS.history, 1, id);
            await redis.del(KEYS.message(id));
            removed++;
        }
    }

    return removed;
}