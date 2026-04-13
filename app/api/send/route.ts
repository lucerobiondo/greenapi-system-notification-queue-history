// ============================================================
// app/api/send/route.ts — POST /api/send
// ============================================================
// Encola un nuevo mensaje para enviar por WhatsApp.
//
// Body JSON:
//   { telefono: string, contenido: string, metadata?: object, maxIntentos?: number }

import { NextRequest, NextResponse } from "next/server";
import { enqueueMessage } from "@/lib/queueV2";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        const { telefono, contenido, metadata, maxIntentos } = body as {
            telefono?: string;
            contenido?: string;
            metadata?: Record<string, unknown>;
            maxIntentos?: number;
        };

        // Validaciones básicas
        if (!telefono || typeof telefono !== "string") {
            return NextResponse.json(
                { error: "Campo 'telefono' requerido (string)" },
                { status: 400 }
            );
        }
        if (!contenido || typeof contenido !== "string") {
            return NextResponse.json(
                { error: "Campo 'contenido' requerido (string)" },
                { status: 400 }
            );
        }
        if (contenido.length > 4096) {
            return NextResponse.json(
                { error: "El contenido no puede superar 4096 caracteres" },
                { status: 400 }
            );
        }

        const msg = await enqueueMessage({
            telefono: telefono.replace(/\D/g, ""), // solo dígitos
            contenido,
            metadata,
            maxIntentos,
        });

        return NextResponse.json({ success: true, message: msg }, { status: 201 });
    } catch (err) {
        console.error("[POST /api/send]", err);
        return NextResponse.json(
            { error: "Error interno del servidor" },
            { status: 500 }
        );
    }
}