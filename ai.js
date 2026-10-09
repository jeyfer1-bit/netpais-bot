// ai.js
//
// Capa de IA (Google Gemini) para el bot. Su único trabajo es CONVERTIR
// entradas no textuales a texto plano (audio → transcripción, imagen →
// descripción) y, como respaldo, ayudar a clasificar una novedad cuando
// el matching de palabras clave de novedad.js no logra identificarla.
//
// Principio de diseño: la IA nunca decide el flujo de la conversación.
// Todo lo que sale de aquí es texto que entra a handleMessage() exactamente
// igual que si el cliente lo hubiera escrito — flow.js nunca se entera de
// si el mensaje original era texto, audio o imagen.
//
// Si Gemini falla o no está configurado, las funciones devuelven null en
// vez de lanzar una excepción que tumbe la conversación; quien las llama
// decide el mensaje de respaldo ("no logré escuchar/ver eso, escríbelo").

const axios = require('axios');

const { GEMINI_API_KEY } = process.env;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const NOVEDAD_CATEGORIES = [
  'orden',
  'novedadconservicio',
  'sinservicio',
  'tv',
  'aplicaciones',
  'velocidadcontratada',
  'clavewifi',
];

/**
 * Llama a Gemini con las "parts" dadas (texto y/o datos binarios en base64)
 * y devuelve el texto de la respuesta, o null si algo falla.
 */
async function callGemini(parts, { maxOutputTokens = 1024, thinkingLevel = 'low' } = {}) {
  if (!GEMINI_API_KEY) {
    console.warn('⚠️  Falta GEMINI_API_KEY — no se puede llamar a Gemini.');
    return null;
  }

  try {
    const response = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts }],
        // Gemini 3.x razona antes de responder y ese razonamiento gasta del
        // mismo límite de tokens: con límites bajos (antes 20) la respuesta
        // llegaba vacía y el bot caía al menú. Razonamiento bajo + margen amplio.
        generationConfig: { maxOutputTokens, temperature: 0.2, thinkingConfig: { thinkingLevel } },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    // Los modelos con razonamiento pueden traer varias "parts" (algunas son
    // pensamiento): se une solo el texto de respuesta.
    const cand = response.data?.candidates?.[0];
    const text = (cand?.content?.parts || [])
      .filter((p) => p && typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    if (!text) {
      console.warn(`⚠️  Gemini respondió sin texto (finishReason=${cand?.finishReason || 'N/D'})`);
      return null;
    }
    return text;
  } catch (err) {
    console.warn('⚠️  Error llamando a Gemini:', err?.response?.data || err.message);
    return null;
  }
}

/**
 * Transcribe una nota de voz a texto en español.
 * @param {Buffer} buffer - bytes del audio (ej: ogg/opus, como manda WhatsApp)
 * @param {string} mimeType - ej: 'audio/ogg'
 * @returns {Promise<string|null>}
 */
async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  const parts = [
    {
      text:
        'Transcribe exactamente lo que dice esta nota de voz de un cliente de un bot de soporte técnico de internet en Colombia. ' +
        'Responde ÚNICAMENTE con la transcripción en español, sin comillas, sin comentarios ni explicaciones adicionales.',
    },
    { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
  ];

  return callGemini(parts);
}

/**
 * Describe una imagen enviada por el cliente, en función de lo que se le
 * estaba preguntando (ej: color de LEDs, estado de un cable, un pantallazo).
 * @param {Buffer} buffer - bytes de la imagen
 * @param {string} mimeType - ej: 'image/jpeg'
 * @param {string} [contextHint] - qué se le estaba preguntando al cliente
 * @returns {Promise<string|null>}
 */
async function describeImage(buffer, mimeType = 'image/jpeg', contextHint = '') {
  const parts = [
    {
      text:
        'Un cliente de un bot de soporte técnico de internet en Colombia envió esta imagen durante una conversación de soporte. ' +
        (contextHint ? `En ese momento se le estaba preguntando: "${contextHint}". ` : '') +
        'Sigue estas reglas ESTRICTAMENTE:\n\n' +
        '1. Si la imagen es un pantallazo de una prueba de velocidad (speedtest u otra app similar, con un velocímetro o valores de descarga/subida), responde ÚNICAMENTE con esta línea, sin nada más, reemplazando X e Y por los números que veas (usa PUNTO como separador decimal, nunca coma, y no incluyas unidades de miles):\n' +
        '   Bajada: X Mbps, Subida: Y Mbps\n' +
        '2. Si es una foto de un módem/router, describe en una frase corta los colores de los LEDs encendidos y el estado de los cables/conectores.\n' +
        '3. Si hay cualquier otro texto, número o mensaje de error visible en pantalla y no aplica lo anterior, transcríbelo tal cual.\n\n' +
        'No agregues comentarios, explicaciones, ni texto adicional fuera de lo pedido en la regla que aplique.',
    },
    { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
  ];

  return callGemini(parts);
}

/**
 * Clasifica la novedad que el cliente describe con sus palabras. Es el
 * primer intento para texto libre (antes de las palabras clave de
 * novedad.js); si falla o no está segura, flow.js cae a las palabras
 * clave y, por último, al menú.
 * @param {string} text
 * @returns {Promise<{categoria:string, detalle:string|null}|null>}
 *   detalle (solo novedadconservicio): intermitencia | lentitud | ambas | general
 */
async function classifyNovedadWithAI(text) {
  const parts = [
    {
      text:
        'Eres el clasificador de un bot de soporte de un proveedor de internet y TV por fibra óptica en Colombia. ' +
        'Los clientes escriben informal, con errores de ortografía, sin tildes o con jerga.\n\n' +
        `Mensaje del cliente: «${String(text).slice(0, 500)}»\n\n` +
        'Categorías:\n' +
        '- orden: pregunta por una orden, visita técnica, técnico, cita o instalación ya solicitada ("cuándo vienen", "me dijeron que venían", "sigo esperando al técnico")\n' +
        '- novedadconservicio: tiene internet pero falla: lento, se cae, se corta, intermitente, se desconecta, el wifi no alcanza o es débil en una zona de la casa\n' +
        '- sinservicio: no tiene nada de internet: no navega, luz roja o LOS en el módem, fibra rota, módem apagado o dañado\n' +
        '- tv: problemas con la televisión: canales, sin señal de TV, pixelado, decodificador\n' +
        '- aplicaciones: una página o app puntual no abre o no carga, pero lo demás sí funciona (Netflix, YouTube, juegos, bancos)\n' +
        '- velocidadcontratada: el test de velocidad no da las megas contratadas ("pago 300 y me llegan 80")\n' +
        '- clavewifi: quiere cambiar la contraseña o clave del WiFi, u olvidó la clave\n\n' +
        'Responde en UNA sola línea con el formato categoria|detalle, sin nada más:\n' +
        '- detalle solo aplica a novedadconservicio: intermitencia, lentitud, ambas o general. En las demás categorías escribe -\n' +
        '- Si el mensaje no describe ninguna de estas situaciones (un saludo, otra pregunta, algo administrativo o de pagos), responde: ninguna|-\n\n' +
        'Ejemplos:\n' +
        '"el internet se me va a cada rato" -> novedadconservicio|intermitencia\n' +
        '"esta re lento todo" -> novedadconservicio|lentitud\n' +
        '"no tengo internet desde ayer y el aparato tiene una luz roja" -> sinservicio|-\n' +
        '"quiero saber cuando vienen a arreglar" -> orden|-\n' +
        '"netflix no carga pero lo demas si" -> aplicaciones|-\n' +
        '"se me olvido la clave del wifi" -> clavewifi|-\n' +
        '"quiero pagar la factura" -> ninguna|-',
    },
  ];

  // Margen amplio de tokens: los modelos con razonamiento gastan parte en
  // "pensar" y con un límite bajo devuelven la respuesta vacía.
  const result = await callGemini(parts, { maxOutputTokens: 1024 });
  if (!result) return null;

  const linea = result.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const [catRaw, detRaw] = linea.toLowerCase().replace(/[`*"']/g, '').split('|');
  const categoria = (catRaw || '').replace(/[^a-z]/g, '');
  const detalle = (detRaw || '').replace(/[^a-z]/g, '');
  console.log(`🤖 IA clasificó "${String(text).slice(0, 80)}" → ${linea}`);
  if (!NOVEDAD_CATEGORIES.includes(categoria)) return null;
  return {
    categoria,
    detalle: categoria === 'novedadconservicio' && ['intermitencia', 'lentitud', 'ambas', 'general'].includes(detalle) ? detalle : null,
  };
}


/**
 * Reescribe un mensaje del bot para que suene más cálido y cercano —
 * SIN cambiar ningún dato. Esta es la única función de "Nivel 2"
 * (redacción) del bot: la IA nunca decide qué decir, solo puede
 * cambiar CÓMO se dice.
 *
 * Blindaje obligatorio: se le exigen frases textuales que DEBEN
 * aparecer tal cual en la reescritura (ej: el nombre exacto de una
 * orden, un tiempo de atención, un valor en Mbps). Si al verificar
 * falta alguna, se descarta la reescritura y se devuelve el mensaje
 * original — nunca se arriesga a que la IA "olvide" o cambie un dato.
 *
 * @param {string} message - mensaje original, ya con todos los datos correctos
 * @param {string[]} criticalPhrases - frases que deben sobrevivir tal cual
 * @returns {Promise<string>} el mensaje reescrito, o el original si algo falla
 */
async function rewriteWarmly(message, criticalPhrases = []) {
  const parts = [
    {
      text:
        'Reescribe el siguiente mensaje de un bot de soporte técnico de internet para que suene más cálido, cercano y transmita confianza de que el problema se va a resolver. ' +
        'No cambies ningún dato, número, nombre de orden, ni el sentido del mensaje — solo el tono y la redacción. ' +
        'Debes conservar EXACTAMENTE, palabra por palabra, estas frases dentro de tu respuesta (no las traduzcas, no las abrevies, no cambies mayúsculas/minúsculas ni tildes):\n' +
        criticalPhrases.map((p) => `- ${p}`).join('\n') +
        `\n\nMensaje original:\n"${message}"\n\n` +
        'Responde ÚNICAMENTE con el mensaje reescrito en español, sin comillas, sin comentarios ni explicaciones adicionales.',
    },
  ];

  const rewritten = await callGemini(parts);
  if (!rewritten) return message;

  // Verificación obligatoria: si falta alguna frase crítica tal cual,
  // no confiamos en la reescritura.
  const todasPresentes = criticalPhrases.every((phrase) => rewritten.includes(phrase));
  if (!todasPresentes) {
    console.warn('⚠️  Reescritura de IA descartada (faltó una frase crítica):', rewritten);
    return message;
  }

  return rewritten;
}

module.exports = { transcribeAudio, describeImage, classifyNovedadWithAI, rewriteWarmly };
