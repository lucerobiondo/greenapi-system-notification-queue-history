# WhatsApp Queue System — Next.js App Router

Sistema confiable de envío de mensajes WhatsApp con **cola Redis**, **reintentos automáticos** e **historial persistente**, basado en Green API.

## Estructura de archivos

```
├── types/
│   └── index.ts            # Tipos TypeScript del sistema
├── lib/
│   ├── redis.ts            # Cliente Redis (singleton)
│   ├── queue.ts            # Lógica de cola, historial y reintentos
│   ├── greenApi.ts         # Adaptador para Green API
│   └── worker.ts           # Worker que procesa la cola
├── app/api/
│   ├── send/route.ts       # POST /api/send — encolar mensaje
│   ├── queue/route.ts      # GET  /api/queue — stats + historial
│   ├── history/route.ts    # GET  /api/history — historial filtrado
│   └── worker/route.ts     # POST /api/worker — disparar worker
└── .env.example            # Variables de entorno
```

## Instalación

```bash
npm install ioredis
```

> Para producción serverless (Vercel) usá `@upstash/redis` en vez de `ioredis`.

## Configuración

```bash
cp .env.example .env.local
# Editar .env.local con tus credenciales
```

## Uso de los endpoints

### 1. Encolar un mensaje

```http
POST /api/send
Content-Type: application/json

{
  "telefono": "5491112345678",
  "contenido": "Hola! Este es un mensaje de prueba.",
  "maxIntentos": 3,
  "metadata": { "campaña": "verano2025" }
}
```

### 2. Disparar el worker (procesar cola)

```http
POST /api/worker

# Procesar un mensaje:
{ "mode": "once" }

# Vaciar toda la cola (máx 50 mensajes):
{ "mode": "drain", "maxMessages": 50 }
```

### 3. Ver estadísticas y historial

```http
GET /api/queue?page=0&limit=20
GET /api/history?status=NoEnviado&page=0
```

### 4. Limpiar mensajes antiguos

```http
DELETE /api/history?dias=30
```

## Flujo del sistema

```
Solicitud → Cola Redis (Pendiente)
         → Worker (Procesando)
         → Green API
         → Historial Redis (Enviado | NoEnviado | Bloqueado)
         ↑___ Retry automático (si aplica) _____|
```

## Configurar Cron Job (producción)

Con **Vercel Cron** en `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/worker",
      "schedule": "* * * * *"
    }
  ]
}
```

Con **Upstash QStash** podés programar llamadas al worker con delay progresivo.

## Estados del mensaje

| Estado      | Descripción                        |
|-------------|-------------------------------------|
| Pendiente   | En cola, esperando procesamiento    |
| Procesando  | Siendo enviado por el worker        |
| Enviado     | Entregado correctamente             |
| NoEnviado   | Falló el envío (error temporal)     |
| Bloqueado   | Número inválido o permanentemente bloqueado |