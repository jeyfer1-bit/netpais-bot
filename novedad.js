// novedad.js
//
// Clasifica, de forma conversacional, qué tipo de novedad presenta
// el cliente entre las 6 categorías definidas. No usa un menú rígido:
// intenta reconocer la intención por palabras clave en lo que el
// cliente escriba con sus propias palabras.

function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function matchesAny(text, keywords) {
  return keywords.some((k) => text.includes(k));
}

const CATEGORY_KEYWORDS = {
  orden: [
    'orden',
    'mantenimiento',
    'tecnico',
    'visita',
    'cuando vienen',
    'cuando llega',
    'cuando me visitan',
    'cita',
    'cuando pasan',
  ],
  tv: [
    'television',
    'televisor',
    'canal',
    'canales',
    'pixela',
    'pixelado',
    'decodificador',
    'se ve mal la tv',
    'señal de tv',
    'senal de tv',
  ],
  sinservicio: [
    'no tengo internet',
    'sin internet',
    'sin servicio',
    'no hay internet',
    'no navega',
    'no hay señal',
    'no hay senal',
    'led rojo',
    'leds rojo',
    'luz roja',
    'luces rojas',
    'fibra rota',
    'fibra cortada',
    'ont danada',
    'ont dañada',
    'no prende',
    'no enciende',
    'no funciona nada',
    'se daño el equipo',
    'se dano el equipo',
  ],
  novedadconservicio: [
    'intermitencia',
    'se corta',
    'se cae',
    'se desconecta',
    'lento',
    'lenta',
    'lentitud',
  ],
  aplicaciones: [
    'no carga',
    'no abre',
    'aplicacion',
    'aplicación',
    'app ',
    'pagina',
    'página',
    'netflix',
    'whatsapp',
    'instagram',
    'facebook',
    'youtube',
    'tiktok',
  ],
  velocidadcontratada: [
    'test de velocidad',
    'no dan las megas',
    'no da la velocidad',
    'no corresponde',
    'megas contratados',
    'megas contratadas',
    'velocidad contratada',
    'no me da la velocidad',
    'speedtest',
  ],
};

const NUMBER_TO_CATEGORY = {
  1: 'orden',
  2: 'novedadconservicio',
  3: 'sinservicio',
  4: 'tv',
  5: 'aplicaciones',
  6: 'velocidadcontratada',
};

/**
 * Intenta clasificar el texto libre del cliente en una de las 6
 * categorías. Devuelve null si no logra identificarla con confianza.
 */
function classify(text) {
  const t = normalize(text);

  const numberMatch = t.match(/^[1-6]$/);
  if (numberMatch) return NUMBER_TO_CATEGORY[Number(numberMatch[0])];

  // Orden y TV se revisan primero porque usan palabras más específicas
  // (evita que "no tengo internet" se confunda, por ejemplo).
  if (matchesAny(t, CATEGORY_KEYWORDS.orden)) return 'orden';
  if (matchesAny(t, CATEGORY_KEYWORDS.tv)) return 'tv';
  if (matchesAny(t, CATEGORY_KEYWORDS.sinservicio)) return 'sinservicio';
  if (matchesAny(t, CATEGORY_KEYWORDS.aplicaciones)) return 'aplicaciones';
  if (matchesAny(t, CATEGORY_KEYWORDS.velocidadcontratada)) return 'velocidadcontratada';
  if (matchesAny(t, CATEGORY_KEYWORDS.novedadconservicio)) return 'novedadconservicio';

  return null;
}

/**
 * Para la categoría "novedadconservicio", identifica cuál de las
 * sub-novedades describe mejor el cliente (para el mensaje de
 * confirmación).
 */
function classifySubIssue(text) {
  const t = normalize(text);

  if (matchesAny(t, ['intermitencia', 'se corta', 'se cae', 'se desconecta'])) {
    return 'intermitencias en tu conexión';
  }
  if (matchesAny(t, ['lento', 'lenta', 'lentitud'])) {
    return 'lentitud en tu conexión';
  }
  return 'tu conexión'; // respaldo genérico si no se identifica el detalle exacto
}

function buildConfirmationMessage(category, detalle) {
  switch (category) {
    case 'orden':
      return '¿Quieres saber el estado actual de tu orden de mantenimiento?';
    case 'novedadconservicio':
      return `Entiendo: actualmente tienes servicio, pero presentas ${detalle}.`;
    case 'sinservicio':
      return 'Entiendo: actualmente no cuentas con servicio de internet, ni por cable ni por wifi.';
    case 'tv':
      return 'Entiendo: tienes novedades con el servicio de televisión.';
    case 'aplicaciones':
      return 'Entiendo: tienes una novedad con una página web o aplicación específica.';
    case 'velocidadcontratada':
      return 'Entiendo: tus test de velocidad no corresponden con las megas que tienes contratadas.';
    default:
      return null;
  }
}

const CLARIFYING_MESSAGE =
  'Cuéntame un poco más para orientarte bien 🙂 ¿Tu caso se trata de...\n\n' +
  '1️⃣ Saber cuándo te visitan por una orden de mantenimiento\n' +
  '2️⃣ Tu servicio está activo, pero con fallas (lento, se corta)\n' +
  '3️⃣ No tienes internet en absoluto (luces en rojo, fibra rota, equipo dañado)\n' +
  '4️⃣ Problemas con el servicio de televisión\n' +
  '5️⃣ Problemas con una página web o aplicación específica (no carga, no abre)\n' +
  '6️⃣ Tu test de velocidad no corresponde con las megas contratadas\n\n' +
  'Puedes responderme con el número, o contarme con tus propias palabras. 🙂';

module.exports = {
  classify,
  classifySubIssue,
  buildConfirmationMessage,
  CLARIFYING_MESSAGE,
};
