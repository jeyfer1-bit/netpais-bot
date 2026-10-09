// server.js
// Bot de WhatsApp usando la Cloud API oficial de Meta.
//
// Fase 1 del tablero de conversaciones (HANDOFF_bot_conversaciones.md):
//   - Cada mensaje entrante y saliente se guarda en Postgres (conversaciones.js).
//   - La sesión del flujo vive en Postgres: ya no se pierde en cada despliegue.
//   - Cuando el bot transfiere a un humano, la conversación queda en
//     "esperando_humano" y el bot calla: solo registra lo que escriba el cliente.
// Sin DATABASE_URL todo funciona como antes (sesiones en memoria, sin registro).
require('dotenv').config();
const express = require('express');
const flow = require('./flow');
const { sendTextMessage, downloadMedia, setRegistro } = require('./whatsapp');
const { transcribeAudio, describeImage } = require('./ai');
const { setRegistroSla } = require('./ordenes');
const { getCityFromAbonado } = require('./smartolt');
const db = require('./db');
const conv = require('./conversaciones');

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,       // el mismo valor que vas a poner en el panel de Meta
  PORT = 3000,
} = process.env;

// Todo lo que sale por whatsapp.js queda registrado en la conversación
setRegistro((to, datos) => conv.registrarSaliente(to, datos));

// Órdenes con SLA vencido → tabla bot_sla_vencidas (para el tablero programador)
setRegistroSla(({ abonado, orden, telefono }) =>
  conv.registrarSlaVencida({ abonado, orden, telefono, localidad: getCityFromAbonado(abonado) })
);

// ---------------------------------------------------------------
// Fila por número: los mensajes de un mismo cliente se procesan de a
// uno y en orden (si escribe 3 mensajes seguidos, no se pisan la sesión).
// ---------------------------------------------------------------
const filas = new Map();
function enFila(telefono, tarea) {
  const anterior = filas.get(telefono) || Promise.resolve();
  const actual = anterior.catch(() => {}).then(tarea);
  filas.set(telefono, actual);
  actual
    .catch(() => {})
    .finally(() => {
      if (filas.get(telefono) === actual) filas.delete(telefono);
    });
  return actual;
}

// ---------------------------------------------------------------
// 1) Verificación del webhook (Meta llama a este endpoint con GET
//    cuando guardas la configuración en el panel de developers)
// ---------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Falló la verificación del webhook');
  return res.sendStatus(403);
});

// ---------------------------------------------------------------
// 2) Recepción de mensajes entrantes (Meta llama a este endpoint
//    con POST cada vez que un usuario escribe al número)
// ---------------------------------------------------------------
app.post('/webhook', (req, res) => {
  // Responder rápido siempre (Meta espera un 200 en pocos segundos)
  res.sendStatus(200);

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) {
    // Puede ser una actualización de estado (enviado/entregado/leído), no un mensaje nuevo
    return;
  }

  enFila(message.from, () => atender(message)).catch((err) => {
    console.error('Error procesando el mensaje entrante:', err?.response?.data || err.message);
  });
});

const TEXTO_CLAVE_OCULTA = '🔒 [contraseña WiFi oculta]';

async function atender(message) {
  const from = message.from; // número del usuario, ej: "573001234567"
  const type = message.type;
  const waId = message.id || null;
  const textoOriginal = type === 'text' ? message.text?.body ?? '' : null;
  const mediaId = message[type]?.id || null;

  // ------ Registro del mensaje entrante ------
  let c = null; // conversación abierta (null si no hay base de datos o falló)
  if (db.activa()) {
    try {
      // ¿Está respondiendo la calificación de 1 a 5 que se le pidió al cerrar?
      const pend = await conv.calificacionPendiente(from);
      const nota = type === 'text' ? String(textoOriginal).trim().match(/^([1-5])(\s*(⭐|estrellas?))?[.!]?$/i) : null;
      if (pend && nota) {
        const nuevo = await conv.registrarEntrante(pend, { tipo: type, texto: textoOriginal, waId });
        if (!nuevo) return;
        await conv.calificar(pend.id, Number(nota[1]));
        await sendTextMessage(from, '¡Gracias por tu calificación! 🙌 Nos ayuda a mejorar. Si necesitas algo más, escríbenos cuando quieras.');
        return;
      }

      c = await conv.obtenerOCrear(from);
      // En los pasos donde el cliente escribe su contraseña WiFi, el texto no se guarda
      const texto = type === 'text' && flow.esPasoSensible(c.sesion?.step) ? TEXTO_CLAVE_OCULTA : textoOriginal;
      const nuevo = await conv.registrarEntrante(c, { tipo: type, texto, mediaId, waId });
      if (!nuevo) {
        console.log(`↩️ Mensaje repetido de ${from} (${waId}): ya se había procesado`);
        return;
      }

      // #reset (pruebas): cierra la conversación actual y empieza una nueva
      if (type === 'text' && textoOriginal.trim().toLowerCase() === '#reset') {
        await conv.cerrar(c.id, 'reiniciada');
        c = await conv.obtenerOCrear(from);
      }
    } catch (err) {
      console.error('Error registrando la conversación (sigo sin registro):', err.message);
      c = null;
    }
  }

  // ------ Con un humano: el bot calla y solo registra ------
  if (c && conv.ESTADOS_SILENCIO.includes(c.estado)) {
    console.log(`🤫 ${from} está ${c.estado} (cola ${c.cola}): el bot no responde`);
    return;
  }

  // ------ Paso de contraseña WiFi: solo texto, y nunca a los logs ------
  const pasoSensible = flow.esPasoSensible((c ? c.sesion : flow.leerSesion(from))?.step);
  if (pasoSensible && type !== 'text') {
    await sendTextMessage(from, 'Por seguridad, escríbeme la contraseña como texto, no como nota de voz ni imagen 🔐');
    return;
  }

  // ------ Convertir lo que llegó a texto ------
  let textBody = null;

  if (type === 'text') {
    textBody = textoOriginal;
  } else if (type === 'audio') {
    try {
      const { buffer, mimeType } = await downloadMedia(message.audio.id);
      textBody = await transcribeAudio(buffer, mimeType);
    } catch (err) {
      console.error('Error descargando/transcribiendo audio:', err?.response?.data || err.message);
    }

    if (!textBody) {
      await sendTextMessage(from, 'No logré escuchar bien tu nota de voz 🙏 ¿Podrías escribirlo, por favor?');
      return;
    }
    console.log(`🎙️ Transcripción de ${from}: ${textBody}`);
    conv.completarEntrante(waId, textBody).catch(() => {});

    // Confirmamos lo que entendimos ANTES de seguir con el flujo,
    // para que el cliente sepa que su nota de voz sí fue procesada.
    await sendTextMessage(from, `🎙️ Escuché: "${textBody}"`);
  } else if (type === 'image') {
    try {
      const { buffer, mimeType } = await downloadMedia(message.image.id);
      textBody = await describeImage(buffer, mimeType);
    } catch (err) {
      console.error('Error descargando/describiendo imagen:', err?.response?.data || err.message);
    }

    if (!textBody) {
      await sendTextMessage(from, 'No logré interpretar bien la imagen 🙏 ¿Podrías contarme con palabras qué ves?');
      return;
    }
    console.log(`🖼️ Descripción de imagen de ${from}: ${textBody}`);
    conv.completarEntrante(waId, `[imagen] ${textBody}`).catch(() => {});

    // Mismo principio: confirmamos lo que vimos antes de continuar,
    // para que el cliente sepa que su imagen sí fue procesada.
    await sendTextMessage(from, `👀 Esto es lo que veo en tu imagen: ${textBody}`);
  } else {
    await sendTextMessage(from, 'Por ahora puedo leer mensajes de texto, notas de voz e imágenes 🙏');
    return;
  }

  console.log(`📩 Mensaje de ${from} (${type}): ${pasoSensible ? TEXTO_CLAVE_OCULTA : textBody}`);

  // ------ Flujo conversacional (pipeline) ------
  // A partir de aquí, textBody es siempre texto plano (venga de donde
  // venga) — handleMessage nunca sabe si el mensaje original era
  // texto, una nota de voz transcrita, o una imagen descrita.
  if (c) flow.cargarSesion(from, c.sesion); // la sesión vive en Postgres
  const replies = await flow.handleMessage(from, textBody);
  const { accion, eventos } = flow.tomarAcciones(from);

  // ------ Guardar estado ANTES de responder ------
  if (c) {
    try {
      const sesion = flow.leerSesion(from);
      const cliente = sesion?.customer || accion?.cliente || null;
      await conv.guardarSesion(c.id, sesion, {
        abonado: cliente?.abonado,
        nombre: cliente?.nombre,
        localidad: cliente?.abonado ? getCityFromAbonado(cliente.abonado) : null,
        categoria: sesion?.novedadCategory || accion?.categoria,
      });
      for (const e of eventos) await conv.evento(c.id, e.tipo, { nota: e.nota, usuario: 'bot' });
      if (accion?.tipo === 'transferir') {
        await conv.transferir(c.id, accion.cola, accion.motivo);
        console.log(`🙋 ${from} transferido a ${accion.cola} (${accion.motivo})`);
      } else if (accion?.tipo === 'cerrar') {
        await conv.cerrar(c.id, accion.resultado, { pedirCalificacion: accion.pedirCalificacion });
      }
      flow.cargarSesion(from, null); // ya quedó en Postgres; no hace falta en memoria
    } catch (err) {
      console.error('Error guardando la conversación:', err.message);
    }
  }

  for (const reply of replies) {
    await sendTextMessage(from, reply);
  }
}

// ---------------------------------------------------------------
// 3) Envío de mensajes de asesores desde el portal (Fase 3)
// ---------------------------------------------------------------
app.use('/internal', require('./internal').crear());

// ---------------------------------------------------------------
app.get('/', (_req, res) => {
  res.send('Bot de WhatsApp activo ✅');
});

async function arrancar() {
  try {
    await db.migrar();
  } catch (err) {
    console.error('No pude preparar las tablas del bot en Postgres:', err.message);
  }

  // Conversaciones en las que el cliente dejó de responder → "abandonada"
  if (db.activa()) {
    setInterval(() => {
      conv
        .cerrarAbandonadas()
        .then((n) => n && console.log(`🕓 ${n} conversación(es) cerradas por abandono`))
        .catch((err) => console.error('Error cerrando abandonadas:', err.message));
    }, 5 * 60 * 1000).unref();

    // Retención de datos personales: una vez al día (y 1 minuto después de arrancar)
    const retener = () => conv
      .aplicarRetencion()
      .then((n) => n && console.log(`🧹 ${n} conversación(es) anonimizadas por retención (${conv.RETENCION_MESES} meses)`))
      .catch((err) => console.error('Error aplicando retención:', err.message));
    setTimeout(retener, 60 * 1000).unref();
    setInterval(retener, 24 * 60 * 60 * 1000).unref();
  }

  app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
  });
}

if (require.main === module) arrancar();

module.exports = { app, atender, arrancar };
