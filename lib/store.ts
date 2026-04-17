// ============================================================
// lib/store.ts — Estado en memoria del servidor
// ============================================================
// Redis SOLO se usa para la cola de entrada (rpush/lpop).
// Todo lo demás vive acá: historial, stats, estado de mensajes.
//
// En Vercel cada serverless function tiene su propia memoria,
// pero como el worker y las API routes corren en el mismo proceso
// durante el tiempo de vida de la instancia, esto es suficiente
// para un sistema de envío secuencial.
//
// Si necesitás persistencia ante reinicios: exportá/importá el
// store a un JSON en Upstash como backup, pero para la operación
// normal en memoria es más que suficiente y cero comandos extra.

import type { QueuedMessage, MessageStatus, QueueStats } from "../types";

// ──────────────────────────────────────────────
// ESTADO GLOBAL EN MEMORIA
// ──────────────────────────────────────────────

interface Store {
    // Mensajes indexados por ID
    messages: Map<string, QueuedMessage>;
    // IDs en orden de más reciente a más viejo (historial)
    history: string[];
    // Contadores por estado
    counters: Record<MessageStatus, number>;
}

declare global {
    var _store: Store | undefined;
}

function createStore(): Store {
    return {
        messages: new Map(),
        history: [],
        counters: {
            Pendiente: 0,
            Procesando: 0,
            Enviado: 0,
            NoEnviado: 0,
            Bloqueado: 0,
        },
    };
}

// Singleton — sobrevive hot-reloads en desarrollo
const store: Store =
    globalThis._store ?? (globalThis._store = createStore());

// ──────────────────────────────────────────────
// OPERACIONES
// ──────────────────────────────────────────────

export function storeGet(id: string): QueuedMessage | undefined {
    return store.messages.get(id);
}

export function storeSet(msg: QueuedMessage): void {
    const prev = store.messages.get(msg.id);

    // Ajustar contadores si el estado cambió
    if (prev && prev.status !== msg.status) {
        store.counters[prev.status] = Math.max(0, store.counters[prev.status] - 1);
        store.counters[msg.status]++;
    } else if (!prev) {
        store.counters[msg.status]++;
    }

    store.messages.set(msg.id, msg);
}

export function storeAddToHistory(id: string): void {
    // Eliminar duplicado si existe
    const idx = store.history.indexOf(id);
    if (idx !== -1) store.history.splice(idx, 1);
    // Insertar al frente (más reciente primero)
    store.history.unshift(id);
    // Limitar a 1000 entradas
    if (store.history.length > 1000) {
        const removed = store.history.splice(1000);
        removed.forEach(rid => store.messages.delete(rid));
    }
}

export function storeGetHistory(page = 0, limit = 50): QueuedMessage[] {
    return store.history
        .slice(page * limit, page * limit + limit)
        .map(id => store.messages.get(id))
        .filter(Boolean) as QueuedMessage[];
}

export function storeGetStats(): QueueStats {
    const { Enviado, NoEnviado, Bloqueado, Procesando } = store.counters;
    // Pendiente lo sabemos por la cola de Redis, pero también lo trackeamos en counters
    const pendiente = store.counters.Pendiente;
    return {
        pendiente,
        procesando: Procesando,
        enviado: Enviado,
        noEnviado: NoEnviado,
        bloqueado: Bloqueado,
        total: pendiente + Procesando + Enviado + NoEnviado + Bloqueado,
    };
}

export function storeCleanOld(olderThanDays: number): number {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    let removed = 0;

    store.history = store.history.filter(id => {
        const msg = store.messages.get(id);
        if (msg && msg.creadoEn < cutoff) {
            store.counters[msg.status] = Math.max(0, store.counters[msg.status] - 1);
            store.messages.delete(id);
            removed++;
            return false;
        }
        return true;
    });

    return removed;
}