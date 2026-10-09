// onuAcciones.js — acciones sobre la ONU de un abonado (bot y tablero de gestión de clientes)
// con bitácora y límite de reinicios.
//
// Bitácora: tabla bot_acciones_onu. Guarda quién (bot o usuario del portal), qué acción,
// sobre qué abonado, cuándo y con qué resultado. NUNCA guarda contraseñas WiFi.
//
// Reinicios: máximo REINICIOS_MAX_24H (2 por defecto) por ONU en 24 horas, contando
// juntos los del bot y los del tablero. Solo cuentan los que SmartOLT confirmó.

const db = require('./db');
const smartolt = require('./smartolt');

const REINICIOS_MAX_24H = Number(process.env.REINICIOS_MAX_24H || 2);

const ACCIONES = ['reiniciar', 'encender_catv', 'clave_wifi', 'pasar_mda'];

function abonadoValido(valor) {
  const a = String(valor || '').trim().toUpperCase();
  return /^(IBA|DOR|PTO|VDR|LP)\d{3,}$/.test(a) ? a : null;
}

async function registrar({ abonado, accion, origen = 'bot', usuario = null, ok, detalle = null }) {
  if (!db.activa()) return;
  try {
    await db.query(
      `INSERT INTO bot_acciones_onu (abonado, accion, origen, usuario, ok, detalle) VALUES ($1, $2, $3, $4, $5, $6)`,
      [String(abonado).toUpperCase(), accion, origen, usuario ? String(usuario).slice(0, 120) : null, Boolean(ok), detalle ? String(detalle).slice(0, 500) : null]
    );
  } catch (err) {
    console.error('Error guardando la bitácora de acciones:', err.message);
  }
}

/** Reinicios confirmados de la ONU en las últimas 24 horas (bot + tablero). */
async function reinicios24h(abonado) {
  if (!db.activa()) return { hechos: 0, max: REINICIOS_MAX_24H, restantes: REINICIOS_MAX_24H, proximoEn: null };
  const { rows } = await db.query(
    `SELECT creado_en FROM bot_acciones_onu
      WHERE abonado = $1 AND accion = 'reiniciar' AND ok AND creado_en > now() - interval '24 hours'
      ORDER BY creado_en`,
    [String(abonado).toUpperCase()]
  );
  const hechos = rows.length;
  const restantes = Math.max(REINICIOS_MAX_24H - hechos, 0);
  // Cuándo se libera el siguiente cupo: 24 h después del reinicio más antiguo que cuenta
  const proximoEn = restantes === 0 && rows[0] ? new Date(new Date(rows[hechos - REINICIOS_MAX_24H].creado_en).getTime() + 24 * 3600 * 1000).toISOString() : null;
  return { hechos, max: REINICIOS_MAX_24H, restantes, proximoEn };
}

/**
 * Reinicia la ONU respetando el límite.
 * @returns {Promise<{ok:boolean, motivo?:'limite'|'fallo', reinicios:object}>}
 */
async function reiniciar(abonado, { origen = 'bot', usuario = null } = {}) {
  const antes = await reinicios24h(abonado);
  if (antes.restantes <= 0) {
    await registrar({ abonado, accion: 'reiniciar', origen, usuario, ok: false, detalle: `Bloqueado: ya tiene ${antes.hechos} reinicios en 24 h` });
    return { ok: false, motivo: 'limite', reinicios: antes };
  }
  let ok = false;
  try {
    ok = await smartolt.rebootOnu(abonado);
  } catch (err) {
    console.error('Error reiniciando ONU:', err.message);
  }
  await registrar({ abonado, accion: 'reiniciar', origen, usuario, ok, detalle: ok ? 'Comando enviado' : 'SmartOLT no confirmó el reinicio' });
  return ok ? { ok: true, reinicios: await reinicios24h(abonado) } : { ok: false, motivo: 'fallo', reinicios: antes };
}

/** Bitácora de un abonado (más reciente primero). */
async function bitacora(abonado, { dias = 90, limite = 200 } = {}) {
  if (!db.activa()) return [];
  const { rows } = await db.query(
    `SELECT id::int AS id, abonado, accion, origen, usuario, ok, detalle, creado_en FROM bot_acciones_onu
      WHERE abonado = $1 AND creado_en > now() - make_interval(days => $2)
      ORDER BY creado_en DESC, id DESC LIMIT $3`,
    [String(abonado).toUpperCase(), dias, limite]
  );
  return rows;
}

module.exports = { ACCIONES, REINICIOS_MAX_24H, abonadoValido, registrar, reinicios24h, reiniciar, bitacora };
