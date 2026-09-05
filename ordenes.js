// ordenes.js
//
// Consulta el estado de las órdenes de un cliente, llamando a un
// flujo de Power Automate ("Buscar Ordenes netpais-bot") que:
//   1) Filtra la tabla de Órdenes (TablaOrdenes) por nro_abonado
//   2) Devuelve también la tabla completa de Tipificación (es
//      pequeña, se manda entera cada vez)
//
// Columnas reales:
//   Órdenes: nro_orden, nro_abonado, detalle_orden, estatus_orden,
//            grupo_trabajo, fecha_emision, fecha_final, observacion,
//            descripcion, franquicia
//   Tipificación: detalle_orden, Explicación, Prioridad,
//            "Tipo de revisión", Tiempo (ej: "24 horas")

const axios = require('axios');

const OPEN_STATES = ['CREADA', 'IMPRESA'];

// Si el flujo de Power Automate devuelve "ordenes" vacío, reintentamos
// una vez antes de asumir que el cliente de verdad no tiene órdenes.
// Esto protege contra fallas intermitentes del conector de Excel Online
// (índice de tabla no refrescado, co-authoring lock, etc.).
const MAX_ATTEMPTS = 2;
const EMPTY_RESULT_RETRY_DELAY_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callFlow(abonado) {
  const flowUrl = process.env.POWER_AUTOMATE_ORDENES_URL;
  if (!flowUrl) {
    throw new Error('Falta la variable de entorno POWER_AUTOMATE_ORDENES_URL');
  }

  const response = await axios.post(
    flowUrl,
    { abonado: String(abonado).trim() },
    { headers: { 'Content-Type': 'application/json' } }
  );

  return response.data;
}

/**
 * Llama al flujo de Power Automate y devuelve { ordenes, tipificacion }.
 * Reintenta si la primera respuesta viene con "ordenes" vacío, y siempre
 * loguea la respuesta cruda (recortada) para poder diagnosticar en Railway
 * si vuelve a pasar una inconsistencia como la del 2026-09-05.
 */
async function fetchOrdenesYTipificacion(abonado) {
  let data = {};
  let ordenes = [];
  let tipificacion = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    data = await callFlow(abonado);
    ordenes = data?.ordenes || [];
    tipificacion = data?.tipificacion || [];

    console.log(
      `📋 [intento ${attempt}/${MAX_ATTEMPTS}] Consulta de órdenes para ${abonado}: ` +
      `${ordenes.length} orden(es), ${tipificacion.length} fila(s) de tipificación. ` +
      `Respuesta cruda: ${JSON.stringify(data).slice(0, 1000)}`
    );

    if (ordenes.length > 0 || attempt === MAX_ATTEMPTS) {
      break;
    }

    console.warn(
      `⚠️ Órdenes vacías en el intento ${attempt} para ${abonado}; ` +
      `reintentando en ${EMPTY_RESULT_RETRY_DELAY_MS}ms por si fue una falla intermitente del conector.`
    );
    await sleep(EMPTY_RESULT_RETRY_DELAY_MS);
  }

  return { ordenes, tipificacion };
}

function isOpen(orden) {
  return OPEN_STATES.includes(String(orden.estatus_orden).trim().toUpperCase());
}

function findTipificacion(tipificacion, detalleOrden) {
  const target = String(detalleOrden).trim().toLowerCase();
  return tipificacion.find(
    (t) => String(t.detalle_orden).trim().toLowerCase() === target
  );
}

// Convierte "24 horas" -> 24
function parseTiempoHoras(tiempoTexto) {
  const match = String(tiempoTexto).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

// Compara fecha_emision + tiempo (SLA, en horas) contra la hora actual.
function isSlaVencido(fechaEmision, tiempoHoras) {
  const emision = new Date(String(fechaEmision).replace(' ', 'T'));
  if (isNaN(emision.getTime())) return false; // si la fecha no es válida, no arriesgamos falsos positivos
  const limite = new Date(emision.getTime() + tiempoHoras * 60 * 60 * 1000);
  return new Date() > limite;
}

function formatFecha(rawDate) {
  if (!rawDate) return 'sin fecha registrada';
  const date = new Date(String(rawDate).replace(' ', 'T'));
  if (isNaN(date.getTime())) return rawDate;
  return date.toLocaleString('es-CO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// TODO: cuando definamos dónde se guarda, reemplazar este log por el
// registro real (otra hoja de Excel, una tabla, etc.)
function registrarIncumplimientoSLA(abonado, orden) {
  console.log(
    `🚨 SLA vencido — abonado: ${abonado}, orden: ${orden.nro_orden} (${orden.detalle_orden}), fecha: ${new Date().toISOString()}`
  );
}

/**
 * Arma el mensaje que se le debe mostrar al cliente según sus órdenes.
 * @param {string} abonado
 * @returns {Promise<string[]>} mensajes a enviar, en orden
 */
async function checkOrdenStatus(abonado) {
  const { ordenes, tipificacion } = await fetchOrdenesYTipificacion(abonado);
  const replies = [];

  const abiertas = ordenes.filter(isOpen);

  if (abiertas.length === 0) {
    // Buscar la última orden cerrada (la de fecha_final más reciente)
    const cerradas = ordenes
      .filter((o) => o.fecha_final)
      .sort((a, b) => new Date(b.fecha_final) - new Date(a.fecha_final));
    const ultima = cerradas[0];

    if (ultima) {
      replies.push(
        `Revisé tu historial y actualmente no tienes órdenes abiertas. La última que registramos fue "${ultima.detalle_orden}", cerrada el ${formatFecha(ultima.fecha_final)}.`
      );
    } else {
      replies.push('Revisé tu historial y no encontré órdenes registradas en los últimos 3 meses.');
    }
    return replies;
  }

  // Tiene una o varias órdenes abiertas
  if (abiertas.length === 1) {
    replies.push(`Tienes una orden abierta: "${abiertas[0].detalle_orden}".`);
  } else {
    const detalles = abiertas.map((o) => `• ${o.detalle_orden}`).join('\n');
    replies.push(`Tienes ${abiertas.length} órdenes abiertas:\n${detalles}`);
  }

  // Revisar cada orden abierta según su estado
  for (const orden of abiertas) {
    const estado = String(orden.estatus_orden).trim().toUpperCase();
    const tip = findTipificacion(tipificacion, orden.detalle_orden);
    const tiempoHoras = tip ? parseTiempoHoras(tip.Tiempo) : null;

    if (estado === 'CREADA') {
      if (tiempoHoras && isSlaVencido(orden.fecha_emision, tiempoHoras)) {
        replies.push(
          `Tu orden "${orden.detalle_orden}" está por fuera de nuestro tiempo estimado de atención. La vamos a priorizar: será visitada con prioridad 1 en un máximo de 24 horas.`
        );
        registrarIncumplimientoSLA(abonado, orden);
      } else if (tiempoHoras) {
        replies.push(
          `Tu orden "${orden.detalle_orden}" está dentro de nuestro tiempo de atención — será atendida en un tiempo máximo de ${tiempoHoras} horas, según su tipo y prioridad.`
        );
      } else {
        replies.push(
          `Tu orden "${orden.detalle_orden}" está registrada y en proceso; en breve se le asignará un técnico.`
        );
      }
    } else if (estado === 'IMPRESA') {
      const grupo = orden.grupo_trabajo;
      replies.push(
        `Tu orden "${orden.detalle_orden}" ya está asignada a campo${grupo ? ` (técnico: ${grupo})` : ''} y será atendida en un máximo de 24 horas.`
      );
    }
    // DETENIDA POR CORTE: no debería llegar hasta aquí, porque un
    // cliente Cortado ya queda bloqueado antes en el Flujo 1.
  }

  return replies;
}

module.exports = { checkOrdenStatus };
