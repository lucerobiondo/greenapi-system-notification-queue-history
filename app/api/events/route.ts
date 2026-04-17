// app/api/events/route.ts — SSE
// 0 comandos Redis — lee todo desde memoria
export const runtime = "nodejs";
export const maxDuration = 25;

import { getQueueStats, getHistory } from "@/lib/queueV3";

export async function GET() {
    let closed = false;

    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            let prevHash = "";

            function send(data: unknown) {
                if (closed) return;
                try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
                catch { closed = true; }
            }

            function emit() {
                if (closed) return;
                // Completamente síncrono — 0 comandos Redis
                const stats = getQueueStats();
                const history = getHistory(0, 50);
                const hash = JSON.stringify(stats);
                if (hash === prevHash) return;
                prevHash = hash;
                send({ stats, history });
            }

            emit(); // datos iniciales

            const interval = setInterval(emit, 2000);
            const heartbeat = setInterval(() => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
                catch { closed = true; }
            }, 15000);

            setTimeout(() => {
                closed = true;
                clearInterval(interval);
                clearInterval(heartbeat);
                try { controller.close(); } catch { /* ya cerrado */ }
            }, 24000);
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}