// ============================================================
// TIPOS DEL SISTEMA DE ENVÍO CON COLA E HISTORIAL
// ============================================================

export type MessageStatus =
    | "Pendiente"
    | "Procesando"
    | "Enviado"
    | "NoEnviado"
    | "Bloqueado";

export interface MessagePayload {
    telefono: string;
    contenido: string;
    metadata?: Record<string, unknown>;
}

export interface QueuedMessage {
    id: string;
    telefono: string;
    contenido: string;
    metadata?: Record<string, unknown>;
    status: MessageStatus;
    intentos: number;
    maxIntentos: number;
    creadoEn: number;       // timestamp ms
    actualizadoEn: number;  // timestamp ms
    proximoIntento?: number; // timestamp ms (para retry)
    error?: string;
}

export interface SendResult {
    messageId: string;
    status: "Enviado" | "NoEnviado" | "Bloqueado";
    error?: string;
}

export interface HistoryEntry extends QueuedMessage {
    resultadoEnvio?: SendResult;
}

export interface QueueStats {
    pendiente: number;
    procesando: number;
    enviado: number;
    noEnviado: number;
    bloqueado: number;
    total: number;
}