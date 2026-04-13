// ============================================================
// lib/worker.ts — Worker: procesa mensajes de la cola
// ============================================================

import {
    dequeueNext,
    updateMessageStatus,
    saveToHistory,
    scheduleRetry,
} from "./queueV2";
import { sendWhatsAppMessage } from "./greenApi";
import type { QueuedMessage } from "../types";

const SEND_INTERVAL_MS = Number(process.env.WORKER_SEND_INTERVAL_MS ?? 1_500);

// ──────────────────────────────────────────────
// PROCESAMIENTO DE UN SOLO MENSAJE
// ──────────────────────────────────────────────

export async function processMessage(msg: QueuedMessage): Promise<void> {
    console.log(`[Worker] Procesando ${msg.id} → ${msg.telefono}`);

    await updateMessageStatus(msg.id, { status: "Procesando" });

    const result = await sendWhatsAppMessage(msg.telefono, msg.contenido);

    if (result.ok) {
        await updateMessageStatus(msg.id, { status: "Enviado" });
        await saveToHistory({ ...msg, status: "Enviado" });
        console.log(`[Worker] ✓ Enviado ${msg.id}`);
        return;
    }

    const intentos = msg.intentos + 1;
    const errorMsg = result.bloqueado
        ? `Bloqueado: ${result.errorMessage}`
        : result.errorMessage ?? "Error desconocido";

    await updateMessageStatus(msg.id, { intentos, error: errorMsg });

    const reintentado = await scheduleRetry({ ...msg, intentos, error: errorMsg });

    if (reintentado) {
        console.log(`[Worker] ↻ Reintento programado para ${msg.id} (intento ${intentos})`);
    } else {
        console.log(`[Worker] ✗ Error definitivo en ${msg.id}: ${errorMsg}`);
    }
}

// ──────────────────────────────────────────────
// PROCESAR UN SOLO MENSAJE DE LA COLA
// ──────────────────────────────────────────────

export async function runWorkerOnce(): Promise<{ processed: number }> {
    const msg = await dequeueNext();
    if (!msg) {
        console.log("[Worker] Cola vacía");
        return { processed: 0 };
    }

    await processMessage(msg);
    return { processed: 1 };
}

// ──────────────────────────────────────────────
// VACIAR TODA LA COLA — procesa todos los mensajes
// en una sola invocación con intervalo entre envíos
// ──────────────────────────────────────────────

export async function drainQueue(maxMessages = 100): Promise<{ processed: number }> {
    let total = 0;

    for (let i = 0; i < maxMessages; i++) {
        // Sacar el siguiente mensaje directamente (sin lock)
        const msg = await dequeueNext();
        if (!msg) {
            console.log(`[Worker] Cola vacía tras ${total} mensaje(s)`);
            break;
        }

        // Intervalo entre envíos para evitar rate limiting (excepto antes del primero)
        if (i > 0) {
            await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
        }

        await processMessage(msg);
        total++;

        console.log(`[Worker] Progreso: ${total} procesados`);
    }

    return { processed: total };
}