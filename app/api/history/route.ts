// ============================================================
// app/api/history/route.ts — GET /api/history
// ============================================================
// Historial de mensajes procesados.
//
// Query params:
//   page  (default 0)
//   limit (default 20)
//   status — filtra por estado (Enviado | NoEnviado | Bloqueado | ...)

import { NextRequest, NextResponse } from "next/server";
import { getHistory, cleanOldMessages } from "@/lib/queueV2";
import type { MessageStatus } from "@/types";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const page = Math.max(0, Number(searchParams.get("page") ?? 0));
        const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));
        const status = searchParams.get("status") as MessageStatus | null;

        let history = await getHistory(page, limit);

        // Filtro por estado (opcional)
        if (status) {
            history = history.filter((m) => m.status === status);
        }

        return NextResponse.json({ history, page, limit, total: history.length });
    } catch (err) {
        console.error("[GET /api/history]", err);
        return NextResponse.json(
            { error: "Error interno del servidor" },
            { status: 500 }
        );
    }
}

// DELETE /api/history — limpieza de mensajes antiguos
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const dias = Math.max(1, Number(searchParams.get("dias") ?? 30));

        const removed = await cleanOldMessages(dias);
        return NextResponse.json({ success: true, removed });
    } catch (err) {
        console.error("[DELETE /api/history]", err);
        return NextResponse.json(
            { error: "Error interno del servidor" },
            { status: 500 }
        );
    }
}