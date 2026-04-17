// ============================================================
// Cola con Redis para persistencia cross-instancia
// ============================================================
// Redis: guarda mensaje completo al encolar, lo recupera al desencolar
//        (2 cmds encolar, 2 cmds desencolar, 0 para todo lo demás)
// Memoria: historial, stats, estado post-dequeue

import type { MsgWhatsapp, QueuedMessage, QueueStats } from "../types";
import redis, { redisDequeue, redisEnqueue } from "./redis";
import {
    storeAddToHistory,
    storeCleanOld,
    storeGet,
    storeGetHistory, storeGetStats,
    storeSet,
} from "./store";

const HISTORY_KEY = "whatsapp:history";
const HISTORY_LIMIT = 1000;

function generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function redisAddToHistory(msg: QueuedMessage): Promise<void> {
    const raw = JSON.stringify(msg);

    await redis
        .multi()
        .lpush(HISTORY_KEY, raw)
        .ltrim(HISTORY_KEY, 0, HISTORY_LIMIT - 1)
        .exec();
}

// ── ENCOLAR — 2 comandos Redis (set + rpush) ─────────────────
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

    storeSet(msg);              // en memoria para el dashboard
    await redisEnqueue(msg);    // mensaje completo en Redis para cross-instancia
    return msg;
}

// ── DESENCOLAR — 2 comandos Redis (lpop + getdel) ────────────
export async function dequeueNext(): Promise<QueuedMessage | null> {
    // El mensaje viene completo desde Redis — funciona en cualquier instancia
    const msg = await redisDequeue();

    if (!msg) return null;

    // Sincronizar en memoria local para que el dashboard lo refleje
    storeSet(msg);
    return msg;
}

// ── ACTUALIZAR ESTADO — 0 comandos Redis ─────────────────────
export function updateMessageStatus(
    id: string,
    updates: Partial<Pick<QueuedMessage, "status" | "intentos" | "error" | "proximoIntento">>
): void {
    const msg = storeGet(id);
    if (!msg) return;
    storeSet({ ...msg, ...updates, actualizadoEn: Date.now() });
}

// ── HISTORIAL — 0 comandos Redis ─────────────────────────────
export function saveToHistory(msg: QueuedMessage): void {
    storeSet(msg);
    storeAddToHistory(msg.id);
}

// ── RETRY — 2 comandos Redis si reintenta ────────────────────
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000];

export async function scheduleRetry(msg: QueuedMessage): Promise<boolean> {
    const esTemporalError =
        !msg.error?.toLowerCase().includes("bloqueado") &&
        !msg.error?.toLowerCase().includes("inválido");

    const puedeReintentar = msg.intentos < msg.maxIntentos && esTemporalError;

    if (!puedeReintentar) {
        const finalStatus = msg.error?.toLowerCase().includes("bloqueado")
            ? "Bloqueado" : "NoEnviado";
        updateMessageStatus(msg.id, { status: finalStatus });
        await redisAddToHistory({ ...msg, status: finalStatus });
        return false;
    }

    const proximoIntento = Date.now() + (RETRY_DELAYS_MS[msg.intentos] ?? RETRY_DELAYS_MS.at(-1)!);
    const updated = { ...msg, status: "Pendiente" as const, intentos: msg.intentos, proximoIntento };
    updateMessageStatus(msg.id, { status: "Pendiente", intentos: msg.intentos, proximoIntento });
    await redisEnqueue(updated); // vuelve completo a Redis
    return true;
}

// ── CONSULTAS — 0 comandos Redis ─────────────────────────────
export function getMessageById(id: string): QueuedMessage | null {
    return storeGet(id) ?? null;
}

export function getHistory(page = 0, limit = 20): QueuedMessage[] {
    return storeGetHistory(page, limit);
}

export async function redisGetHistory(page = 0, limit = 50): Promise<MsgWhatsapp[]> {
    const start = page * limit;
    const end = start + limit - 1;
    const list = await redis.lrange(HISTORY_KEY, start, end);

    return list
        .map((item) => {
            try {
                return JSON.parse(JSON.stringify(item)) as MsgWhatsapp;
            } catch {
                return null;
            }
        })
        .filter(Boolean) as MsgWhatsapp[];
}

export function getQueueStats(): QueueStats {
    return storeGetStats();
}

export function cleanOldMessages(olderThanDays = 30): number {
    return storeCleanOld(olderThanDays);
}

export async function redisCleanOldMessages(days: number): Promise<number> {
    const cutoff = Date.now() - days * 86400000;

    const list = await redis.lrange<string>(HISTORY_KEY, 0, -1);

    let removed = 0;
    const keep: string[] = [];

    for (const item of list) {
        try {
            const msg = JSON.parse(item);
            if (msg.creadoEn >= cutoff) {
                keep.push(item);
            } else {
                removed++;
            }
        } catch {
            removed++;
        }
    }

    // reescribir lista
    await redis.del(HISTORY_KEY);
    if (keep.length > 0) {
        await redis.rpush(HISTORY_KEY, ...keep.reverse());
    }

    return removed;
}