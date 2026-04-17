// app/api/history/route.ts

import { NextRequest, NextResponse } from "next/server";
import {
    redisGetHistory,
    redisCleanOldMessages
} from "@/lib/queueV3";
import type { MessageStatus, MsgWhatsapp } from "@/types";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);

    const page = Math.max(0, Number(searchParams.get("page") ?? 0));
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 50)));
    const status = searchParams.get("status") as MessageStatus | null;

    let history: MsgWhatsapp[] = await redisGetHistory(page, limit);

    if (status) {
        history = history.filter(m => m.status === status);
    }

    return NextResponse.json({ history, page, limit });
}

export async function DELETE(req: NextRequest) {
    const dias = Math.max(1, Number(new URL(req.url).searchParams.get("dias") ?? 30));

    const removed = await redisCleanOldMessages(dias);

    return NextResponse.json({ success: true, removed });
}