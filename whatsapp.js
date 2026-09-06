// whatsapp.js
//
// Funciones para enviar mensajes por la Cloud API de WhatsApp.
// Centralizado aquí (en vez de vivir solo en server.js) para que
// flow.js también pueda enviar mensajes directamente cuando necesita
// mandar algo que no es texto plano, como una imagen (ej: el gráfico
// de tráfico de SmartOLT), sin crear una dependencia circular entre
// server.js y flow.js.

const axios = require('axios');
const FormData = require('form-data');

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID } = process.env;

const GRAPH_API_VERSION = 'v21.0';
const MESSAGES_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
const MEDIA_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/media`;

/**
 * Envía un mensaje de texto plano.
 */
async function sendTextMessage(to, body) {
  await axios.post(
    MESSAGES_URL,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Sube una imagen binaria a WhatsApp y luego la envía al número indicado.
 * Se hace en 2 pasos porque la Cloud API no acepta bytes de imagen
 * directamente en el mensaje: primero hay que subirlos a la Media API
 * (que devuelve un media_id) y luego referenciar ese media_id.
 *
 * @param {string} to
 * @param {Buffer} buffer - bytes de la imagen (ej: PNG que devuelve SmartOLT)
 * @param {string} [caption] - texto opcional que acompaña la imagen
 */
async function sendImageMessage(to, buffer, caption) {
  // 1) Subir el binario a la Media API de WhatsApp
  const form = new FormData();
  form.append('file', buffer, { filename: 'grafico.png', contentType: 'image/png' });
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');

  const uploadResponse = await axios.post(MEDIA_URL, form, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      ...form.getHeaders(),
    },
  });

  const mediaId = uploadResponse.data?.id;
  if (!mediaId) {
    throw new Error('No se recibió media_id al subir la imagen a WhatsApp');
  }

  // 2) Enviar el mensaje de imagen usando ese media_id
  await axios.post(
    MESSAGES_URL,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: {
        id: mediaId,
        ...(caption ? { caption } : {}),
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

module.exports = { sendTextMessage, sendImageMessage };
