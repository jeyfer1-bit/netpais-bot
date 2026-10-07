// internal.js — endpoint interno para que un asesor le escriba al cliente desde el portal.
//
//   POST /internal/send   (lo llama netpais-reporte por la red privada de Railway)
//   Cabecera: X-Bot-Secret: <BOT_INTERNAL_SECRET>
//   Cuerpo:   { conversacion_id, telefono, texto, agente_id, autor? }   autor: agente (defecto) | bot
//
// El token de WhatsApp vive SOLO en este servicio: el portal nunca lo ve.
// Como el bot tiene dominio público (por el webhook de Meta), el endpoint exige un
// secreto largo y limita la tasa por asesor. Solo escribe a conversaciones que están
// con un humano y dentro de la ventana de 24 h de WhatsApp.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { sendTextMessage } = require('./whatsapp');

const VENTANA_MS = 24 * 60 * 60 * 1000;
const MAX_POR_MIN = 30; // mensajes por asesor por minuto
const MAX_TEXTO = 4000; // WhatsApp acepta hasta 4096

function igual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb) && Boolean(a);
}

const ventanas = new Map(); // agente → [timestamps]
function dentroDeTasa(agente) {
  const ahora = Date.now();
  const lista = (ventanas.get(agente) || []).filter((t) => ahora - t < 60000);
  if (lista.length >= MAX_POR_MIN) return false;
  lista.push(ahora);
  ventanas.set(agente, lista);
  return true;
}

function crear() {
  const r = express.Router();
  const secreto = process.env.BOT_INTERNAL_SECRET || '';

  r.use((req, res, next) => {
    if (secreto.length < 32) return res.status(503).json({ error: 'Envío interno deshabilitado (falta BOT_INTERNAL_SECRET de 32+ caracteres).' });
    if (!igual(req.get('X-Bot-Secret'), secreto)) return res.status(403).json({ error: 'No autorizado' });
    if (!db.activa()) return res.status(503).json({ error: 'El bot no tiene base de datos' });
    next();
  });

  r.post('/send', async (req, res) => {
    const { conversacion_id: convId, telefono, texto, agente_id: agente } = req.body || {};
    const autor = req.body?.autor === 'bot' ? 'bot' : 'agente';
    const limpio = String(texto || '').trim();
    if (!convId || !telefono || !agente || !limpio) return res.status(400).json({ error: 'Faltan datos (conversación, teléfono, asesor o texto).' });
    if (limpio.length > MAX_TEXTO) return res.status(400).json({ error: `El mensaje es muy largo (máximo ${MAX_TEXTO} caracteres).` });
    if (!dentroDeTasa(String(agente))) return res.status(429).json({ error: 'Vas muy rápido: espera un momento antes de enviar más mensajes.' });

    try {
      const c = await db.query(
        `SELECT telefono, estado, ultimo_mensaje_cliente_en FROM bot_conversaciones WHERE id = $1`,
        [convId]
      );
      const conv = c.rows[0];
      if (!conv || conv.telefono !== String(telefono)) return res.status(404).json({ error: 'Conversación no encontrada' });
      if (!['esperando_humano', 'con_humano'].includes(conv.estado)) {
        return res.status(409).json({ error: 'La conversación ya no está con un asesor.' });
      }
      const ultimo = conv.ultimo_mensaje_cliente_en ? new Date(conv.ultimo_mensaje_cliente_en).getTime() : 0;
      if (Date.now() - ultimo > VENTANA_MS) {
        return res.status(409).json({ error: 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas.' });
      }
      const waId = await sendTextMessage(conv.telefono, limpio, { autor, agenteId: String(agente) });
      res.json({ ok: true, wa_message_id: waId });
    } catch (err) {
      const detalle = err?.response?.data?.error?.message || err.message;
      console.error('Error en envío interno:', detalle);
      res.status(502).json({ error: `WhatsApp no aceptó el mensaje: ${detalle}` });
    }
  });

  return r;
}

module.exports = { crear };
