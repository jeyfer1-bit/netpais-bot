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
  rebootOnu,
  getOnuSpeedProfiles,
  getOnuCatvStatus,
  enableOnuCatv,
} = require('./smartolt');
const {
  classify,
  classifySubIssue,
  buildConfirmationMessage,
  CLARIFYING_MESSAGE,
} = require('./novedad');
const { checkOrdenStatus, getTiempoEstimado } = require('./ordenes');

// sessions: Map<numeroDeWhatsapp, sessionObject>
const sessions = new Map();

const STEPS = {
  ASK_IS_CLIENT: 'ASK_IS_CLIENT',
  ASK_ID: 'ASK_ID',
  ASK_REQUIREMENT: 'ASK_REQUIREMENT', // Flujo 3: identificar la novedad
  CONFIRM_NOVEDAD: 'CONFIRM_NOVEDAD', // Flujo 3: confirmar antes de pasar al Flujo 4
  ASK_ANYTHING_ELSE: 'ASK_ANYTHING_ELSE', // Tras resolver la novedad: ¿algo más o cerramos?

  // Flujo 2: intermitencia/lentitud (categoría "novedadconservicio")
  NOV_ASK_LED_COLOR: 'NOV_ASK_LED_COLOR', // sin señal (LOS/Offline): pedir color de LED
  NOV_ASK_SERVICE_OK: 'NOV_ASK_SERVICE_OK', // pedir confirmar si el servicio ya funciona
  NOV_ASK_REBOOT_CONFIRM: 'NOV_ASK_REBOOT_CONFIRM', // pedir autorización para reiniciar
  NOV_WAITING_REBOOT: 'NOV_WAITING_REBOOT', // esperando los 2 minutos post-reinicio
  NOV_ASK_DEVICE_SCOPE: 'NOV_ASK_DEVICE_SCOPE', // ¿todos los dispositivos o uno solo?
  NOV_ASK_TIME_PATTERN: 'NOV_ASK_TIME_PATTERN', // ¿todo el tiempo o franja horaria?
  NOV_ASK_SINGLE_DEVICE_RESULT: 'NOV_ASK_SINGLE_DEVICE_RESULT', // resultado de validaciones en 1 solo equipo

  // Flujo 2: problemas con aplicaciones o páginas web
  NOV_APP_ASK_NAME: 'NOV_APP_ASK_NAME', // ¿qué página/app presenta la novedad?
  NOV_APP_ASK_MOBILE_RESULT: 'NOV_APP_ASK_MOBILE_RESULT', // ¿persiste usando datos móviles?

  // Flujo: velocidad contratada vs. test de velocidad
  NOV_SPEED_ASK_METHOD: 'NOV_SPEED_ASK_METHOD', // ¿test por cable o por wifi?
  NOV_SPEED_ASK_RESULT: 'NOV_SPEED_ASK_RESULT', // esperando el resultado del test

  // Flujo: revisión de televisión
  TV_ASK_SCOPE: 'TV_ASK_SCOPE', // ¿uno/algunos canales o falla total?
  TV_ASK_TIME_PATTERN: 'TV_ASK_TIME_PATTERN', // ¿todo el tiempo o franja horaria?
  TV_ASK_TV_COUNT: 'TV_ASK_TV_COUNT', // ¿todos los televisores o solo uno?
  TV_ASK_SERVICE_OK: 'TV_ASK_SERVICE_OK', // ¿ya hay señal tras encender el CATV?
  TV_ASK_VALIDATION_RESULT: 'TV_ASK_VALIDATION_RESULT', // resultado tras validaciones físicas
};

const SPEED_TEST_TOLERANCE = 0.9; // -10% de tolerancia sobre el plan contratado

const REBOOT_WAIT_MS = 2 * 60 * 1000; // 2 minutos

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

// -------- Clasificadores de texto libre para el Flujo 2 --------

function classifyLedColor(text) {
  const t = normalize(text);
  if (/\bverde/.test(t)) return 'verde';
  if (/\brojo/.test(t)) return 'rojo';
  return null;
}

function classifyDeviceScope(text) {
  const t = normalize(text);
  if (t === '1' || /\btodos\b/.test(t) || /\btodo(s)? los dispositivos\b/.test(t)) return 'todos';
  if (
    t === '2' ||
    /\bsolo uno\b/.test(t) ||
    /\buno solo\b/.test(t) ||
    /\bun (dispositivo|equipo|celular|computador|pc)\b/.test(t) ||
    t === 'uno'
  ) {
    return 'uno';
  }
  return null;
}

function classifyTimePattern(text) {
  const t = normalize(text);
  if (t === '1' || /\btodo el tiempo\b/.test(t) || /\bsiempre\b/.test(t) || /\bconstante/.test(t)) return 'siempre';
  if (
    t === '2' ||
    /\bhorario\b/.test(t) ||
    /\bfranja\b/.test(t) ||
    /\bhoras\b/.test(t) ||
    /\bnoche\b/.test(t) ||
    /\btarde\b/.test(t)
  ) {
    return 'franja';
  }
  return null;
}

function classifyImprovement(text) {
  const t = normalize(text);
  if (/\bmejor/.test(t) || /\bsolucion/.test(t) || isAffirmative(text)) return 'mejoro';
  if (/\bigual\b/.test(t) || /\bsigue\b/.test(t) || /\bpeor\b/.test(t) || isNegative(text)) return 'igual';
  return null;
}

/**
 * Construye el mensaje de "voy a crear una orden de..." incluyendo el
 * tiempo estimado desde Tipificación. No inserta la orden en ningún
 * lado todavía (falta la API de creación) — solo informa al cliente.
 */
async function buildCrearOrdenMessage(abonado, detalleOrden) {
  const tiempo = await getTiempoEstimado(abonado, detalleOrden);
  return (
    `Vamos a crear una orden de visita técnica por "${detalleOrden}"` +
    (tiempo ? `, la cual será atendida en un máximo de ${tiempo}.` : '.')
  );
}

// -------- Incidente conocido: entrega de video de Google/YouTube --------
// Basado en el comunicado oficial de Ufinet 08/2026. Se actualiza el
// mensaje (o se retira este bloque) cuando Google confirme la solución.
const KNOWN_INCIDENT_KEYWORDS = ['youtube', 'google'];

function isKnownVideoIncident(appName) {
  const t = normalize(appName);
  return KNOWN_INCIDENT_KEYWORDS.some((k) => t.includes(k));
}

const KNOWN_INCIDENT_MESSAGE =
  'Tenemos identificada esta situación 🙌 Actualmente hay una afectación en la entrega de contenido de video de Google/YouTube que impacta a varios usuarios en Colombia, especialmente entre las 7 p. m. y las 11 p. m.\n\n' +
  'Esto ocurre porque los servidores de caché de Google en Bogotá llegan a su límite de capacidad en esas horas, y el contenido empieza a traerse desde ciudades más lejanas (Miami, Nueva York, y en algunos casos Brasil o Chile), lo que aumenta la latencia. No es una falla de nuestra red: nuestros enlaces están activos y sin pérdida de paquetes.\n\n' +
  'Ufinet está en seguimiento diario con Google, quien informó que la ampliación de capacidad en Bogotá estaría entrando en operación hacia finales de agosto de 2026.';

// -------- Flujo: velocidad contratada vs. test de velocidad --------

// Extrae el número de Mbps de textos como "50M", "50 Mbps", "50MB", etc.
function parseMbps(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function classifyTestMethod(text) {
  const t = normalize(text);
  if (t === '1' || /\bcable\b/.test(t) || /\bethernet\b/.test(t) || /\bcomputador\b/.test(t) || /\bpc\b/.test(t)) {
    return 'cable';
  }
  if (t === '2' || /\bwifi\b/.test(t) || /\binalambric/.test(t)) {
    return 'wifi';
  }
  return null;
}

/**
 * Interpreta el resultado del test de velocidad que el cliente escribe
 * en texto (se descartó el envío de pantallazo: el cliente siempre
 * escribe el resultado).
 * Devuelve 'positivo' | 'negativo' | null (si no se pudo interpretar).
 */
function classifySpeedTestResult(text, planMbps) {
  const t = normalize(text);

  // Caso 1: el cliente da el valor de bajada explícitamente
  const bajadaMatch = t.match(/baj(ada|a)?\D{0,5}(\d+(?:\.\d+)?)/) || t.match(/(descarga|download)\D{0,5}(\d+(?:\.\d+)?)/);
  if (bajadaMatch && planMbps) {
    const valor = Number(bajadaMatch[2]);
    return valor >= planMbps * SPEED_TEST_TOLERANCE ? 'positivo' : 'negativo';
  }

  // Caso 2: el cliente responde textualmente si dio bien o mal
  if (/\bbien\b|\bnormal\b|\bcorrecto\b|\bok\b/.test(t)) return 'positivo';
  if (/\bmal\b|\bmalo\b|\bincorrecto\b|\bbajo\b|\bpoco\b/.test(t)) return 'negativo';

  return null;
}

// -------- Flujo: revisión de televisión --------

function classifyTvScope(text) {
  const t = normalize(text);
  if (t === '1' || /\bcanal(es)?\b/.test(t) || /\balgunos\b/.test(t)) return 'canales';
  if (t === '2' || /\btotal\b/.test(t) || /\bningun/.test(t) || /\bno veo nada\b/.test(t) || /\btodos los canales\b/.test(t)) {
    return 'total';
  }
  return null;
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

    if (estado === 'por instalar') {
      replies.push(`Tu servicio está: *${customer.estado}* 🛠️`);
      replies.push('Voy a revisar el estado de tu orden de instalación...');
      try {
        const ordenReplies = await checkOrdenStatus(customer.abonado);
        replies.push(...ordenReplies);
      } catch (err) {
        console.error('Error consultando órdenes:', err.message);
        replies.push('No pude consultar el estado de tu orden en este momento. Te voy a comunicar con un asesor. 🙌');
        resetSession(phone);
        return replies;
      }
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
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
          resetSession(phone);
          return replies;
        }
        replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
        session.step = STEPS.ASK_ANYTHING_ELSE;
        return replies;
      }

      if (session.novedadCategory === 'aplicaciones') {
        replies.push('Cuéntame, ¿qué página web o aplicación te está presentando la novedad?');
        session.step = STEPS.NOV_APP_ASK_NAME;
        return replies;
      }

      if (session.novedadCategory === 'velocidadcontratada') {
        const speedProfile = await getOnuSpeedProfiles(session.customer.abonado);

        if (!speedProfile) {
          replies.push('No pude consultar tu plan contratado en este momento. Te voy a comunicar con un asesor. 🙌');
          resetSession(phone);
          return replies;
        }

        const planMbps = parseMbps(speedProfile.downloadProfile);
        session.novPlanMbps = planMbps;

        replies.push(
          `Actualmente vemos que tienes contratado un plan de ${planMbps ? `${planMbps} Mbps` : speedProfile.downloadProfile}.\n\n` +
          'Para que el test de velocidad sea confiable, ten en cuenta esto:\n\n' +
          '1️⃣ Lo ideal es hacer la prueba desde un computador conectado por cable ethernet, para garantizar que el equipo (celular, tablet, etc.) no tenga limitaciones en su tarjeta de red.\n' +
          '2️⃣ Si no cuentas con un computador, también podemos hacerla por WiFi, conectado a la red de 5GHz.\n\n' +
          '¿Con cuál opción vas a realizar el test de velocidad?'
        );
        session.step = STEPS.NOV_SPEED_ASK_METHOD;
        return replies;
      }

      if (session.novedadCategory === 'novedadconservicio') {
        const onu = await getOnuSignal(session.customer.abonado);

        if (!onu) {
          replies.push(
            'No pude validar automáticamente el estado de tu conexión en este momento. Te voy a comunicar con un asesor. 🙌'
          );
          resetSession(phone);
          return replies;
        }

        const status = String(onu.status).toLowerCase();
        const signal = String(onu.signal).toLowerCase();

        // Caso 1: alerta de señal (warning/critical)
        if (signal === 'warning' || signal === 'critical') {
          replies.push(
            'Actualmente el nivel de potencia de la señal que llega por fibra óptica no es el adecuado.'
          );
          replies.push(await buildCrearOrdenMessage(session.customer.abonado, 'POTENCIAS BAJAS/FUERA DE RANGO'));
          replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
          session.step = STEPS.ASK_ANYTHING_ELSE;
          return replies;
        }

        // Caso 2: sin señal (offline / LOS / power fail)
        if (status !== 'online') {
          replies.push(
            'Vamos a hacer unas validaciones rápidas:\n\n' +
            '1️⃣ Verifica que el módem esté conectado a la corriente y que sus luces LED estén encendidas.\n' +
            '2️⃣ Revisa la fibra de color negro que entra a tu hogar y llega hasta una cajita blanca.\n' +
            '3️⃣ Revisa el patch cord amarillo que sale de esa caja y va hasta el módem por debajo.\n\n' +
            'Cuéntame, ¿de qué color están los LED del módem?'
          );
          session.step = STEPS.NOV_ASK_LED_COLOR;
          return replies;
        }

        // Caso 3: señal "very good", sin alertas
        replies.push(
          'Para orientar mejor el diagnóstico, cuéntame: ¿el problema se presenta...\n\n' +
          '1️⃣ En todos tus dispositivos\n' +
          '2️⃣ Solo en uno'
        );
        session.step = STEPS.NOV_ASK_DEVICE_SCOPE;
        return replies;
      }

      if (session.novedadCategory === 'tv') {
        replies.push(
          '¿La falla es en uno o algunos canales, o es una falla total del servicio de televisión (no ves ningún canal)?\n\n' +
          '1️⃣ Uno o algunos canales\n' +
          '2️⃣ Falla total (no hay señal en ningún canal)'
        );
        session.step = STEPS.TV_ASK_SCOPE;
        return replies;
      }

      replies.push(
        'Perfecto, dame un momento mientras continúo con tu solicitud. 🙌 ' +
        `(Aquí conecta el Flujo 4, según la categoría: ${session.novedadCategory}.)`
      );
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
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

  // -------- Flujo 2: color de LED (caso "sin señal") --------
  if (session.step === STEPS.NOV_ASK_LED_COLOR) {
    const led = classifyLedColor(text);

    if (led === 'rojo') {
      replies.push('Entiendo, esto indica una falla en la fibra óptica que llega hasta tu hogar.');
      replies.push(await buildCrearOrdenMessage(session.customer.abonado, 'SIN SERVICIO CORTE DE FIBRA ÓPTICA'));
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    if (led === 'verde') {
      const onu = await getOnuSignal(session.customer.abonado);
      const isOk = onu && String(onu.status).toLowerCase() === 'online' && String(onu.signal).toLowerCase() === 'very good';
      session.novPendingOrder = 'SIN SERVICIO CONFIGURACIÓN ONT';

      if (isOk) {
        replies.push(
          'Perfecto, técnicamente el equipo ya se ve en línea con buena señal. Por favor verifica el servicio en tus dispositivos y cuéntame: ¿ya te está funcionando? (sí/no)'
        );
        session.novAlreadyRebooted = false;
        session.step = STEPS.NOV_ASK_SERVICE_OK;
        return replies;
      }

      replies.push(
        'Sigo detectando la falla desde nuestro sistema. Vamos a intentar un reinicio remoto del equipo para tratar de resincronizarlo, ¿estás de acuerdo? (sí/no)'
      );
      session.step = STEPS.NOV_ASK_REBOOT_CONFIRM;
      return replies;
    }

    replies.push('No logré identificar el color 🙏 ¿Podrías confirmarme de qué color están los LED del módem (verde o rojo)?');
    return replies;
  }

  // -------- Flujo 2: ¿el servicio ya funciona? --------
  if (session.step === STEPS.NOV_ASK_SERVICE_OK) {
    if (isAffirmative(text)) {
      replies.push('¡Excelente! Me alegra que ya esté funcionando. 🙌');
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    if (isNegative(text)) {
      if (session.novAlreadyRebooted) {
        replies.push('Entiendo.');
        replies.push(await buildCrearOrdenMessage(session.customer.abonado, session.novPendingOrder));
        replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
        session.step = STEPS.ASK_ANYTHING_ELSE;
        return replies;
      }

      replies.push(
        'Entiendo, vamos a intentar un reinicio remoto del equipo para tratar de resincronizarlo, ¿estás de acuerdo? (sí/no)'
      );
      session.step = STEPS.NOV_ASK_REBOOT_CONFIRM;
      return replies;
    }

    replies.push('¿Podrías confirmarme con un *sí* o un *no*? ¿Ya te está funcionando el servicio?');
    return replies;
  }

  // -------- Flujo 2: autorización para reiniciar el equipo --------
  if (session.step === STEPS.NOV_ASK_REBOOT_CONFIRM) {
    if (isAffirmative(text)) {
      let success = false;
      try {
        success = await rebootOnu(session.customer.abonado);
      } catch (err) {
        console.error('Error reiniciando ONU:', err.message);
      }

      if (!success) {
        replies.push('No pude enviar el comando de reinicio al equipo en este momento. Te voy a comunicar con un asesor. 🙌');
        resetSession(phone);
        return replies;
      }

      replies.push('Listo, envié el comando de reinicio. 🔄 Por favor espera un máximo de 2 minutos mientras el equipo vuelve a sincronizar.');
      session.novRebootAt = Date.now();
      session.novAlreadyRebooted = true;
      session.step = STEPS.NOV_WAITING_REBOOT;
      return replies;
    }

    if (isNegative(text)) {
      replies.push('Entiendo, sin problema.');
      replies.push(await buildCrearOrdenMessage(session.customer.abonado, session.novPendingOrder));
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    replies.push('¿Podrías confirmarme con un *sí* o un *no*? ¿Estás de acuerdo con que reinicie el equipo de forma remota?');
    return replies;
  }

  // -------- Flujo 2: esperando los 2 minutos post-reinicio --------
  if (session.step === STEPS.NOV_WAITING_REBOOT) {
    const elapsed = Date.now() - (session.novRebootAt || 0);

    if (elapsed < REBOOT_WAIT_MS) {
      replies.push(
        'Espera un poco más 🙏 El equipo todavía está terminando de sincronizar (hasta 2 minutos en total desde el reinicio). En cuanto pase ese tiempo, verificamos de nuevo.'
      );
      return replies;
    }

    // Ya pasaron los 2 minutos: revalidamos técnicamente (queda en el log)
    // y le pedimos al cliente que confirme desde su experiencia real.
    try {
      const onu = await getOnuSignal(session.customer.abonado);
      console.log(
        `🔁 Post-reinicio (${session.customer.abonado}): status=${onu?.status}, signal=${onu?.signal}`
      );
    } catch (err) {
      console.warn('No pude revalidar SmartOLT post-reinicio:', err.message);
    }

    replies.push('Listo, ya pasó el tiempo de espera. Por favor verifica el servicio en tus dispositivos y cuéntame: ¿ya te está funcionando? (sí/no)');
    session.step = STEPS.NOV_ASK_SERVICE_OK;
    return replies;
  }

  // -------- Flujo 2: ¿en todos los dispositivos o en uno solo? --------
  if (session.step === STEPS.NOV_ASK_DEVICE_SCOPE) {
    const scope = classifyDeviceScope(text);

    if (!scope) {
      replies.push(
        '¿Podrías indicarme con el número, por favor?\n\n' +
        '1️⃣ Todos los dispositivos\n' +
        '2️⃣ Solo uno'
      );
      return replies;
    }

    session.novDeviceScope = scope;
    replies.push(
      'Entendido. ¿Y esto ocurre...\n\n' +
      '1️⃣ Todo el tiempo\n' +
      '2️⃣ Solo en un horario específico (por ejemplo, en la noche)'
    );
    session.step = STEPS.NOV_ASK_TIME_PATTERN;
    return replies;
  }

  // -------- Flujo 2: ¿todo el tiempo o en una franja horaria? --------
  if (session.step === STEPS.NOV_ASK_TIME_PATTERN) {
    const pattern = classifyTimePattern(text);

    if (!pattern) {
      replies.push(
        '¿Podrías indicarme con el número, por favor?\n\n' +
        '1️⃣ Todo el tiempo\n' +
        '2️⃣ Solo en un horario específico'
      );
      return replies;
    }

    if (pattern === 'franja') {
      replies.push(
        'Es posible que estemos presentando saturación en horas pico, entre las 7 p. m. y las 10 p. m. Vamos a escalar tu caso con el equipo de ingeniería para darte una solución lo antes posible.'
      );
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    // pattern === 'siempre'
    session.novPendingOrder = 'INTERMITENCIA/LENTITUD INTERNET';

    if (session.novDeviceScope === 'todos') {
      replies.push(
        'Entendido, vamos a intentar un reinicio remoto del equipo para tratar de resincronizarlo, ¿estás de acuerdo? (sí/no)'
      );
      session.step = STEPS.NOV_ASK_REBOOT_CONFIRM;
      return replies;
    }

    // scope === 'uno'
    replies.push(
      'Vamos a hacer unas validaciones:\n\n' +
      '1️⃣ Conéctate a la red de 5GHz si tu módem la tiene.\n' +
      '2️⃣ Realiza una prueba de velocidad cerca del módem.\n' +
      '3️⃣ Haz una prueba de navegación o reproducción de un video.\n\n' +
      'Cuéntame cómo te fue: ¿mejoró o sigue igual?'
    );
    session.step = STEPS.NOV_ASK_SINGLE_DEVICE_RESULT;
    return replies;
  }

  // -------- Flujo 2: resultado de las validaciones en un solo equipo --------
  if (session.step === STEPS.NOV_ASK_SINGLE_DEVICE_RESULT) {
    const result = classifyImprovement(text);

    if (result === 'mejoro') {
      replies.push('¡Excelente! Me alegra que haya mejorado. 🙌');
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    if (result === 'igual') {
      replies.push(await buildCrearOrdenMessage(session.customer.abonado, session.novPendingOrder));
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    replies.push('Cuéntame, ¿mejoró la conexión en ese dispositivo o sigue igual?');
    return replies;
  }

  // -------- Flujo TV: ¿canales específicos o falla total? --------
  if (session.step === STEPS.TV_ASK_SCOPE) {
    const scope = classifyTvScope(text);

    if (!scope) {
      replies.push('¿Podrías confirmarme con el número? 1️⃣ Uno o algunos canales, 2️⃣ Falla total.');
      return replies;
    }

    if (scope === 'canales') {
      replies.push(
        'La mayoría de estas fallas se deben a la transmisión de origen de las casas programadoras, o a interferencias satelitales. Lo bueno es que suelen ser temporales y se resuelven en minutos.\n\n' +
        'Para darte un mejor diagnóstico, cuéntame: ¿la falla ocurre...\n\n' +
        '1️⃣ Todo el tiempo\n' +
        '2️⃣ Solo en un horario específico'
      );
      session.step = STEPS.TV_ASK_TIME_PATTERN;
      return replies;
    }

    // scope === 'total'
    const catvStatus = await getOnuCatvStatus(session.customer.abonado);

    if (!catvStatus) {
      replies.push('No pude validar automáticamente el estado del servicio de televisión en este momento. Te voy a comunicar con un asesor. 🙌');
      resetSession(phone);
      return replies;
    }

    if (catvStatus === 'unsupported') {
      replies.push('El equipo asociado a tu servicio no es compatible con TV por este medio. Te voy a comunicar con un asesor para revisar tu caso. 🙌');
      resetSession(phone);
      return replies;
    }

    if (catvStatus === 'disabled') {
      replies.push('Veo que el puerto de televisión está apagado en tu módem. Voy a proceder a encenderlo. 🔄');

      let success = false;
      try {
        success = await enableOnuCatv(session.customer.abonado);
      } catch (err) {
        console.error('Error encendiendo CATV:', err.message);
      }

      if (!success) {
        replies.push('No pude encender el puerto de televisión en este momento. Te voy a comunicar con un asesor. 🙌');
        resetSession(phone);
        return replies;
      }

      replies.push('Listo, el puerto de televisión fue encendido. Por favor revisa si ya tienes señal de TV. ¿Ya te funciona? (sí/no)');
      session.novTvPendingOrder = 'SIN SERVICIO DE TV';
      session.novTvSolutionType = 'visita';
      session.step = STEPS.TV_ASK_SERVICE_OK;
      return replies;
    }

    // catvStatus === 'enabled'
    replies.push(
      'Confirmo que veo el servicio de televisión habilitado sin novedades desde nuestro sistema.\n\n' +
      'Por favor realiza estas validaciones:\n\n' +
      '1️⃣ Revisa las conexiones físicas del televisor que falla (cable coaxial conectado, conector bien ajustado, sin cables ni fisuras visibles).\n' +
      '2️⃣ Intenta resintonizar los canales nuevamente.\n\n' +
      '¿Cómo te fue? ¿Se solucionó o sigue igual?'
    );
    session.novTvPendingOrder = 'SIN SERVICIO DE TV';
    session.novTvSolutionType = 'visita';
    session.step = STEPS.TV_ASK_VALIDATION_RESULT;
    return replies;
  }

  // -------- Flujo TV: ¿todo el tiempo o en una franja horaria? --------
  if (session.step === STEPS.TV_ASK_TIME_PATTERN) {
    const pattern = classifyTimePattern(text);

    if (!pattern) {
      replies.push('¿Podrías indicarme con el número? 1️⃣ Todo el tiempo, 2️⃣ Solo en un horario específico.');
      return replies;
    }

    if (pattern === 'franja') {
      session.novTvPendingOrder = 'INTERMITENCIA/LENTITUD TELEVISIÓN';
      session.novTvSolutionType = 'remota';
      replies.push(await buildCrearOrdenMessage(session.customer.abonado, session.novTvPendingOrder));
      replies.push('Para este tipo de casos, nuestro equipo de ingeniería suele dar una solución de forma remota.');
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    // pattern === 'siempre'
    replies.push(
      '¿Y si tienes varios televisores, esto ocurre en...\n\n' +
      '1️⃣ Todos los televisores\n' +
      '2️⃣ Solo en uno'
    );
    session.step = STEPS.TV_ASK_TV_COUNT;
    return replies;
  }

  // -------- Flujo TV: ¿todos los televisores o solo uno? --------
  if (session.step === STEPS.TV_ASK_TV_COUNT) {
    const scope = classifyDeviceScope(text); // reutilizamos el clasificador todos/uno

    if (!scope) {
      replies.push('¿Podrías indicarme con el número? 1️⃣ Todos los televisores, 2️⃣ Solo uno.');
      return replies;
    }

    session.novTvPendingOrder = 'INTERMITENCIA/LENTITUD TELEVISIÓN';
    session.novTvSolutionType = 'remota';

    if (scope === 'todos') {
      replies.push(await buildCrearOrdenMessage(session.customer.abonado, session.novTvPendingOrder));
      replies.push('Para este tipo de casos, nuestro equipo de ingeniería suele dar una solución de forma remota.');
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    // scope === 'uno'
    replies.push(
      'Por favor realiza estas validaciones:\n\n' +
      '1️⃣ Revisa las conexiones físicas del televisor que falla (cable coaxial conectado, conector bien ajustado, sin cables ni fisuras visibles).\n' +
      '2️⃣ Intenta resintonizar los canales nuevamente.\n\n' +
      '¿Cómo te fue? ¿Se solucionó o sigue igual?'
    );
    session.step = STEPS.TV_ASK_VALIDATION_RESULT;
    return replies;
  }

  // -------- Flujo TV: ¿ya hay señal tras encender el puerto CATV? --------
  if (session.step === STEPS.TV_ASK_SERVICE_OK) {
    if (isAffirmative(text)) {
      replies.push('¡Excelente! Me alegra que ya tengas señal de televisión. 🙌');
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    if (isNegative(text)) {
      replies.push(
        'Entiendo. Por favor realiza estas validaciones:\n\n' +
        '1️⃣ Revisa las conexiones físicas del televisor que falla (cable coaxial conectado, conector bien ajustado, sin cables ni fisuras visibles).\n' +
        '2️⃣ Intenta resintonizar los canales nuevamente.\n\n' +
        '¿Cómo te fue? ¿Se solucionó o sigue igual?'
      );
      session.step = STEPS.TV_ASK_VALIDATION_RESULT;
      return replies;
    }

    replies.push('¿Podrías confirmarme con un *sí* o un *no*? ¿Ya tienes señal de televisión?');
    return replies;
  }

  // -------- Flujo TV: resultado tras validaciones físicas --------
  if (session.step === STEPS.TV_ASK_VALIDATION_RESULT) {
    const result = classifyImprovement(text);

    if (result === 'mejoro') {
      replies.push('¡Excelente! Me alegra que se haya solucionado. 🙌');
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    if (result === 'igual') {
      replies.push(await buildCrearOrdenMessage(session.customer.abonado, session.novTvPendingOrder));
      if (session.novTvSolutionType === 'remota') {
        replies.push('Para este tipo de casos, nuestro equipo de ingeniería suele dar una solución de forma remota.');
      } else {
        replies.push(
          'Este caso podría estar relacionado con un daño físico (puerto de televisión del módem o cableado coaxial), por lo que se atenderá con visita técnica.'
        );
      }
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    replies.push('Cuéntame, ¿la falla se solucionó o sigue igual?');
    return replies;
  }

  // -------- Flujo velocidad: ¿por cable o por wifi? --------
  if (session.step === STEPS.NOV_SPEED_ASK_METHOD) {
    const method = classifyTestMethod(text);

    if (!method) {
      replies.push('¿Podrías confirmarme si el test lo vas a hacer 1️⃣ por cable (computador) o 2️⃣ por WiFi?');
      return replies;
    }

    session.novSpeedMethod = method;

    if (method === 'cable') {
      replies.push(
        'Perfecto, realiza la prueba de velocidad desde tu computador conectado por cable ethernet. Cuando termines, escríbeme el resultado (ej: "bajada 45 Mbps, subida 10 Mbps"). 📶'
      );
    } else {
      replies.push(
        'Perfecto, asegúrate de estar conectado a la red de 5GHz y ubícate cerca del módem para evitar interferencias. Realiza la prueba y escríbeme el resultado (ej: "bajada 45 Mbps, subida 10 Mbps"). 📶'
      );
    }
    session.step = STEPS.NOV_SPEED_ASK_RESULT;
    return replies;
  }

  // -------- Flujo velocidad: resultado del test --------
  if (session.step === STEPS.NOV_SPEED_ASK_RESULT) {
    const result = classifySpeedTestResult(text, session.novPlanMbps);

    if (!result) {
      replies.push(
        'Cuéntame el resultado de tu test de velocidad — puedes decirme si dio bien o mal, o el valor de bajada en Mbps (ej: "bajada 45 Mbps").'
      );
      return replies;
    }

    if (result === 'positivo') {
      replies.push(
        'Recuerda que puede haber una variación de hasta -10% por temas de interferencias o consumo de ancho de banda de apps en segundo plano, y aun así se considera un resultado satisfactorio. Con base en eso, tu resultado está dentro de lo esperado. 🙌'
      );
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    // result === 'negativo'
    if (session.novSpeedMethod === 'wifi') {
      replies.push(
        'Entiendo. Como la prueba se hizo por WiFi, te recomiendo repetirla desde un computador conectado por cable ethernet apenas puedas — eso nos da un resultado más confiable. Cuando la tengas, escríbenos de nuevo y te acompañamos otra vez con gusto. 🙌'
      );
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    // method === 'cable' y resultado negativo
    replies.push(await buildCrearOrdenMessage(session.customer.abonado, 'INTERMITENCIA/LENTITUD INTERNET'));
    replies.push('Nuestro equipo de ingeniería revisará tu caso para darte una solución lo antes posible.');
    replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
    session.step = STEPS.ASK_ANYTHING_ELSE;
    return replies;
  }

  // -------- Flujo 2: nombre de la página/app con novedad --------
  if (session.step === STEPS.NOV_APP_ASK_NAME) {
    const appName = text.trim();
    session.novAppName = appName;

    if (isKnownVideoIncident(appName)) {
      replies.push(KNOWN_INCIDENT_MESSAGE);
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    replies.push(
      `Vamos a hacer una validación con "${appName}":\n\n` +
      '1️⃣ Desconéctate del WiFi y conéctate por datos móviles.\n' +
      '2️⃣ Intenta ingresar nuevamente.\n\n' +
      '¿El problema persiste usando datos móviles? (sí/no)'
    );
    session.step = STEPS.NOV_APP_ASK_MOBILE_RESULT;
    return replies;
  }

  // -------- Flujo 2: resultado de la prueba con datos móviles --------
  if (session.step === STEPS.NOV_APP_ASK_MOBILE_RESULT) {
    if (isAffirmative(text)) {
      replies.push(
        `Entiendo. Como el problema persiste incluso usando datos móviles (una red distinta a la nuestra), esto indica que la falla está del lado del servidor de "${session.novAppName}" y no de nuestra red.`
      );
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    if (isNegative(text)) {
      replies.push(`Lamento la situación con "${session.novAppName}".`);
      replies.push(await buildCrearOrdenMessage(session.customer.abonado, 'BLOQUEO DE PÁGINAS'));
      replies.push('¿Hay algo más en lo que pueda ayudarte? (sí/no)');
      session.step = STEPS.ASK_ANYTHING_ELSE;
      return replies;
    }

    replies.push('¿Podrías confirmarme con un *sí* o un *no*? ¿El problema persiste usando datos móviles?');
    return replies;
  }

  // -------- Paso: ¿necesita algo más tras consultar la orden? --------
  if (session.step === STEPS.ASK_ANYTHING_ELSE) {
    if (isAffirmative(text)) {
      // Vuelve directo a pedir la novedad, sin repetir la identificación
      // del cliente ni ninguna otra validación: session.customer ya está guardado.
      replies.push('Claro, cuéntame. ¿Qué tipo de novedad presentas?');
      session.novedadCategory = null;
      session.novedadDetalle = null;
      session.novPendingOrder = null;
      session.novDeviceScope = null;
      session.novAlreadyRebooted = false;
      session.novRebootAt = null;
      session.novAppName = null;
      session.novPlanMbps = null;
      session.novSpeedMethod = null;
      session.novTvPendingOrder = null;
      session.novTvSolutionType = null;
      session.step = STEPS.ASK_REQUIREMENT;
      return replies;
    }

    if (isNegative(text)) {
      replies.push(
        'Perfecto, procedo a cerrar el chat. Gracias por contactarte con netpaís 🙌 Si necesitas algo más, escríbenos de nuevo cuando quieras. 👋'
      );
      resetSession(phone); // solo deja la sesión lista para una nueva interacción; no la inicia
      return replies;
    }

    replies.push('¿Podrías confirmarme con un *sí* o un *no*? ¿Hay algo más en lo que pueda ayudarte?');
    return replies;
  }

  // Fallback de seguridad
  resetSession(phone);
  replies.push('Vamos a empezar de nuevo. Escríbeme "Hola" para comenzar. 🙂');
  return replies;
}

module.exports = { handleMessage };
