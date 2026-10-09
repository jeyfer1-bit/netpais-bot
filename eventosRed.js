// eventosRed.js — fallas masivas y ventanas de mantenimiento informadas por MDA.
//
// Origen: los correos de MDA ("Falla Masiva: … | Ciudad | Zona | netpais",
// "Ventana de Mantenimiento: Olt 1,Board 3 Puerto 2 | Ibague | …").
// Un flujo de Power Automate los reenvía a POST /internal/eventos-red con el
// HTML del cuerpo y los adjuntos (Excel con los clientes afectados).
//
// Reglas acordadas:
//   - Afectados: abonados del Excel adjunto; si no hay listado y el asunto trae
//     OLT/board/puerto, todos los clientes de ese puerto PON (según SmartOLT).
//   - Cierre: un correo de la misma cadena (RE:) que diga "Finalizada" /
//     solucionado; si no llega, el evento se vence solo a las 48 h sin novedades.
//   - Si el correo no trae tiempo estimado ("Por determinar"), al cliente se le
//     sugiere validar de nuevo en 4 horas.

const XLSX = require('xlsx');
const db = require('./db');
const { ubicacionOnu } = require('./smartolt');

const VENCE_HORAS = 48;
const HORAS_POR_DEFECTO = 4;
// El Excel de MDA (exportado de SmartOLT) trae celdas como
// "VDR007930 - 88234143 - PASTOR ORTIZ ACUNA": se busca el abonado DENTRO de cada celda.
const ABONADO_EN_TEXTO_RE = /\b(IBA|DOR|PTO|VDR|LP)\d{3,}\b/gi;

const CIUDADES = {
  ibague: 'Ibagué',
  ladorada: 'La Dorada',
  puertosalgar: 'Puerto Salgar',
  villadelrosario: 'Villa del Rosario',
  lospatios: 'Los Patios',
};

function sinTildes(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function claveAsunto(asunto) {
  return sinTildes(asunto)
    .replace(/^\s*((re|rv|fw|fwd|reenviar|reenviado)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** HTML del correo → texto con celdas separadas por " ¦ " y filas por salto de línea. */
function htmlATexto(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(td|th)>/gi, ' ¦ ')
    .replace(/<(br|\/p|\/div|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

function campo(texto, etiqueta) {
  const m = texto.match(new RegExp(`${etiqueta}\\s*:?\\s*¦\\s*([^¦]+?)\\s*¦`, 'i'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** "4 horas" → 4 · "90 minutos" → 1.5 · "Por determinar" → null */
function horasDe(txt) {
  const t = sinTildes(txt).toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(h|hora|horas|hr|hrs|min|minutos?)\b/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return m[2].startsWith('min') ? n / 60 : n;
}

function abonadosDeAdjuntos(adjuntos = []) {
  const encontrados = new Set();
  for (const a of adjuntos) {
    if (!a || !a.contenido || !/\.(xlsx|xls|csv)$/i.test(a.nombre || '')) continue;
    try {
      const libro = XLSX.read(Buffer.from(a.contenido, 'base64'), { type: 'buffer' });
      for (const hoja of libro.SheetNames) {
        const filas = XLSX.utils.sheet_to_json(libro.Sheets[hoja], { header: 1, raw: false });
        for (const fila of filas) {
          for (const celda of fila || []) {
            for (const m of String(celda || '').toUpperCase().matchAll(ABONADO_EN_TEXTO_RE)) encontrados.add(m[0]);
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ No pude leer el adjunto ${a.nombre}:`, err.message);
    }
  }
  return [...encontrados];
}

/** Interpreta un correo de MDA. Devuelve null si no es de falla masiva / ventana. */
function interpretarCorreo({ asunto, cuerpo, adjuntos }) {
  const clave = claveAsunto(asunto);
  const a = clave;
  let tipo = null;
  if (/falla\s+masiva/.test(a)) tipo = 'falla_masiva';
  else if (/ventana|mantenimiento|arreglo de red|trabajo programado|trabajos en red/.test(a)) tipo = 'ventana';
  if (!tipo) return null;

  const partes = String(asunto || '').replace(/^\s*((re|rv|fw|fwd)\s*:\s*)+/i, '').split('|').map((p) => p.trim());
  const detalle = (partes[0] || '').replace(/^[^:]*:\s*/, '').trim();
  const ciudadKey = Object.keys(CIUDADES).find((k) => sinTildes(partes[1] || '').toLowerCase().replace(/\s+/g, '') === k) || null;
  const zona = partes[2] || null;

  const texto = htmlATexto(cuerpo);
  const tiempoTxt = campo(texto, 'Tiempo estimado de evento') || campo(texto, 'Tiempo estimado');
  const afectacion = campo(texto, 'Afectaci[oó]n');
  const fechaTxt = campo(texto, 'Fecha');
  const descM = texto.match(/Descripci[oó]n\s*:?\s*¦([\s\S]*?)(EVIDENCIAS|$)/i);
  const descripcion = descM ? descM[1].replace(/¦/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500) : null;
  const radicado = (texto.match(/radicado\s*:?\s*([A-Z]{2,3}\d{3,})/i) || [])[1] || null;
  const usuarios = Number((texto.match(/(\d+)\s+usuarios?\s+afectad/i) || [])[1]) || null;

  const pon = sinTildes(a).match(/olt\s*(\d+)\s*,?\s*board\s*(\d+)\s*,?\s*(?:puerto|port|pon)\s*(\d+)/i);
  const finalizada =
    /finaliz/i.test(tiempoTxt || '') ||
    /se finaliza|finalizad[oa]|solucionad[oa]|restablecid[oa]|se cierra|cerrad[oa]/i.test(sinTildes(descripcion || ''));

  return {
    clave,
    tipo,
    titulo: detalle,
    ciudad: ciudadKey,
    zona,
    olt: pon ? Number(pon[1]) : null,
    board: pon ? Number(pon[2]) : null,
    puerto: pon ? Number(pon[3]) : null,
    afectacion,
    tiempoTxt,
    horas: horasDe(tiempoTxt),
    fechaTxt,
    descripcion,
    radicado: radicado ? radicado.toUpperCase() : null,
    usuarios,
    abonados: abonadosDeAdjuntos(adjuntos),
    finalizada,
  };
}

/** Guarda / actualiza / cierra el evento. Devuelve { accion, evento }. */
async function registrarCorreo(payload) {
  const ev = interpretarCorreo(payload);
  if (!ev) return { accion: 'ignorado' };

  const { rows } = await db.query(`SELECT * FROM bot_eventos_red WHERE clave = $1`, [ev.clave]);
  const previo = rows[0];
  if (previo && payload.id && previo.ultimo_correo_id === payload.id) return { accion: 'repetido', evento: previo };

  if (!previo) {
    if (ev.finalizada) return { accion: 'ignorado_ya_finalizado' };
    const r = await db.query(
      `INSERT INTO bot_eventos_red (clave, tipo, titulo, ciudad, zona, olt, board, puerto, afectacion, tiempo_txt,
         horas_estimadas, fecha_txt, descripcion, radicado, usuarios, abonados, ultimo_correo_id, asunto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [ev.clave, ev.tipo, ev.titulo, ev.ciudad, ev.zona, ev.olt, ev.board, ev.puerto, ev.afectacion, ev.tiempoTxt,
        ev.horas, ev.fechaTxt, ev.descripcion, ev.radicado, ev.usuarios, ev.abonados, payload.id || null, payload.asunto || null]
    );
    return { accion: 'abierto', evento: r.rows[0] };
  }

  // Actualización de la misma cadena (RE:): suma abonados, actualiza tiempo, o cierra
  const r = await db.query(
    `UPDATE bot_eventos_red SET
        afectacion = COALESCE($2, afectacion),
        tiempo_txt = COALESCE($3, tiempo_txt),
        horas_estimadas = COALESCE($4, horas_estimadas),
        descripcion = COALESCE($5, descripcion),
        radicado = COALESCE($6, radicado),
        usuarios = COALESCE($7, usuarios),
        abonados = $8::text[],
        estado = CASE WHEN $9 THEN 'cerrado' ELSE 'abierto' END,
        cerrado_en = CASE WHEN $9 THEN now() ELSE NULL END,
        actualizado_en = now(),
        ultimo_correo_id = $10
      WHERE clave = $1 RETURNING *`,
    [ev.clave, ev.afectacion, ev.finalizada ? null : ev.tiempoTxt, ev.horas, ev.descripcion, ev.radicado, ev.usuarios,
      [...new Set([...(previo.abonados || []), ...ev.abonados])], ev.finalizada, payload.id || null]
  );
  return { accion: ev.finalizada ? 'cerrado' : 'actualizado', evento: r.rows[0] };
}

/** Evento abierto que afecta a este abonado, o null. */
async function eventoParaAbonado(abonado) {
  if (!db.activa() || !abonado) return null;
  const ab = String(abonado).toUpperCase();
  try {
    const { rows } = await db.query(
      `SELECT * FROM bot_eventos_red
        WHERE estado = 'abierto' AND actualizado_en > now() - ($1 || ' hours')::interval
        ORDER BY actualizado_en DESC`,
      [String(VENCE_HORAS)]
    );
    if (rows.length === 0) return null;

    const porListado = rows.find((e) => (e.abonados || []).includes(ab));
    if (porListado) return porListado;

    const porPuerto = rows.filter((e) => e.olt != null && e.board != null && e.puerto != null && (!e.abonados || e.abonados.length === 0));
    if (porPuerto.length === 0) return null;
    const onu = await ubicacionOnu(ab);
    if (!onu) return null;
    return (
      porPuerto.find(
        (e) =>
          (!e.ciudad || e.ciudad === onu.city) &&
          Number(e.board) === Number(onu.board) &&
          Number(e.puerto) === Number(onu.port) &&
          new RegExp(`\\bolt\\s*0*${e.olt}\\b`, 'i').test(sinTildes(onu.oltName))
      ) || null
    );
  } catch (err) {
    console.error('Error buscando falla masiva para el abonado:', err.message);
    return null;
  }
}

function afectacionTxt(af) {
  const t = sinTildes(af).toLowerCase();
  const internet = /internet/.test(t);
  const tv = /\btv\b|television/.test(t);
  if (internet && tv) return 'internet y televisión';
  if (tv) return 'televisión';
  return 'internet';
}

function horasTxt(h) {
  if (h < 1) return `${Math.round(h * 60)} minutos`;
  return h === 1 ? '1 hora' : `${Number.isInteger(h) ? h : h.toFixed(1)} horas`;
}

/**
 * Mensajes para el cliente afectado.
 * @param {object} ev - fila de bot_eventos_red
 * @param {{ enLinea?: boolean }} [opts] - si la ONU del cliente se ve en línea ahora,
 *   el aviso no afirma que su servicio esté caído (evita contradecir el estado que se acaba de mostrar)
 */
function mensajesCliente(ev, { enLinea = false } = {}) {
  const ciudad = CIUDADES[ev.ciudad] ? ` de ${CIUDADES[ev.ciudad]}` : '';
  const servicio = afectacionTxt(ev.afectacion);
  const msgs = [];
  if (enLinea) {
    msgs.push(
      `${ev.tipo === 'falla_masiva' ? `⚠️ Estamos atendiendo una falla masiva en tu sector${ciudad}` : `🛠️ Estamos haciendo un mantenimiento en la red de tu sector${ciudad}`}` +
        `${ev.radicado ? ` (radicado *${ev.radicado}*)` : ''}. Por ahora tu equipo se ve en línea; si estás presentando fallas en el servicio de ${servicio}, pueden estar relacionadas con este trabajo.`
    );
  } else if (ev.tipo === 'falla_masiva') {
    msgs.push(
      `⚠️ En este momento tenemos una falla masiva en tu sector${ciudad} que afecta el servicio de ${servicio}. ` +
        `Nuestro equipo técnico ya está trabajando en la solución${ev.radicado ? ` (radicado *${ev.radicado}*)` : ''}.`
    );
  } else {
    msgs.push(
      `🛠️ En este momento estamos haciendo un mantenimiento en la red de tu sector${ciudad}, que puede afectar el servicio de ${servicio}. ` +
        'Nuestro equipo técnico está trabajando para dejarlo funcionando lo antes posible.'
    );
  }
  // El tiempo del correo cuenta desde que MDA lo envió (o desde su última actualización)
  const cierre = ' Si después sigue la falla, escríbenos y lo revisamos.';
  if (ev.horas_estimadas) {
    const fin = new Date(ev.actualizado_en).getTime() + Number(ev.horas_estimadas) * 3600000;
    const restanteH = (fin - Date.now()) / 3600000;
    if (restanteH > 0.25) {
      const hora = new Date(fin).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Bogota' });
      msgs.push(`El tiempo estimado de solución es de unas ${horasTxt(Math.ceil(restanteH * 2) / 2)} más (hacia las ${hora}). Te sugerimos validar tu servicio de nuevo a esa hora.${cierre}`);
    } else {
      msgs.push(`Según el último reporte, el trabajo ya debería estar terminando. Te sugerimos validar tu servicio de nuevo en 1 hora.${cierre}`);
    }
  } else {
    msgs.push(`Aún no tenemos un tiempo estimado de solución. Te sugerimos validar tu servicio de nuevo en unas ${HORAS_POR_DEFECTO} horas.${cierre}`);
  }
  msgs.push(
    ev.tipo === 'falla_masiva'
      ? '¿La novedad que presentas está relacionada con esta falla? (sí/no)'
      : '¿La novedad que presentas está relacionada con este mantenimiento? (sí/no)'
  );
  return msgs;
}

async function listarAbiertos() {
  const { rows } = await db.query(
    `SELECT id, tipo, titulo, ciudad, zona, olt, board, puerto, afectacion, tiempo_txt, radicado, usuarios,
            coalesce(array_length(abonados, 1), 0) AS n_abonados, abierto_en, actualizado_en
       FROM bot_eventos_red
      WHERE estado = 'abierto' AND actualizado_en > now() - ($1 || ' hours')::interval
      ORDER BY actualizado_en DESC`,
    [String(VENCE_HORAS)]
  );
  return rows;
}

module.exports = { interpretarCorreo, registrarCorreo, eventoParaAbonado, mensajesCliente, listarAbiertos, claveAsunto };
