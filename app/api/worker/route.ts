// ============================================================
// app/api/worker/route.ts — POST /api/worker
// ============================================================
// Dispara el worker para procesar mensajes de la cola.
// En producción, llamá este endpoint desde un cron job o
// desde un servicio externo (ej: Vercel Cron, Upstash QStash).
//
// Body JSON (opcional):
//   { mode: "once" | "drain", maxMessages?: number }
//
// Protección: verificar WORKER_SECRET en producción.

import { NextRequest, NextResponse } from "next/server";
import { runWorkerOnce, drainQueue } from "@/lib/worker";

const WORKER_SECRET = process.env.WORKER_SECRET;

export async function POST(req: NextRequest) {
    // Protección por secret header (recomendado en producción)
    if (WORKER_SECRET) {
        const authHeader = req.headers.get("x-worker-secret");
        if (authHeader !== WORKER_SECRET) {
            return NextResponse.json({ error: "No autorizado" }, { status: 401 });
        }
    }

    try {
        const body = await req.json().catch(() => ({}));
        const mode = body.mode as string ?? "once";
        const maxMessages = body.maxMessages as number ?? 50;

        let result: { processed: number };

        if (mode === "drain") {
            result = await drainQueue(maxMessages);
        } else {
            result = await runWorkerOnce();
        }

        return NextResponse.json({ success: true, ...result });
    } catch (err) {
        console.error("[POST /api/worker]", err);
        return NextResponse.json(
            { error: "Error interno del servidor" },
            { status: 500 }
        );
    }
}

// GET /api/worker — health check del worker
export async function GET() {
    return NextResponse.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        info: "Usa POST para disparar el worker",
    });
}