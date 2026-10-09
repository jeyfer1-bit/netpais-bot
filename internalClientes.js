// internalClientes.js — endpoints internos para el tablero de gestión de clientes
// (módulo /clientes de netpais-reporte). Se montan dentro de /internal, con la misma
// autenticación (X-Bot-Secret) que el resto de endpoints internos.
//
//   GET  /internal/clientes?q=                  busca en SaePlus por abonado o cédula/NIT (mismo flujo del bot)
//   GET  /internal/onu/:abonado                 ficha técnica en vivo + vecinos PON + falla masiva + reinicios
//   GET  /internal/onu/:abonado/grafica         ?tipo=trafico|senal&periodo=hourly|daily|weekly|monthly → PNG
//   GET  /internal/onu/:abonado/bitacora        acciones de los últimos 90 días (bot + tablero)
//   POST /internal/onu/:abonado/reiniciar       { usuario }                      máx. 2 por ONU en 24 h
//   POST /internal/onu/:abonado/encender-catv   { usuario }                      nunca se apaga
//   POST /internal/onu/:abonado/clave-wifi      { usuario, bandas, clave, confirmacion }
//   POST /internal/casos-mda                    { usuario, abonado, nombre?, telefono?, nota }
//
// "usuario" es el usuario del portal que hace la acción: queda en la bitácora.
// La contraseña WiFi solo pasa por la memoria de esta petición: no se guarda ni se loguea.
const smartolt = require('./smartolt');
const onuAcciones = require('./onuAcciones');
const wifiCompat = require('./wifiCompat');
const eventosRed = require('./eventosRed');
const conversaciones = require('./conversaciones');
const db = require('./db');
const { findCustomer, limpiarId } = require('./customerLookup');

// Mismas reglas que el bot (flow.js)
const WIFI_PASSWORD_RE = /^[A-Za-z0-9!@#$%*_\-.+=?]{8,63}$/;
const BANDA_TXT = { '24': '2,4 GHz', '5': '5 GHz' };
const PERIODOS = ['hourly', 'daily', 'weekly', 'monthly'];

const MAX_ACCIONES_MIN = 10; // acciones por usuario por minuto
const MAX_CONSULTAS_MIN = 60; // fichas / gráficas por usuario por minuto

const ventanas = new Map();
function dentroDeTasa(clave, max) {
  const ahora = Date.now();
  const lista = (ventanas.get(clave) || []).filter((t) => ahora - t < 60000);
  if (lista.length >= max) return false;
  lista.push(ahora);
  ventanas.set(clave, lista);
  return true;
}

// Gráficas: SmartOLT las genera cada 5 min; se guardan 3 min para no repetir llamadas
const GRAFICA_TTL_MS = 3 * 60 * 1000;
const graficas = new Map(); // clave → { en, png }

function usuarioDe(req) {
  const u = String(req.body?.usuario || req.get('X-Portal-Usuario') || '').trim();
  return u ? u.slice(0, 120) : null;
}

function normalizarTelefono(valor) {
  const d = String(valor || '').replace(/\D/g, '');
  if (!d) return null;
  if (/^3\d{9}$/.test(d)) return `57${d}`;
  if (/^573\d{9}$/.test(d)) return d;
  return undefined; // inválido
}

function montar(r) {
  // Abonado válido en todas las rutas /onu/:abonado
  r.param('abonado', (req, res, next, valor) => {
    const a = onuAcciones.abonadoValido(valor);
    if (!a) return res.status(400).json({ error: 'Número de abonado inválido.' });
    req.abonado = a;
    next();
  });

  const consulta = (req, res, next) => {
    const u = usuarioDe(req) || 'portal';
    if (!dentroDeTasa(`c:${u}`, MAX_CONSULTAS_MIN)) return res.status(429).json({ error: 'Demasiadas consultas seguidas: espera un momento.' });
    next();
  };
  const accion = (req, res, next) => {
    const u = usuarioDe(req);
    if (!u) return res.status(400).json({ error: 'Falta el usuario del portal que hace la acción.' });
    if (!dentroDeTasa(`a:${u}`, MAX_ACCIONES_MIN)) return res.status(429).json({ error: 'Vas muy rápido: espera un momento antes de otra acción.' });
    req.usuario = u;
    next();
  };

  // ---------- Búsqueda de clientes (abonado o cédula/NIT) ----------
  r.get('/clientes', consulta, async (req, res) => {
    const q = limpiarId(req.query.q);
    if (!q) return res.status(400).json({ error: 'Escribe un número de abonado o de cédula/NIT válido.' });
    try {
      const filas = await findCustomer(q);
      return res.json({
        q,
        clientes: filas.map((c) => ({ abonado: c.abonado, documento: c.documento, nombre: c.nombre, estado: c.estado, barrio: c.barrio, zona: c.zona, franquicia: c.franquicia || null })),
      });
    } catch (err) {
      console.error('Búsqueda de clientes:', err.message);
      return res.status(502).json({ error: 'No pude consultar SaePlus en este momento. Intenta de nuevo.' });
    }
  });

  // ---------- Ficha ----------
  r.get('/onu/:abonado', consulta, async (req, res) => {
    try {
      const a = req.abonado;
      const [ficha, vecinos, evento, reinicios] = await Promise.all([
        smartolt.fichaOnu(a),
        smartolt.vecinosPon(a).catch(() => null),
        eventosRed.eventoParaAbonado(a).catch(() => null),
        onuAcciones.reinicios24h(a),
      ]);
      let wifiCompatibilidad = null;
      if (ficha.encontrada && ficha.modelo) {
        const bandas = ficha.bandasWifi || ['24'];
        wifiCompatibilidad = {};
        for (const b of bandas) wifiCompatibilidad[b] = await wifiCompat.estado(ficha.modelo, b);
      }
      return res.json({
        abonado: a,
        onu: ficha,
        wifiCompatibilidad,
        vecinos,
        eventoRed: evento
          ? { id: evento.id, tipo: evento.tipo, titulo: evento.titulo, zona: evento.zona, afectacion: evento.afectacion, tiempo: evento.tiempo_txt,
              radicado: evento.radicado, abiertoEn: evento.abierto_en, actualizadoEn: evento.actualizado_en,
              mensajes: eventosRed.mensajesCliente(evento, { enLinea: String(ficha.estado || '').toLowerCase() === 'online' }) }
          : null,
        reinicios,
        ahora: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Ficha ONU:', err.message);
      return res.status(500).json({ error: 'No pude consultar SmartOLT en este momento.' });
    }
  });

  // ---------- Gráficas ----------
  r.get('/onu/:abonado/grafica', consulta, async (req, res) => {
    const tipo = req.query.tipo === 'senal' ? 'senal' : req.query.tipo === 'trafico' ? 'trafico' : null;
    const periodo = PERIODOS.includes(String(req.query.periodo)) ? String(req.query.periodo) : null;
    if (!tipo || !periodo) return res.status(400).json({ error: 'tipo (trafico|senal) y periodo (hourly|daily|weekly|monthly) son obligatorios.' });
    const clave = `${req.abonado}:${tipo}:${periodo}`;
    let g = graficas.get(clave);
    if (!g || Date.now() - g.en > GRAFICA_TTL_MS) {
      const png = tipo === 'trafico'
        ? await smartolt.getOnuTrafficGraph(req.abonado, periodo)
        : await smartolt.getOnuSignalGraph(req.abonado, periodo);
      if (!png) return res.status(404).json({ error: 'SmartOLT no tiene esa gráfica todavía.' });
      g = { en: Date.now(), png };
      graficas.set(clave, g);
      if (graficas.size > 500) graficas.delete(graficas.keys().next().value);
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=120');
    return res.send(g.png);
  });

  // ---------- Bitácora ----------
  r.get('/onu/:abonado/bitacora', consulta, async (req, res) => {
    try {
      return res.json({ acciones: await onuAcciones.bitacora(req.abonado) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------- Reiniciar ----------
  r.post('/onu/:abonado/reiniciar', accion, async (req, res) => {
    const r2 = await onuAcciones.reiniciar(req.abonado, { origen: 'tablero', usuario: req.usuario });
    if (r2.ok) return res.json({ ok: true, mensaje: 'Comando de reinicio enviado. El equipo tarda hasta 2 minutos en volver.', reinicios: r2.reinicios });
    if (r2.motivo === 'limite') {
      return res.status(409).json({ ok: false, motivo: 'limite', error: `Esta ONU ya tiene ${r2.reinicios.hechos} reinicios en las últimas 24 horas (máximo ${r2.reinicios.max}). Si sigue fallando, pásala a MDA.`, reinicios: r2.reinicios });
    }
    return res.status(502).json({ ok: false, motivo: 'fallo', error: 'SmartOLT no confirmó el reinicio.', reinicios: r2.reinicios });
  });

  // ---------- Encender CATV (nunca se apaga desde aquí) ----------
  r.post('/onu/:abonado/encender-catv', accion, async (req, res) => {
    const a = req.abonado;
    const estado = await smartolt.getOnuCatvStatus(a).catch(() => null);
    if (estado === 'enabled') {
      await onuAcciones.registrar({ abonado: a, accion: 'encender_catv', origen: 'tablero', usuario: req.usuario, ok: true, detalle: 'Ya estaba encendido' });
      return res.json({ ok: true, yaEncendido: true, mensaje: 'El puerto de TV ya estaba encendido.' });
    }
    if (estado === 'unsupported') {
      await onuAcciones.registrar({ abonado: a, accion: 'encender_catv', origen: 'tablero', usuario: req.usuario, ok: false, detalle: 'La ONU no tiene puerto de TV' });
      return res.status(409).json({ ok: false, error: 'Esta ONU no tiene puerto de TV (CATV).' });
    }
    let ok = false;
    try { ok = await smartolt.enableOnuCatv(a); } catch (err) { console.error('Encender CATV:', err.message); }
    await onuAcciones.registrar({ abonado: a, accion: 'encender_catv', origen: 'tablero', usuario: req.usuario, ok, detalle: ok ? 'Encendido' : `SmartOLT no confirmó (estado previo: ${estado || 'desconocido'})` });
    return ok ? res.json({ ok: true, mensaje: 'Puerto de TV encendido.' }) : res.status(502).json({ ok: false, error: 'SmartOLT no confirmó el encendido del puerto de TV.' });
  });

  // ---------- Cambiar clave WiFi ----------
  r.post('/onu/:abonado/clave-wifi', accion, async (req, res) => {
    const a = req.abonado;
    const clave = String(req.body?.clave ?? '');
    const confirmacion = String(req.body?.confirmacion ?? '');
    let bandas = Array.isArray(req.body?.bandas) ? req.body.bandas.map(String) : [];
    bandas = [...new Set(bandas)].filter((b) => b === '24' || b === '5');
    if (!bandas.length) return res.status(400).json({ error: 'Elige la banda: 2,4 GHz, 5 GHz o ambas.' });
    if (clave !== confirmacion) return res.status(400).json({ error: 'Las dos contraseñas no coinciden.' });
    if (!WIFI_PASSWORD_RE.test(clave)) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 63 caracteres, sin espacios ni tildes ni ñ (letras, números y ! @ # $ % * _ - . + = ?).' });
    }

    const rev = await smartolt.revisarCambioWifi(a);
    if (!rev.ok) {
      const txt = { no_encontrada: 'No encontré la ONU en SmartOLT.', sin_respuesta: 'SmartOLT no respondió.', offline: 'La ONU no está en línea: el cambio solo se puede hacer con el equipo conectado.' }[rev.motivo] || 'No se pudo revisar la ONU.';
      await onuAcciones.registrar({ abonado: a, accion: 'clave_wifi', origen: 'tablero', usuario: req.usuario, ok: false, detalle: txt });
      return res.status(409).json({ ok: false, motivo: rev.motivo, error: txt });
    }
    const disponibles = rev.bandas || ['24'];
    const noDisponible = bandas.find((b) => !disponibles.includes(b));
    if (noDisponible) return res.status(400).json({ error: `Esta ONU no tiene red de ${BANDA_TXT[noDisponible]}.` });

    const resultados = [];
    for (const banda of bandas) {
      // Mismo criterio que el bot: si el modelo/banda ya se descartó, no se intenta
      if ((await wifiCompat.estado(rev.modelo, banda)) === 'no_compatible') {
        resultados.push({ banda, ok: false, noCompatible: true, respuesta: 'Modelo no compatible con el cambio remoto' });
        continue;
      }
      const r2 = await smartolt.cambiarClaveWifi(a, banda, clave, rev.puertos || {});
      resultados.push({ banda, ...r2 });
      await wifiCompat.registrarIntento({ modelo: rev.modelo, banda, puerto: r2.puerto, modo: rev.modo, abonado: a, ok: r2.ok, ssidConservado: r2.ssidConservado, respuesta: r2.respuesta });
    }
    const ok = resultados.every((x) => x.ok);
    await onuAcciones.registrar({
      abonado: a, accion: 'clave_wifi', origen: 'tablero', usuario: req.usuario, ok,
      detalle: `${rev.modelo} — ` + resultados.map((x) => `${BANDA_TXT[x.banda]}: ${x.ok ? 'ok' : 'falló'} (${x.respuesta || 'sin respuesta'})`).join(' | '),
    });
    return res.status(ok ? 200 : 502).json({
      ok,
      modelo: rev.modelo,
      resultados: resultados.map((x) => ({ banda: x.banda, ok: x.ok, noCompatible: Boolean(x.noCompatible), ssidConservado: x.ssidConservado ?? null, respuesta: x.respuesta || null })),
      mensaje: ok ? 'La ONU confirmó el cambio de contraseña.' : 'No se pudo aplicar el cambio en todas las bandas: pasa el caso a MDA.',
    });
  });

  // ---------- Pasar a MDA: caso en la cola MDA del tablero del bot ----------
  r.post('/casos-mda', accion, async (req, res) => {
    const a = onuAcciones.abonadoValido(req.body?.abonado);
    const nota = String(req.body?.nota || '').trim().slice(0, 1000);
    const nombre = String(req.body?.nombre || '').trim().slice(0, 200) || null;
    const tel = normalizarTelefono(req.body?.telefono);
    if (!a) return res.status(400).json({ error: 'Número de abonado inválido.' });
    if (!nota) return res.status(400).json({ error: 'Escribe qué pasa con el cliente para MDA.' });
    if (tel === undefined) return res.status(400).json({ error: 'El celular debe tener 10 dígitos (ej. 3001234567).' });
    const localidad = smartolt.getCityFromAbonado(a);
    // Sin celular, el caso queda con un identificador por abonado: un solo caso abierto por abonado
    const telefono = tel || `caso-${a}`;
    try {
      const abierta = (await db.query(`SELECT * FROM bot_conversaciones WHERE telefono = $1 AND estado <> 'cerrada' LIMIT 1`, [telefono])).rows[0];
      let id;
      let accionTxt;
      if (abierta && ['esperando_humano', 'con_humano'].includes(abierta.estado)) {
        // Ya está con un asesor: se agrega la nota y, si no estaba en MDA, se pasa a MDA
        id = abierta.id;
        if (abierta.cola !== 'mda') {
          await db.query(`UPDATE bot_conversaciones SET estado = 'esperando_humano', cola = 'mda', agente_id = NULL, en_cola_desde = now() WHERE id = $1`, [id]);
          await conversaciones.evento(id, 'reasignada', { deCola: abierta.cola, aCola: 'mda', deAgente: abierta.agente_id, nota: `Desde el tablero de clientes: ${nota}`, usuario: req.usuario });
          accionTxt = 'reasignada';
        } else {
          await conversaciones.evento(id, 'nota', { nota: `Desde el tablero de clientes: ${nota}`, usuario: req.usuario });
          accionTxt = 'nota_agregada';
        }
      } else if (abierta) {
        // Conversación con el bot en curso: se pasa a MDA
        id = abierta.id;
        await db.query(
          `UPDATE bot_conversaciones SET estado = 'esperando_humano', resultado = 'transferida', cola = 'mda', agente_id = NULL,
                  motivo_transferencia = 'tablero_clientes', transferida_en = now(), en_cola_desde = now(),
                  abonado = COALESCE(abonado, $2), cliente_nombre = COALESCE(cliente_nombre, $3), localidad = COALESCE(localidad, $4)
            WHERE id = $1`,
          [id, a, nombre, localidad]
        );
        await conversaciones.evento(id, 'transferida', { aCola: 'mda', nota: `Desde el tablero de clientes: ${nota}`, usuario: req.usuario });
        accionTxt = 'transferida';
      } else {
        const n = await db.query(
          `INSERT INTO bot_conversaciones (telefono, abonado, cliente_nombre, localidad, estado, resultado, cola, motivo_transferencia,
                                           transferida_en, en_cola_desde, origen, creada_por)
           VALUES ($1, $2, $3, $4, 'esperando_humano', 'transferida', 'mda', 'tablero_clientes', now(), now(), 'tablero', $5)
           RETURNING id`,
          [telefono, a, nombre, localidad, req.usuario]
        );
        id = n.rows[0].id;
        await conversaciones.evento(id, 'transferida', { aCola: 'mda', nota: `Caso creado desde el tablero de clientes: ${nota}`, usuario: req.usuario });
        accionTxt = 'creada';
      }
      await onuAcciones.registrar({ abonado: a, accion: 'pasar_mda', origen: 'tablero', usuario: req.usuario, ok: true, detalle: `Caso ${id} (${accionTxt}): ${nota}` });
      return res.json({ ok: true, conversacion_id: Number(id), accion: accionTxt });
    } catch (err) {
      console.error('Caso MDA:', err.message);
      await onuAcciones.registrar({ abonado: a, accion: 'pasar_mda', origen: 'tablero', usuario: req.usuario, ok: false, detalle: err.message });
      return res.status(500).json({ error: 'No pude crear el caso en MDA.' });
    }
  });
}

module.exports = { montar, normalizarTelefono };
