// ============================================================
//  Worker sin cambios de firma, pero ahora
// updateMessageStatus y saveToHistory son síncronos (memoria)
// ============================================================

import type { QueuedMessage } from "../types";
import { sendWhatsAppMessage } from "./greenApi";
import { dequeueNext, redisAddToHistory, scheduleRetry, updateMessageStatus } from "./queueV3";

const SEND_INTERVAL_MS = Number(process.env.WORKER_SEND_INTERVAL_MS ?? 1_500);

export async function processMessage(msg: QueuedMessage): Promise<void> {
    console.log(`[Worker] Procesando ${msg.id} → ${msg.telefono}`);

    updateMessageStatus(msg.id, { status: "Procesando" });

    const result = await sendWhatsAppMessage(msg.telefono, msg.contenido);

    if (result.ok) {
        const updatedMsg: QueuedMessage = { ...msg, status: "Enviado" };

        updateMessageStatus(msg.id, { status: "Enviado" });
        await redisAddToHistory(updatedMsg);
        console.log(`[Worker] ✓ Enviado ${msg.id}`);
        return;
    }

    const intentos = msg.intentos + 1;
    const errorMsg = result.bloqueado
        ? `Bloqueado: ${result.errorMessage}`
        : result.errorMessage ?? "Error desconocido";

    updateMessageStatus(msg.id, { intentos, error: errorMsg });

    const reintentado = await scheduleRetry({ ...msg, intentos, error: errorMsg });
    console.log(reintentado
        ? `[Worker] ↻ Reintento ${msg.id} (intento ${intentos})`
        : `[Worker] ✗ Error definitivo ${msg.id}: ${errorMsg}`
    );
}

export async function runWorkerOnce(): Promise<{ processed: number }> {
    const msg = await dequeueNext();
    if (!msg) return { processed: 0 };
    await processMessage(msg);
    return { processed: 1 };
}

export async function drainQueue(maxMessages = 100): Promise<{ processed: number }> {
    let total = 0;

    for (let i = 0; i < maxMessages; i++) {
        const msg = await dequeueNext();

        if (!msg) break;
        if (i > 0) await new Promise(r => setTimeout(r, SEND_INTERVAL_MS));
        await processMessage(msg);
        total++;
    }
    return { processed: total };
}