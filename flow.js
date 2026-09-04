// flow.js
//
// Aquí vive la lógica de la conversación, organizada como un "pipeline"
// de pasos. Cada usuario (identificado por su número de WhatsApp) tiene
// una "sesión" que recuerda en qué paso del flujo está.
//
// NOTA sobre persistencia: estas sesiones viven en memoria (un Map).
// Eso significa que si el servidor se reinicia (por ejemplo, al
// desplegar un cambio en Railway), todas las conversaciones en curso
// se pierden y el cliente tendría que empezar de nuevo. Para producción
// real conviene guardar esto en una base de datos, pero para el flujo
// actual esto es suficiente.

const { findCustomer } = require('./customerLookup');

// sessions: Map<numeroDeWhatsapp, sessionObject>
const sessions = new Map();

const STEPS = {
  ASK_IS_CLIENT: 'ASK_IS_CLIENT',
  ASK_ID: 'ASK_ID',
  ASK_REQUIREMENT: 'ASK_REQUIREMENT', // punto de entrada al Flujo 2 (aún no construido)
};

const MAX_ID_ATTEMPTS = 3;

function getOrCreateSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      step: null,
      idAttempts: 0,
      customer: null,
    });
  }
  return sessions.get(phone);
}

function resetSession(phone) {
  sessions.delete(phone);
}

function isAffirmative(text) {
  const t = text.trim().toLowerCase();
  return ['si', 'sí', 'claro', 'correcto', 'exacto', 'sip', 'afirmativo'].some(
    (word) => t === word || t.startsWith(word + ' ')
  );
}

function isNegative(text) {
  const t = text.trim().toLowerCase();
  return ['no', 'nel', 'negativo', 'no soy'].some(
    (word) => t === word || t.startsWith(word + ' ')
  );
}

/**
 * Procesa un mensaje entrante y devuelve el/los mensaje(s) de respuesta.
 * @param {string} phone - número de WhatsApp del cliente
 * @param {string} text - texto que escribió
 * @returns {Promise<string[]>} lista de mensajes a enviar, en orden
 */
const RESET_WORDS = ['#reset'];

async function handleMessage(phone, text) {
  const t = text.trim().toLowerCase();

  // -------- Palabra clave de reinicio: funciona en cualquier paso --------
  if (RESET_WORDS.includes(t)) {
    resetSession(phone);
    // getOrCreateSession vuelve a crear la sesión desde cero abajo
  }

  const session = getOrCreateSession(phone);
  const replies = [];

  // -------- Primer contacto: saludo + inicio del flujo --------
  if (session.step === null) {
    replies.push(
      '¡Hola! 👋 Bienvenido/a a *netpaís*. Soy tu asistente virtual y estoy aquí para ayudarte con tu servicio de internet.'
    );
    replies.push('Para comenzar, cuéntame: ¿ya eres cliente de netpaís?');
    session.step = STEPS.ASK_IS_CLIENT;
    return replies;
  }

  // -------- Paso: ¿ya eres cliente? --------
  if (session.step === STEPS.ASK_IS_CLIENT) {
    if (isAffirmative(text)) {
      replies.push(
        'Perfecto 😊 Para ubicarte en el sistema, por favor escríbeme tu número de *cédula* o tu número de *abonado*.'
      );
      session.step = STEPS.ASK_ID;
      return replies;
    }
    if (isNegative(text)) {
      replies.push(
        'Entiendo. Te voy a comunicar con uno de nuestros asesores para que te ayude a conocer nuestros planes. 🙌'
      );
      resetSession(phone);
      return replies;
    }
    replies.push('Perdón, no entendí 🙏 ¿Podrías responder con *sí* o *no*? ¿Ya eres cliente de netpaís?');
    return replies;
  }

  // -------- Paso: pedir cédula/abonado y buscar en Excel --------
  if (session.step === STEPS.ASK_ID) {
    const customer = await findCustomer(text);

    if (!customer) {
      session.idAttempts += 1;

      if (session.idAttempts >= MAX_ID_ATTEMPTS) {
        replies.push(
          'No logré encontrar tu información después de varios intentos. Te voy a comunicar con un asesor para que te ayude directamente. 🙌'
        );
        resetSession(phone);
        return replies;
      }

      const restantes = MAX_ID_ATTEMPTS - session.idAttempts;
      replies.push(
        `No encontré ningún cliente con ese dato 🤔 Por favor revisa el documento e inténtalo de nuevo. Te quedan ${restantes} intento(s).`
      );
      return replies;
    }

    // Cliente encontrado
    session.customer = customer;
    session.idAttempts = 0;
    replies.push(`¡Listo, ${customer.nombre}! 🙌 Ya te ubiqué en el sistema.`);

    const estado = customer.estado.toLowerCase();

    if (estado === 'activo') {
      replies.push(`Tu servicio está: *${customer.estado}* ✅`);
      replies.push('¿Qué tipo de requerimiento necesitas hoy?');
      session.step = STEPS.ASK_REQUIREMENT;
      return replies;
    }

    if (estado === 'cortado') {
      replies.push(`Tu servicio está: *${customer.estado}* ⚠️`);
      replies.push(
        'Para poder brindarte soporte técnico, primero necesitas ponerte al día con tu pago. Una vez lo hagas, escríbenos de nuevo y con gusto te ayudamos.'
      );
      resetSession(phone);
      return replies;
    }

    if (estado === 'retirado' || estado === 'retirado m') {
      replies.push(`Tu servicio figura como: *${customer.estado}*.`);
      replies.push('Te voy a comunicar con un asesor para que revise tu caso. 🙌');
      resetSession(phone);
      return replies;
    }

    // Estado no contemplado explícitamente
    replies.push(`Tu servicio está: *${customer.estado}*.`);
    replies.push('Te voy a comunicar con un asesor para revisar tu caso. 🙌');
    resetSession(phone);
    return replies;
  }

  // -------- Paso: tipo de requerimiento (Flujo 2, pendiente de construir) --------
  if (session.step === STEPS.ASK_REQUIREMENT) {
    replies.push(
      `Anotado: "${text}". (Este es el punto donde va a conectar el Flujo 2 — diagnóstico con SmartOLT y/o creación de ticket.)`
    );
    resetSession(phone);
    return replies;
  }

  // Fallback de seguridad
  resetSession(phone);
  replies.push('Vamos a empezar de nuevo. Escríbeme "Hola" para comenzar. 🙂');
  return replies;
}

module.exports = { handleMessage };
