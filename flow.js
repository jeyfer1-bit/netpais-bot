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
const {
  getOnuSignal,
  translateStatus,
  translateSignal,
  formatLastStatusChange,
} = require('./smartolt');
const {
  classify,
  classifySubIssue,
  buildConfirmationMessage,
  CLARIFYING_MESSAGE,
} = require('./novedad');
const { checkOrdenStatus } = require('./ordenes');

// sessions: Map<numeroDeWhatsapp, sessionObject>
const sessions = new Map();

const STEPS = {
  ASK_IS_CLIENT: 'ASK_IS_CLIENT',
  ASK_ID: 'ASK_ID',
  ASK_REQUIREMENT: 'ASK_REQUIREMENT', // Flujo 3: identificar la novedad
  CONFIRM_NOVEDAD: 'CONFIRM_NOVEDAD', // Flujo 3: confirmar antes de pasar al Flujo 4
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

function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // quita acentos: sí -> si
}

// Se usa \b (límite de palabra) para no confundir "si" dentro de
// "asisti" o "positivo", por ejemplo.
const AFFIRMATIVE_PATTERNS = [
  /\bsi+\b/, // si, sii, siii...
  /\bsip\b/,
  /\bclaro\b/,
  /\bobvio\b/,
  /\bpor supuesto\b/,
  /\bcorrecto\b/,
  /\bexacto\b/,
  /\bafirmativo\b/,
  /\basi es\b/,
  /\beso es\b/,
  /\byes\b/,
  /\byep\b/,
];

const NEGATIVE_PATTERNS = [
  /\bno+\b/, // no, noo...
  /\bnel\b/,
  /\bnop+e?\b/, // nop, nope
  /\bnegativo\b/,
  /\bpara nada\b/,
  /\bque va\b/,
  /\baun no\b/,
  /\btodavia no\b/,
  /\bno soy\b/,
];

function isAffirmative(text) {
  const t = normalize(text);
  return AFFIRMATIVE_PATTERNS.some((pattern) => pattern.test(t));
}

function isNegative(text) {
  const t = normalize(text);
  return NEGATIVE_PATTERNS.some((pattern) => pattern.test(t));
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

      // -------- Flujo 2: Validar abonado SmartOLT --------
      const onu = await getOnuSignal(customer.abonado);
      if (onu) {
        replies.push(
          `¡Listo! Ya validé tu servicio 🙌 Tu conexión está ${translateStatus(onu.status)}, ` +
          `la señal está ${translateSignal(onu.signal)}, ` +
          `y el último cambio fue el ${formatLastStatusChange(onu.lastStatusChange)}.`
        );
      } else {
        replies.push(
          'No pude validar automáticamente el estado de tu conexión en este momento, pero seguimos con tu solicitud.'
        );
      }

      replies.push('¿Qué tipo de novedad presentas?');
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

  // -------- Paso: identificar la novedad (Flujo 3) --------
  if (session.step === STEPS.ASK_REQUIREMENT) {
    const category = classify(text);

    if (!category) {
      replies.push(CLARIFYING_MESSAGE);
      return replies; // se queda en el mismo paso hasta lograr identificarla
    }

    session.novedadCategory = category;
    session.novedadDetalle =
      category === 'novedadconservicio' ? classifySubIssue(text) : null;

    replies.push(buildConfirmationMessage(category, session.novedadDetalle));
    replies.push('¿Es correcto? (sí/no)');
    session.step = STEPS.CONFIRM_NOVEDAD;
    return replies;
  }

  // -------- Paso: confirmar la novedad identificada --------
  if (session.step === STEPS.CONFIRM_NOVEDAD) {
    if (isAffirmative(text)) {
      if (session.novedadCategory === 'orden') {
        try {
          const ordenReplies = await checkOrdenStatus(session.customer.abonado);
          replies.push(...ordenReplies);
        } catch (err) {
          console.error('Error consultando órdenes:', err.message);
          replies.push('No pude consultar el estado de tu orden en este momento. Te voy a comunicar con un asesor. 🙌');
        }
        resetSession(phone);
        return replies;
      }

      replies.push(
        'Perfecto, dame un momento mientras continúo con tu solicitud. 🙌 ' +
        `(Aquí conecta el Flujo 4, según la categoría: ${session.novedadCategory}.)`
      );
      resetSession(phone);
      return replies;
    }

    if (isNegative(text)) {
      replies.push('Ok, cuéntame de nuevo con tus palabras qué necesitas 🙂');
      replies.push(CLARIFYING_MESSAGE);
      session.step = STEPS.ASK_REQUIREMENT;
      return replies;
    }

    replies.push('¿Podrías confirmarme con un *sí* o un *no*, por favor? 🙂');
    return replies;
  }

  // Fallback de seguridad
  resetSession(phone);
  replies.push('Vamos a empezar de nuevo. Escríbeme "Hola" para comenzar. 🙂');
  return replies;
}

module.exports = { handleMessage };
