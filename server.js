// server.js
// Bot de WhatsApp usando la Cloud API oficial de Meta.
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,       // el mismo valor que vas a poner en el panel de Meta
  WHATSAPP_TOKEN,     // token de acceso (temporal o permanente)
  PHONE_NUMBER_ID,    // el que copiaste del panel: 1359415357249667
  PORT = 3000,
} = process.env;

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

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
    const textBody = type === 'text' ? message.text.body : null;

    console.log(`📩 Mensaje de ${from} (${type}): ${textBody ?? '[contenido no textual]'}`);

    // ------ Lógica del bot de soporte (punto de partida) ------
    const reply = buildReply(textBody);
    await sendTextMessage(from, reply);

  } catch (err) {
    console.error('Error procesando el mensaje entrante:', err?.response?.data || err.message);
  }
});

// ---------------------------------------------------------------
// Lógica de respuesta muy simple, para reemplazar por tu propia
// lógica de soporte (reglas, árbol de decisión, o un LLM)
// ---------------------------------------------------------------
function buildReply(text) {
  if (!text) {
    return 'Recibí tu mensaje, pero por ahora solo puedo leer texto. ¿Puedes escribirme tu consulta?';
  }
  const t = text.trim().toLowerCase();
  if (t.includes('hola')) {
    return '¡Hola! 👋 Soy el asistente de soporte. ¿En qué puedo ayudarte hoy?';
  }
  if (t.includes('horario')) {
    return 'Nuestro horario de atención es de lunes a sábado, 9am a 6pm.';
  }
  return `Recibí tu mensaje: "${text}". En breve un agente lo revisará (esta es una respuesta de prueba del bot).`;
}

// ---------------------------------------------------------------
// Función para enviar un mensaje de texto vía la Cloud API
// ---------------------------------------------------------------
async function sendTextMessage(to, body) {
  await axios.post(
    GRAPH_URL,
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

// ---------------------------------------------------------------
app.get('/', (_req, res) => {
  res.send('Bot de WhatsApp activo ✅');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
