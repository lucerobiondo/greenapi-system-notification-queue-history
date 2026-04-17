import { getHistory, getQueueStats } from "@/lib/queueV3";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const page = Math.max(0, Number(searchParams.get("page") ?? 0));
        const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 50)));

        // Ambas son síncronas — 0 comandos Redis
        const stats = getQueueStats();
        const history = getHistory(page, limit);

        return NextResponse.json({ stats, history, page, limit });
    } catch (err) {
        console.error("[GET /api/queue]", err);
        return NextResponse.json({ error: "Error interno" }, { status: 500 });
    }
}
