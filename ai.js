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
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const NOVEDAD_CATEGORIES = [
  'orden',
  'novedadconservicio',
  'sinservicio',
  'tv',
  'aplicaciones',
  'velocidadcontratada',
];

/**
 * Llama a Gemini con las "parts" dadas (texto y/o datos binarios en base64)
 * y devuelve el texto de la respuesta, o null si algo falla.
 */
async function callGemini(parts, { maxOutputTokens = 300 } = {}) {
  if (!GEMINI_API_KEY) {
    console.warn('⚠️  Falta GEMINI_API_KEY — no se puede llamar a Gemini.');
    return null;
  }

  try {
    const response = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts }],
        generationConfig: { maxOutputTokens, temperature: 0.2 },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? text.trim() : null;
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
        'Un cliente de un bot de soporte técnico de internet en Colombia envió esta imagen. ' +
        (contextHint ? `En ese momento se le estaba preguntando: "${contextHint}". ` : '') +
        'Describe en una sola frase corta, en español, lo que ves en la imagen y que sea relevante para responder esa pregunta ' +
        '(por ejemplo: colores de LEDs encendidos, estado de cables o conectores, texto o números visibles en una pantalla). ' +
        'Responde ÚNICAMENTE con la descripción, sin comentarios adicionales.',
    },
    { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
  ];

  return callGemini(parts);
}

/**
 * Respaldo de clasificación de novedad (Nivel 1), usado solo cuando
 * classify() de novedad.js no logra identificar la categoría por
 * palabras clave. Devuelve una de las 6 categorías válidas, o null.
 * @param {string} text
 * @returns {Promise<string|null>}
 */
async function classifyNovedadWithAI(text) {
  const parts = [
    {
      text:
        `Eres un clasificador para un bot de soporte de internet. El cliente escribió: "${text}"\n\n` +
        'Clasifícalo en EXACTAMENTE una de estas categorías (responde solo con la palabra clave, en minúsculas, sin nada más):\n\n' +
        '- orden: quiere saber el estado de una orden o visita de mantenimiento ya agendada\n' +
        '- novedadconservicio: tiene servicio activo pero con fallas (intermitencias, se corta, lento)\n' +
        '- sinservicio: no tiene internet en absoluto\n' +
        '- tv: problema con el servicio de televisión\n' +
        '- aplicaciones: problema con una app o página web específica (no carga, no abre)\n' +
        '- velocidadcontratada: su test de velocidad no corresponde con las megas contratadas\n\n' +
        'Si no puedes clasificarlo con confianza en ninguna de estas categorías, responde exactamente: ninguna',
    },
  ];

  const result = await callGemini(parts, { maxOutputTokens: 20 });
  if (!result) return null;

  const category = result.trim().toLowerCase();
  return NOVEDAD_CATEGORIES.includes(category) ? category : null;
}

module.exports = { transcribeAudio, describeImage, classifyNovedadWithAI };
