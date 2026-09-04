// server.js
// Bot de WhatsApp usando la Cloud API oficial de Meta.
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { handleMessage } = require('./flow');
const { setCustomers, getSyncStatus } = require('./customerLookup');

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

    if (!textBody) {
      await sendTextMessage(from, 'Por ahora solo puedo leer mensajes de texto 🙏');
      return;
    }

    // ------ Flujo conversacional (pipeline) ------
    const replies = await handleMessage(from, textBody);
    for (const reply of replies) {
      await sendTextMessage(from, reply);
    }

  } catch (err) {
    console.error('Error procesando el mensaje entrante:', err?.response?.data || err.message);
  }
});

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
// Endpoint que Power Automate llama (una vez por cada tabla/zona)
// para mandarnos los datos actuales del Excel.
// Ejemplo: POST /excel-sync?source=centro
// ---------------------------------------------------------------
app.post('/excel-sync', (req, res) => {
  const secret = req.header('x-sync-secret');
  if (secret !== process.env.EXCEL_SYNC_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const source = req.query.source || 'default';

  try {
    // Power Automate manda el resultado de "Listar filas" como
    // { value: [...] } — pero aceptamos también un arreglo directo
    // por si acaso.
    const rows = Array.isArray(req.body) ? req.body : req.body.value;
    setCustomers(source, rows);
    res.status(200).json({ ok: true, source, totalCustomers: rows.length });
  } catch (err) {
    console.error('Error en /excel-sync:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Para revisar rápidamente, desde el navegador, si ya llegaron datos.
app.get('/excel-sync/status', (_req, res) => {
  res.json(getSyncStatus());
});

// ---------------------------------------------------------------
app.get('/', (_req, res) => {
  res.send('Bot de WhatsApp activo ✅');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
