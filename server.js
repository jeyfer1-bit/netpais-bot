// server.js
// Bot de WhatsApp usando la Cloud API oficial de Meta.
require('dotenv').config();
const express = require('express');
const { handleMessage } = require('./flow');
const { sendTextMessage, downloadMedia } = require('./whatsapp');
const { transcribeAudio, describeImage } = require('./ai');

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,       // el mismo valor que vas a poner en el panel de Meta
  PORT = 3000,
} = process.env;

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
app.post('/webhook', async (req, res) => {
  // Responder rápido siempre (Meta espera un 200 en pocos segundos)
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Puede ser una actualización de estado (enviado/entregado/leído), no un mensaje nuevo
      return;
    }

    const from = message.from; // número del usuario, ej: "573001234567"
    const type = message.type;
    let textBody = null;

    if (type === 'text') {
      textBody = message.text.body;
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
    } else {
      await sendTextMessage(from, 'Por ahora puedo leer mensajes de texto, notas de voz e imágenes 🙏');
      return;
    }

    console.log(`📩 Mensaje de ${from} (${type}): ${textBody}`);

    // ------ Flujo conversacional (pipeline) ------
    // A partir de aquí, textBody es siempre texto plano (venga de donde
    // venga) — handleMessage nunca sabe si el mensaje original era
    // texto, una nota de voz transcrita, o una imagen descrita.
    const replies = await handleMessage(from, textBody);
    for (const reply of replies) {
      await sendTextMessage(from, reply);
    }

  } catch (err) {
    console.error('Error procesando el mensaje entrante:', err?.response?.data || err.message);
  }
});

// ---------------------------------------------------------------
app.get('/', (_req, res) => {
  res.send('Bot de WhatsApp activo ✅');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
