// ============================================================
// app/api/queue/route.ts — GET /api/queue
// ============================================================
// Retorna estadísticas de la cola y los mensajes en historial.
//
// Query params:
//   page  (default 0)
//   limit (default 20, máx 100)

import { NextRequest, NextResponse } from "next/server";
import { getQueueStats, getHistory } from "@/lib/queueV2";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const page = Math.max(0, Number(searchParams.get("page") ?? 0));
        const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));

        const [stats, history] = await Promise.all([
            getQueueStats(),
            getHistory(page, limit),
        ]);

        return NextResponse.json({ stats, history, page, limit });
    } catch (err) {
        console.error("[GET /api/queue]", err);
        return NextResponse.json(
            { error: "Error interno del servidor" },
            { status: 500 }
        );
    }
}