"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
type Status = "Pendiente" | "Procesando" | "Enviado" | "NoEnviado" | "Bloqueado";

interface Msg {
  id: string;
  telefono: string;
  contenido: string;
  status: Status;
  intentos: number;
  maxIntentos: number;
  creadoEn: number;
  actualizadoEn: number;
  error?: string;
}

interface Stats {
  pendiente: number;
  procesando: number;
  enviado: number;
  noEnviado: number;
  bloqueado: number;
  total: number;
}

interface LogEntry {
  ts: number;
  type: "info" | "ok" | "err" | "warn";
  text: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_META: Record<Status, { label: string; color: string; icon: string }> = {
  Pendiente: { label: "Pendiente", color: "#f59e0b", icon: "⏳" },
  Procesando: { label: "Procesando", color: "#3b82f6", icon: "⚙️" },
  Enviado: { label: "Enviado", color: "#25d366", icon: "✓" },
  NoEnviado: { label: "No Enviado", color: "#ef4444", icon: "✗" },
  Bloqueado: { label: "Bloqueado", color: "#f97316", icon: "⚠" },
};

const PHONES_EXAMPLE = [
  "5491198765432",
  "5493512000001",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtRelative(ts: number) {
  const d = Date.now() - ts;
  if (d < 5000) return "ahora";
  if (d < 60000) return `${Math.floor(d / 1000)}s`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m`;
  return `${Math.floor(d / 3600000)}h`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  // Form state
  const [phones, setPhones] = useState("");
  const [message, setMessage] = useState("");
  const [maxRetries, setMaxRetries] = useState(3);
  const [sending, setSending] = useState(false);
  const [bulk, setBulk] = useState(false);

  // Data state
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<Msg[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tab, setTab] = useState<"send" | "history" | "worker">("send");
  const [workerBusy, setWorkerBusy] = useState(false);
  const [filterStatus, setFilterStatus] = useState<Status | "">("");

  const logRef = useRef<HTMLDivElement>(null);

  // ── Logging ──────────────────────────────────────────────────────────────
  const log = useCallback((text: string, type: LogEntry["type"] = "info") => {
    setLogs(prev => [{ ts: Date.now(), type, text }, ...prev].slice(0, 80));
  }, []);

  // ── Fetch stats + history ────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/queue?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats(data.stats);
      setHistory(data.history ?? []);
    } catch (e: unknown) {
      log(`Error al obtener datos: ${e instanceof Error ? e.message : e}`, "err");
    }
  }, [log]);

  // ── Auto-refresh every 3s ────────────────────────────────────────────────
  useEffect(() => {
    refresh();
    if (!autoRefresh) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  // ── Send message(s) ──────────────────────────────────────────────────────
  async function handleSend() {
    const lines = phones.split(/[\n,;]+/).map(p => p.trim()).filter(Boolean);
    if (!lines.length) { log("Ingresá al menos un número", "warn"); return; }
    if (!message.trim()) { log("El mensaje no puede estar vacío", "warn"); return; }

    setSending(true);
    log(`Encolando ${lines.length} mensaje(s)...`, "info");

    let ok = 0, fail = 0;
    for (const phone of lines) {
      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ telefono: phone, contenido: message.trim(), maxIntentos: maxRetries }),
        });
        const data = await res.json();
        if (res.ok) {
          log(`✓ Encolado ${phone} → ${data.message?.id}`, "ok");
          ok++;
        } else {
          log(`✗ Error ${phone}: ${data.error}`, "err");
          fail++;
        }
      } catch (e: unknown) {
        log(`✗ Fallo de red para ${phone}: ${e instanceof Error ? e.message : e}`, "err");
        fail++;
      }
    }

    log(`Completado: ${ok} encolados, ${fail} fallidos`, ok > 0 ? "ok" : "err");
    if (!bulk) setPhones("");
    setSending(false);
    refresh();
  }

  // ── Trigger worker ───────────────────────────────────────────────────────
  async function handleWorker(mode: "once" | "drain") {
    setWorkerBusy(true);
    log(`Disparando worker (modo: ${mode})...`, "info");
    try {
      const res = await fetch("/api/worker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, maxMessages: 50 }),
      });
      const data = await res.json();
      if (res.ok) {
        log(`Worker OK — procesados: ${data.processed}`, "ok");
      } else {
        log(`Worker error: ${data.error}`, "err");
      }
      refresh();
    } catch (e: unknown) {
      log(`Worker fallo de red: ${e instanceof Error ? e.message : e}`, "err");
    }
    setWorkerBusy(false);
  }

  // ── Clean history ─────────────────────────────────────────────────────────
  async function handleClean(dias: number) {
    log(`Limpiando mensajes con más de ${dias} día(s)...`, "warn");
    const res = await fetch(`/api/history?dias=${dias}`, { method: "DELETE" });
    const data = await res.json();
    log(`Limpieza: ${data.removed} mensajes eliminados`, "ok");
    refresh();
  }

  // ── Filtered history ──────────────────────────────────────────────────────
  const filtered = filterStatus ? history.filter(m => m.status === filterStatus) : history;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <div style={s.logo}>
            <span style={s.logoIcon}>◈</span>
            <div>
              <div style={s.logoTitle}>WhatsApp Queue</div>
              <div style={s.logoSub}>Panel de pruebas local</div>
            </div>
          </div>
          <div style={s.headerRight}>
            <button
              style={{ ...s.btn, ...(autoRefresh ? s.btnAccent : s.btnGhost) }}
              onClick={() => setAutoRefresh(v => !v)}
            >
              {autoRefresh ? "⟳ Auto ON" : "⟳ Auto OFF"}
            </button>
            <button style={{ ...s.btn, ...s.btnGhost }} onClick={refresh}>Actualizar</button>
          </div>
        </div>
      </header>

      {/* ── Stats Bar ── */}
      <div style={s.statsBar}>
        {stats ? (
          Object.entries(STATUS_META).map(([key, meta]) => (
            <div key={key} style={s.statCard}>
              <div style={{ ...s.statNum, color: meta.color }}>
                {stats[key.toLowerCase() as keyof Stats] ?? 0}
              </div>
              <div style={s.statLabel}>{meta.icon} {meta.label}</div>
            </div>
          ))
        ) : (
          <div style={s.muted}>Conectando con Redis...</div>
        )}
        {stats && (
          <div style={{ ...s.statCard, borderColor: "#2a3040" }}>
            <div style={{ ...s.statNum, color: "#e8eaf0" }}>{stats.total}</div>
            <div style={s.statLabel}>◈ Total</div>
          </div>
        )}
      </div>

      {/* ── Main Grid ── */}
      <div style={s.main}>
        {/* ── Left Panel ── */}
        <div style={s.leftPanel}>
          {/* Tabs */}
          <div style={s.tabs}>
            {(["send", "history", "worker"] as const).map(t => (
              <button
                key={t}
                // style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
                onClick={() => setTab(t)}
              >
                {{ send: "▶ Enviar", history: "☰ Historial", worker: "⚙ Worker" }[t]}
              </button>
            ))}
          </div>

          {/* ── TAB: SEND ── */}
          {tab === "send" && (
            <div style={s.panel}>
              <div style={s.fieldGroup}>
                <label style={s.label}>
                  Números de teléfono
                  <span style={s.labelHint}> — uno por línea, separados por coma o punto y coma</span>
                </label>
                <textarea
                  style={{ ...s.input, height: 110, resize: "vertical" }}
                  placeholder={"5491112345678\n5491198765432\n5493512000001"}
                  value={phones}
                  onChange={e => setPhones(e.target.value)}
                />
                <div style={s.examples}>
                  {PHONES_EXAMPLE.map(p => (
                    <button
                      key={p}
                      style={s.exampleBtn}
                      onClick={() => setPhones(v => v ? `${v}\n${p}` : p)}
                    >
                      + {p}
                    </button>
                  ))}
                </div>
              </div>

              <div style={s.fieldGroup}>
                <label style={s.label}>Mensaje</label>
                <textarea
                  style={{ ...s.input, height: 100, resize: "vertical" }}
                  placeholder="Hola! Este es un mensaje de prueba desde el sistema de cola."
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  maxLength={4096}
                />
                <div style={s.charCount}>{message.length}/4096</div>
              </div>

              <div style={s.row}>
                <div style={s.fieldGroup}>
                  <label style={s.label}>Máx. reintentos</label>
                  <select
                    style={s.select}
                    value={maxRetries}
                    onChange={e => setMaxRetries(Number(e.target.value))}
                  >
                    {[1, 2, 3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div style={s.fieldGroup}>
                  <label style={s.label}>Mantener números</label>
                  <button
                    style={{ ...s.btn, ...(bulk ? s.btnAccent : s.btnGhost), marginTop: 4 }}
                    onClick={() => setBulk(v => !v)}
                  >
                    {bulk ? "✓ Sí" : "No"}
                  </button>
                </div>
              </div>

              <button
                style={{ ...s.btn, ...s.btnAccent, ...s.btnLarge, ...(sending ? s.btnDisabled : {}) }}
                onClick={handleSend}
                disabled={sending}
              >
                {sending ? "Encolando..." : "▶ Encolar mensaje(s)"}
              </button>

              <div style={s.hint}>
                Los mensajes se guardan en Redis con estado <span style={{ color: "#f59e0b" }}>Pendiente</span>.
                Usá la pestaña <strong>Worker</strong> para procesarlos.
              </div>
            </div>
          )}

          {/* ── TAB: HISTORY ── */}
          {tab === "history" && (
            <div style={s.panel}>
              <div style={{ ...s.row, marginBottom: 12, gap: 8 }}>
                <select
                  style={{ ...s.select, flex: 1 }}
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value as Status | "")}
                >
                  <option value="">Todos los estados</option>
                  {Object.entries(STATUS_META).map(([k, v]) => (
                    <option key={k} value={k}>{v.icon} {v.label}</option>
                  ))}
                </select>
                <button style={{ ...s.btn, ...s.btnGhost }} onClick={refresh}>↺</button>
              </div>

              {filtered.length === 0 ? (
                <div style={s.empty}>No hay mensajes{filterStatus ? ` con estado "${filterStatus}"` : ""}</div>
              ) : (
                <div style={s.msgList}>
                  {filtered.map(msg => (
                    <MsgCard key={msg.id} msg={msg} />
                  ))}
                </div>
              )}

              <div style={{ ...s.row, marginTop: 16, gap: 8 }}>
                <button style={{ ...s.btn, ...s.btnDanger }} onClick={() => handleClean(1)}>
                  🗑 Limpiar &gt;1 día
                </button>
                <button style={{ ...s.btn, ...s.btnDanger }} onClick={() => handleClean(30)}>
                  🗑 Limpiar &gt;30 días
                </button>
              </div>
            </div>
          )}

          {/* ── TAB: WORKER ── */}
          {tab === "worker" && (
            <div style={s.panel}>
              <div style={s.workerInfo}>
                <div style={s.workerTitle}>⚙ Control del Worker</div>
                <p style={s.workerDesc}>
                  El worker toma mensajes <span style={{ color: "#f59e0b" }}>Pendientes</span> de la cola Redis,
                  los envía por Green API y actualiza su estado.
                  En producción esto corre automáticamente cada minuto vía cron.
                </p>
              </div>

              <div style={s.workerBtns}>
                <button
                  style={{ ...s.btn, ...s.btnAccent, ...s.btnLarge, ...(workerBusy ? s.btnDisabled : {}) }}
                  onClick={() => handleWorker("once")}
                  disabled={workerBusy}
                >
                  ▶ Procesar 1 mensaje
                </button>
                <button
                  style={{ ...s.btn, ...s.btnInfo, ...s.btnLarge, ...(workerBusy ? s.btnDisabled : {}) }}
                  onClick={() => handleWorker("drain")}
                  disabled={workerBusy}
                >
                  ⚡ Vaciar cola completa
                </button>
              </div>

              <div style={s.flowDiagram}>
                {["Pendiente", "Procesando", "Green API", "Enviado/Fallido", "Retry?"].map((step, i) => (
                  <div key={step} style={s.flowStep}>
                    <div style={s.flowBox}>{step}</div>
                    {i < 4 && <div style={s.flowArrow}>→</div>}
                  </div>
                ))}
              </div>

              <div style={s.hint}>
                <strong>Estrategia de retry:</strong> delays progresivos 1s → 5s → 30s → 2min.
                Bloqueos permanentes no se reintentan.
              </div>
            </div>
          )}
        </div>

        {/* ── Right Panel: Log ── */}
        <div style={s.rightPanel}>
          <div style={s.logHeader}>
            <span style={s.logTitle}>◈ Log en tiempo real</span>
            <button style={s.clearBtn} onClick={() => setLogs([])}>limpiar</button>
          </div>
          <div style={s.logBody} ref={logRef}>
            {logs.length === 0 && (
              <div style={s.logEmpty}>Esperando actividad...</div>
            )}
            {logs.map((entry, i) => (
              <div key={i} style={{ ...s.logLine, ...s.logColors[entry.type] }}>
                <span style={s.logTs}>{fmtTime(entry.ts)}</span>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Message Card ─────────────────────────────────────────────────────────────
function MsgCard({ msg }: { msg: Msg }) {
  const meta = STATUS_META[msg.status];
  return (
    <div style={s.msgCard}>
      <div style={s.msgCardHeader}>
        <span style={s.msgId}>{msg.id.slice(-12)}</span>
        <span style={{ ...s.badge, backgroundColor: meta.color + "22", color: meta.color }}>
          {meta.icon} {meta.label}
        </span>
      </div>
      <div style={s.msgPhone}>📱 {msg.telefono}</div>
      <div style={s.msgContent}>{msg.contenido}</div>
      <div style={s.msgMeta}>
        <span>Intentos: {msg.intentos}/{msg.maxIntentos}</span>
        <span>{fmtRelative(msg.actualizadoEn)}</span>
      </div>
      {msg.error && <div style={s.msgError}>{msg.error}</div>}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties | Record<string, React.CSSProperties>> = {
  root: { minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0a0c0f" },

  header: { borderBottom: "1px solid #1f2430", background: "#0d0f13" },
  headerInner: { maxWidth: 1400, margin: "0 auto", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" },
  logo: { display: "flex", alignItems: "center", gap: 14 },
  logoIcon: { fontSize: 28, color: "#25d366" },
  logoTitle: { fontFamily: "Syne, sans-serif", fontWeight: 800, fontSize: 18, color: "#e8eaf0", letterSpacing: -0.5 },
  logoSub: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#5a6278", marginTop: 2 },
  headerRight: { display: "flex", gap: 10 },

  statsBar: { display: "flex", gap: 12, padding: "16px 24px", maxWidth: 1400, margin: "0 auto", width: "100%", flexWrap: "wrap" },
  statCard: { flex: "1 1 100px", background: "#111318", border: "1px solid #1f2430", borderRadius: 10, padding: "12px 16px", minWidth: 100 },
  statNum: { fontFamily: "Syne, sans-serif", fontWeight: 800, fontSize: 28, lineHeight: 1 },
  statLabel: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#5a6278", marginTop: 4 },

  main: { flex: 1, display: "flex", gap: 0, maxWidth: 1400, margin: "0 auto", width: "100%", padding: "0 24px 24px" },

  leftPanel: { flex: "1 1 600px", minWidth: 0 },
  rightPanel: { width: 340, marginLeft: 20, display: "flex", flexDirection: "column", background: "#0d0f13", border: "1px solid #1f2430", borderRadius: 12, overflow: "hidden", alignSelf: "flex-start", position: "sticky", top: 16 },

  tabs: { display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid #1f2430", paddingBottom: 0 },
  tab: { fontFamily: "Syne, sans-serif", fontWeight: 600, fontSize: 13, padding: "10px 18px", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "#5a6278", cursor: "pointer", transition: "all 0.15s" },
  tabActive: { color: "#25d366", borderBottomColor: "#25d366" },

  panel: { background: "#111318", border: "1px solid #1f2430", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 16 },

  fieldGroup: { display: "flex", flexDirection: "column", gap: 6, flex: 1 },
  label: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#8a94ac", fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5 },
  labelHint: { color: "#5a6278", textTransform: "none", fontWeight: 400 },
  input: { fontFamily: "JetBrains Mono, monospace", fontSize: 13, background: "#0a0c0f", border: "1px solid #1f2430", borderRadius: 8, color: "#e8eaf0", padding: "10px 12px", outline: "none", width: "100%", transition: "border-color 0.15s" },
  select: { fontFamily: "JetBrains Mono, monospace", fontSize: 13, background: "#0a0c0f", border: "1px solid #1f2430", borderRadius: 8, color: "#e8eaf0", padding: "10px 12px", outline: "none" },
  charCount: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#5a6278", textAlign: "right" },

  examples: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 },
  exampleBtn: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, background: "#1a1f2a", border: "1px solid #2a3040", borderRadius: 6, color: "#8a94ac", padding: "4px 10px", cursor: "pointer" },

  row: { display: "flex", gap: 16, alignItems: "flex-end" },

  btn: { fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 13, padding: "9px 18px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", transition: "all 0.15s", letterSpacing: 0.2, whiteSpace: "nowrap" },
  btnAccent: { background: "#25d366", color: "#0a0c0f", border: "1px solid #25d366" },
  btnGhost: { background: "transparent", color: "#8a94ac", border: "1px solid #2a3040" },
  btnInfo: { background: "#1d3a6b", color: "#93c5fd", border: "1px solid #2a4080" },
  btnDanger: { background: "#2d1515", color: "#f87171", border: "1px solid #5a2020", fontSize: 12 },
  btnLarge: { padding: "12px 24px", fontSize: 14 },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },

  hint: { fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, color: "#5a6278", background: "#0d0f13", border: "1px solid #1a1f2a", borderRadius: 8, padding: "10px 14px", lineHeight: 1.7 },

  msgList: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 480, overflowY: "auto" },
  msgCard: { background: "#0d0f13", border: "1px solid #1f2430", borderRadius: 10, padding: 14 },
  msgCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  msgId: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#5a6278" },
  badge: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, padding: "3px 9px", borderRadius: 12, fontWeight: 600 },
  msgPhone: { fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#3b82f6", marginBottom: 4 },
  msgContent: { fontSize: 13, color: "#c8ccd8", marginBottom: 6, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  msgMeta: { display: "flex", justifyContent: "space-between", fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#5a6278" },
  msgError: { marginTop: 6, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#ef4444", background: "#1a0a0a", padding: "4px 8px", borderRadius: 6 },

  empty: { textAlign: "center", color: "#5a6278", fontFamily: "JetBrains Mono, monospace", fontSize: 13, padding: 40 },

  workerInfo: { background: "#0d0f13", border: "1px solid #1f2430", borderRadius: 10, padding: 16 },
  workerTitle: { fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 15, marginBottom: 8, color: "#e8eaf0" },
  workerDesc: { fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#5a6278", lineHeight: 1.7 },
  workerBtns: { display: "flex", flexDirection: "column", gap: 10 },
  flowDiagram: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4, background: "#0d0f13", border: "1px solid #1f2430", borderRadius: 10, padding: "12px 14px" },
  flowStep: { display: "flex", alignItems: "center", gap: 4 },
  flowBox: { fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#8a94ac", background: "#1a1f2a", border: "1px solid #2a3040", borderRadius: 6, padding: "4px 8px" },
  flowArrow: { color: "#25d366", fontSize: 14 },

  logHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #1f2430" },
  logTitle: { fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 13, color: "#e8eaf0" },
  clearBtn: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#5a6278", background: "transparent", border: "none", cursor: "pointer" },
  logBody: { flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4, maxHeight: 520, fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
  logEmpty: { color: "#5a6278", textAlign: "center", padding: 20 },
  logLine: { display: "flex", gap: 8, padding: "4px 8px", borderRadius: 6, lineHeight: 1.5 },
  logTs: { color: "#5a6278", flexShrink: 0 },
  logColors: {
    info: { background: "#111318", color: "#8a94ac" },
    ok: { background: "#0a1f12", color: "#25d366" },
    err: { background: "#1a0a0a", color: "#f87171" },
    warn: { background: "#1a1200", color: "#f59e0b" },
  },

  muted: { color: "#5a6278", fontFamily: "JetBrains Mono, monospace", fontSize: 13 },
};