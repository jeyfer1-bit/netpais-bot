// conversaciones.js — registro de conversaciones del bot en Postgres.
//
// Ciclo de vida (ver HANDOFF_bot_conversaciones.md, sección 5):
//   bot ──(cliente dice "no, nada más")──────────────▶ cerrada / resuelta_bot
//   bot ──(transferir: el bot no puede resolver)─────▶ esperando_humano (el bot calla)
//   esperando_humano ──(un agente la toma)───────────▶ con_humano        [Fase 3, desde el portal]
//   con_humano ──(el agente la cierra / la devuelve)─▶ cerrada / bot     [Fase 3]
//   bot ──(el cliente deja de responder X minutos)───▶ cerrada / abandonada
//   cualquiera ──(#reset)────────────────────────────▶ cerrada / reiniciada (solo pruebas)
//
// Si no hay DATABASE_URL, todas las funciones son inofensivas (no hacen nada).

const db = require('./db');

const ESTADOS_SILENCIO = ['esperando_humano', 'con_humano']; // el bot no responde, solo registra

const COLAS = ['mda', 'administrativo', 'comercial', 'servicio_cliente'];

const ABANDONO_MIN = Number(process.env.BOT_ABANDONO_MIN || 30);

// ---------------------------------------------------------------
// Conversación abierta
// ---------------------------------------------------------------
async function obtenerOCrear(telefono) {
  if (!db.activa()) return null;
  const abierta = await db.query(
    `SELECT * FROM bot_conversaciones WHERE telefono = $1 AND estado <> 'cerrada' LIMIT 1`,
    [telefono]
  );
  if (abierta.rows[0]) return abierta.rows[0];
  // El índice único parcial evita dos conversaciones abiertas para el mismo número
  const nueva = await db.query(
    `INSERT INTO bot_conversaciones (telefono, estado) VALUES ($1, 'bot')
     ON CONFLICT (telefono) WHERE estado <> 'cerrada' DO NOTHING
     RETURNING *`,
    [telefono]
  );
  if (nueva.rows[0]) return nueva.rows[0];
  const otra = await db.query(
    `SELECT * FROM bot_conversaciones WHERE telefono = $1 AND estado <> 'cerrada' LIMIT 1`,
    [telefono]
  );
  return otra.rows[0] || null;
}

// ---------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------

/**
 * Guarda un mensaje del cliente. Devuelve false si ese mensaje ya se había
 * recibido (Meta reintentó el webhook): en ese caso no hay que procesarlo otra vez.
 */
async function registrarEntrante(conv, { tipo = 'text', texto = null, mediaId = null, waId = null }) {
  if (!conv) return true;
  const r = await db.query(
    `INSERT INTO bot_mensajes (conversacion_id, direccion, autor, tipo, texto, media_id, wa_message_id)
     VALUES ($1, 'entrante', 'cliente', $2, $3, $4, $5)
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [conv.id, tipo, texto, mediaId, waId]
  );
  if (!r.rows[0]) return false;
  await db.query(
    `UPDATE bot_conversaciones SET ultimo_mensaje_en = now(), ultimo_mensaje_cliente_en = now() WHERE id = $1`,
    [conv.id]
  );
  return true;
}

/**
 * Completa el texto de un mensaje entrante (ej: transcripción de una nota de voz).
 */
async function completarEntrante(waId, texto) {
  if (!db.activa() || !waId) return;
  await db.query(`UPDATE bot_mensajes SET texto = $2 WHERE wa_message_id = $1`, [waId, texto]);
}

/**
 * Guarda un mensaje que salió hacia el cliente (del bot o de un agente).
 * Se engancha en whatsapp.js, por donde pasan TODOS los envíos.
 */
async function registrarSaliente(telefono, { autor = 'bot', agenteId = null, tipo = 'text', texto = null, waId = null, error = null }) {
  if (!db.activa()) return;
  const conv = await db.query(
    `SELECT id FROM bot_conversaciones WHERE telefono = $1 ORDER BY (estado <> 'cerrada') DESC, id DESC LIMIT 1`,
    [telefono]
  );
  const id = conv.rows[0]?.id;
  if (!id) return;
  await db.query(
    `INSERT INTO bot_mensajes (conversacion_id, direccion, autor, agente_id, tipo, texto, wa_message_id, error)
     VALUES ($1, 'saliente', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
    [id, autor, agenteId, tipo, texto, waId, error]
  );
  await db.query(
    `UPDATE bot_conversaciones SET ultimo_mensaje_en = now()${autor === 'agente' ? ', primera_respuesta_humana_en = COALESCE(primera_respuesta_humana_en, now())' : ''} WHERE id = $1`,
    [id]
  );
}

// ---------------------------------------------------------------
// Estado del flujo (sesión) y datos del cliente
// ---------------------------------------------------------------
async function guardarSesion(convId, sesion, { abonado, nombre, localidad, categoria } = {}) {
  if (!db.activa() || !convId) return;
  await db.query(
    `UPDATE bot_conversaciones SET
       sesion = $2,
       abonado = COALESCE($3, abonado),
       cliente_nombre = COALESCE($4, cliente_nombre),
       localidad = COALESCE($5, localidad),
       categoria = COALESCE($6, categoria)
     WHERE id = $1`,
    [convId, sesion ? JSON.stringify(sesion) : null, abonado || null, nombre || null, localidad || null, categoria || null]
  );
}

// ---------------------------------------------------------------
// Transiciones
// ---------------------------------------------------------------
async function transferir(convId, cola, motivo) {
  if (!db.activa() || !convId) return;
  if (!COLAS.includes(cola)) cola = 'servicio_cliente';
  await db.query(
    `UPDATE bot_conversaciones SET
       estado = 'esperando_humano', resultado = 'transferida', cola = $2,
       motivo_transferencia = $3, transferida_en = now(), en_cola_desde = now(), agente_id = NULL
     WHERE id = $1`,
    [convId, cola, motivo]
  );
  await evento(convId, 'transferida', { aCola: cola, nota: motivo, usuario: 'bot' });
}

async function cerrar(convId, resultado, { usuario = 'bot', nota = null, pedirCalificacion = false } = {}) {
  if (!db.activa() || !convId) return;
  await db.query(
    `UPDATE bot_conversaciones SET estado = 'cerrada', resultado = $2, cerrada_en = now(),
            calificacion_pedida_en = CASE WHEN $3 THEN now() ELSE calificacion_pedida_en END,
            sesion = CASE WHEN sesion IS NULL THEN NULL ELSE jsonb_build_object('step', sesion->'step') END
      WHERE id = $1`,
    [convId, resultado, Boolean(pedirCalificacion)]
  );
  await evento(convId, 'cerrada', { nota: nota || resultado, usuario });
}

async function evento(convId, tipo, { deCola = null, aCola = null, deAgente = null, aAgente = null, nota = null, usuario = null } = {}) {
  if (!db.activa() || !convId) return;
  await db.query(
    `INSERT INTO bot_eventos (conversacion_id, tipo, de_cola, a_cola, de_agente, a_agente, nota, usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [convId, tipo, deCola, aCola, deAgente, aAgente, nota, usuario]
  );
}

/**
 * Cierra como "abandonada" las conversaciones que siguen con el bot pero en
 * las que el cliente no escribe hace más de BOT_ABANDONO_MIN minutos.
 * De la sesión solo queda el paso en que se quedó (sin cédula ni datos del cliente).
 */
async function cerrarAbandonadas(minutos = ABANDONO_MIN) {
  if (!db.activa()) return 0;
  const r = await db.query(
    `UPDATE bot_conversaciones SET estado = 'cerrada', resultado = 'abandonada', cerrada_en = now(),
            sesion = CASE WHEN sesion IS NULL THEN NULL ELSE jsonb_build_object('step', sesion->'step') END
     WHERE estado = 'bot' AND COALESCE(ultimo_mensaje_cliente_en, creada_en) < now() - make_interval(mins => $1)
     RETURNING id`,
    [minutos]
  );
  for (const { id } of r.rows) await evento(id, 'cerrada', { nota: 'abandonada', usuario: 'bot' });
  return r.rows.length;
}

// ---------------------------------------------------------------
// Órdenes con SLA vencido (para el tablero programador)
// ---------------------------------------------------------------
async function registrarSlaVencida({ abonado, orden, telefono, localidad }) {
  if (!db.activa() || !orden?.nro_orden) return;
  let convId = null;
  if (telefono) {
    const c = await db.query(
      `SELECT id FROM bot_conversaciones WHERE telefono = $1 AND estado <> 'cerrada' LIMIT 1`,
      [telefono]
    );
    convId = c.rows[0]?.id || null;
  }
  await db.query(
    `INSERT INTO bot_sla_vencidas (nro_orden, abonado, localidad, detalle_orden, fecha_emision, conversacion_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (nro_orden) DO UPDATE SET
       veces = bot_sla_vencidas.veces + 1, ultima_en = now(),
       conversacion_id = COALESCE(EXCLUDED.conversacion_id, bot_sla_vencidas.conversacion_id)`,
    [String(orden.nro_orden), String(abonado), localidad || null, orden.detalle_orden || null, orden.fecha_emision ? String(orden.fecha_emision) : null, convId]
  );
}

// ---------------------------------------------------------------
// Calificación 1-5 (Fase 5)
// ---------------------------------------------------------------
const CALIF_MIN = Number(process.env.BOT_CALIFICACION_MIN || 60); // minutos para responder la calificación

/** Conversación recién cerrada por un asesor que espera calificación (o null). */
async function calificacionPendiente(telefono) {
  if (!db.activa()) return null;
  const r = await db.query(
    `SELECT c.* FROM bot_conversaciones c
      WHERE c.telefono = $1 AND c.estado = 'cerrada' AND c.calificacion IS NULL
        AND c.calificacion_pedida_en > now() - make_interval(mins => $2)
        AND NOT EXISTS (SELECT 1 FROM bot_conversaciones o WHERE o.telefono = $1 AND o.estado <> 'cerrada')
      ORDER BY c.id DESC LIMIT 1`,
    [telefono, CALIF_MIN]
  );
  return r.rows[0] || null;
}

async function calificar(convId, nota) {
  await db.query(`UPDATE bot_conversaciones SET calificacion = $2 WHERE id = $1`, [convId, nota]);
  await evento(convId, 'calificada', { nota: String(nota), usuario: 'cliente' });
}

// ---------------------------------------------------------------
// Retención de datos personales (Ley 1581) — Fase 5
// ---------------------------------------------------------------
// Pasados BOT_RETENCION_MESES (12 por defecto) desde el cierre, se borran los mensajes y las notas,
// y la conversación queda anónima (sin teléfono, nombre, abonado ni sesión). Se conservan solo los
// datos que alimentan las métricas: fechas, estado, resultado, cola, motivo, categoría, localidad,
// asesor y calificación. Corre una vez al día y por lotes, para no cargar la base.
const RETENCION_MESES = Number(process.env.BOT_RETENCION_MESES || 12);

async function aplicarRetencion({ meses = RETENCION_MESES, lote = 500 } = {}) {
  if (!db.activa() || !(meses > 0)) return 0;
  let total = 0;
  for (let i = 0; i < 50; i++) { // máximo 25.000 por corrida
    const ids = (await db.query(
      `SELECT id FROM bot_conversaciones
        WHERE estado = 'cerrada' AND anonimizada_en IS NULL AND cerrada_en < now() - make_interval(months => $1)
        ORDER BY id LIMIT $2`,
      [meses, lote]
    )).rows.map((x) => x.id);
    if (!ids.length) break;
    await db.query(`DELETE FROM bot_mensajes WHERE conversacion_id = ANY($1)`, [ids]);
    await db.query(`UPDATE bot_eventos SET nota = NULL WHERE conversacion_id = ANY($1) AND tipo IN ('nota', 'no_entendido', 'reasignada', 'cerrada', 'devuelta')`, [ids]);
    await db.query(`DELETE FROM bot_eventos WHERE conversacion_id = ANY($1) AND tipo = 'consultada'`, [ids]);
    await db.query(
      `UPDATE bot_conversaciones SET telefono = 'anon-' || id, cliente_nombre = NULL, abonado = NULL, sesion = NULL,
              anonimizada_en = now()
        WHERE id = ANY($1)`,
      [ids]
    );
    total += ids.length;
  }
  await db.query(
    `DELETE FROM bot_sla_vencidas WHERE ultima_en < now() - make_interval(months => $1)`,
    [meses]
  );
  return total;
}

module.exports = {
  calificacionPendiente,
  calificar,
  aplicarRetencion,
  RETENCION_MESES,
  ESTADOS_SILENCIO,
  COLAS,
  ABANDONO_MIN,
  obtenerOCrear,
  registrarEntrante,
  completarEntrante,
  registrarSaliente,
  guardarSesion,
  transferir,
  cerrar,
  evento,
  cerrarAbandonadas,
  registrarSlaVencida,
};
