// wifiCompat.js — lista de compatibilidad de ONUs para el cambio de clave WiFi,
// aprendida de los intentos reales del bot (tabla bot_wifi_intentos).
//
// Regla: el bot intenta el cambio con CUALQUIER modelo. Cada resultado queda
// guardado por modelo (onu_type_name) y banda. Un modelo/banda se da por
// NO compatible cuando acumula WIFI_FALLOS_PARA_DESCARTAR fallos (3 por
// defecto) y ningún éxito: desde ahí el bot ya no lo intenta y lo pasa
// directo a MDA. Si un modelo tiene al menos un éxito, se sigue intentando
// (el fallo pudo ser puntual) y si falla, igual va a MDA.
// Para ver la lista: railway run node scripts/wifi_compat.js

const db = require('./db');

const FALLOS_PARA_DESCARTAR = Number(process.env.WIFI_FALLOS_PARA_DESCARTAR || 3);

async function registrarIntento({ modelo, banda, puerto, modo, abonado, ok, ssidConservado, respuesta }) {
  if (!db.activa()) return;
  try {
    await db.query(
      `INSERT INTO bot_wifi_intentos (modelo, banda, puerto, modo, abonado, ok, ssid_conservado, respuesta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [String(modelo || 'DESCONOCIDO').toUpperCase(), banda, puerto, modo, abonado, ok, ssidConservado, respuesta ? String(respuesta).slice(0, 300) : null]
    );
  } catch (err) {
    console.error('Error guardando intento WiFi:', err.message);
  }
}

/** 'compatible' | 'no_compatible' | 'sin_datos' para un modelo y banda. */
async function estado(modelo, banda) {
  if (!db.activa()) return 'sin_datos';
  try {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE ok) AS exitos, count(*) FILTER (WHERE NOT ok) AS fallos
         FROM bot_wifi_intentos WHERE modelo = $1 AND banda = $2`,
      [String(modelo || 'DESCONOCIDO').toUpperCase(), banda]
    );
    const exitos = Number(rows[0]?.exitos || 0);
    const fallos = Number(rows[0]?.fallos || 0);
    if (exitos > 0) return 'compatible';
    if (FALLOS_PARA_DESCARTAR > 0 && fallos >= FALLOS_PARA_DESCARTAR) return 'no_compatible';
    return 'sin_datos';
  } catch (err) {
    console.error('Error leyendo compatibilidad WiFi:', err.message);
    return 'sin_datos';
  }
}

/** Resumen por modelo y banda, para el script y el portal. */
async function resumen() {
  const { rows } = await db.query(
    `SELECT modelo, banda,
            count(*) FILTER (WHERE ok) AS exitos,
            count(*) FILTER (WHERE NOT ok) AS fallos,
            count(*) FILTER (WHERE ssid_conservado IS FALSE) AS ssid_perdido,
            max(creado_en) AS ultimo,
            (array_agg(respuesta ORDER BY creado_en DESC) FILTER (WHERE NOT ok))[1] AS ultimo_error
       FROM bot_wifi_intentos GROUP BY modelo, banda ORDER BY modelo, banda`
  );
  return rows.map((r) => ({
    ...r,
    estado: Number(r.exitos) > 0 ? 'compatible' : Number(r.fallos) >= FALLOS_PARA_DESCARTAR ? 'no_compatible' : 'en_prueba',
  }));
}

module.exports = { registrarIntento, estado, resumen, FALLOS_PARA_DESCARTAR };
