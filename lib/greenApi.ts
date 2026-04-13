// ============================================================
// lib/greenApi.ts — Adaptador para Green API (WhatsApp Business)
// ============================================================
// Variables de entorno necesarias:
//   GREEN_API_INSTANCE_ID  — ID de tu instancia en green-api.com
//   GREEN_API_TOKEN        — Token de la instancia

export interface GreenApiResult {
    ok: boolean;
    idMessage?: string;
    errorCode?: number;
    errorMessage?: string;
    /** "Bloqueado" si el número es inválido / permanentemente bloqueado */
    bloqueado?: boolean;
}

// Códigos de error de Green API que indican bloqueo permanente
const PERMANENT_BLOCK_CODES = new Set([400, 466, 403]);

/**
 * Envía un mensaje de texto a través de Green API.
 * El número debe tener formato internacional sin "+": "5491112345678"
 */
export async function sendWhatsAppMessage(
    telefono: string,
    mensaje: string
): Promise<GreenApiResult> {
    // Leídas aquí (runtime) para que Next.js las tenga disponibles
    const INSTANCE_ID = process.env.GREEN_API_INSTANCE_ID ?? "";
    const TOKEN = process.env.GREEN_API_TOKEN ?? "";
    const BASE_URL = `https://api.green-api.com/waInstance${INSTANCE_ID}`;

    if (!INSTANCE_ID || !TOKEN) {
        throw new Error(
            "Green API no configurado. Define GREEN_API_INSTANCE_ID y GREEN_API_TOKEN en .env.local"
        );
    }

    // Green API espera el número con sufijo @c.us
    const chatId = telefono.includes("@") ? telefono : `${telefono}@c.us`;

    try {
        const res = await fetch(`${BASE_URL}/sendMessage/${TOKEN}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId, message: mensaje }),
            signal: AbortSignal.timeout(15_000), // 15s timeout
        });

        const data = await res.json().catch(() => ({}));

        // Éxito
        if (res.ok && data.idMessage) {
            return { ok: true, idMessage: data.idMessage };
        }

        // Error permanente (bloqueo / número inválido)
        const bloqueado = PERMANENT_BLOCK_CODES.has(res.status) ||
            String(data.message ?? "").toLowerCase().includes("block");

        return {
            ok: false,
            errorCode: data.statusCode ?? res.status,
            errorMessage: data.message ?? `HTTP ${res.status}`,
            bloqueado,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            errorMessage: msg,
            bloqueado: false,
        };
    }
}