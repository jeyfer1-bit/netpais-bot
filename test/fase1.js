// test/fase1.js — prueba de la Fase 1 (registro de conversaciones) contra un Postgres de PRUEBA.
//
//   DATABASE_URL=postgres://.../bot_prueba node test/fase1.js
//
// No llama a Meta, Power Automate ni SmartOLT: esas llamadas se simulan.
// ⚠️ Borra las tablas bot_* de la base que le pases: NUNCA apuntarlo al Postgres de producción.
const assert = require('assert');

if (!process.env.DATABASE_URL || !/prueba|test|localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)) {
  console.error('Usa un DATABASE_URL de prueba (debe contener "prueba", "test" o "localhost").');
  process.exit(1);
}
process.env.POWER_AUTOMATE_LOOKUP_URL = 'https://pa.prueba/lookup';
process.env.POWER_AUTOMATE_ORDENES_URL = 'https://pa.prueba/ordenes';
process.env.BOT_ABANDONO_MIN = '30';

// ---------- Simulaciones ----------
const CLIENTES = {
  IBA001: { estado: 'Por Instalar', nombre: 'ANA PRUEBA' },
  IBA002: { estado: 'Activo', nombre: 'LUIS PRUEBA' },
  DOR003: { estado: 'Cortado', nombre: 'EVA PRUEBA' },
  LP004: { estado: 'Castigado', nombre: 'JOSE PRUEBA' },
  PTO005: { estado: 'Retirado', nombre: 'SOL PRUEBA' },
};
const enviados = []; // { to, body }
let waSeq = 0;
const axios = require('axios');
axios.post = async (url, body) => {
  if (url.includes('graph.facebook.com')) {
    enviados.push({ to: body.to, body: body.text?.body || body.image?.caption });
    return { data: { messages: [{ id: `wamid.salida.${++waSeq}` }] } };
  }
  if (url === process.env.POWER_AUTOMATE_LOOKUP_URL) {
    const q = String(body.query).toUpperCase();
    const c = CLIENTES[q];
    return { data: { matches: c ? [{ documento: '123', nro_abonado: q, nombre: c.nombre, estado: c.estado, barrio: 'Centro', zona: '' }] : [] } };
  }
  if (url === process.env.POWER_AUTOMATE_ORDENES_URL) {
    return {
      data: {
        ordenes: [{ nro_orden: 'ORD-9', nro_abonado: body.abonado, detalle_orden: 'INSTALACIÓN', estatus_orden: 'CREADA', fecha_emision: '2026-09-01T08:00:00' }],
        tipificacion: [{ detalle_orden: 'INSTALACIÓN', Tiempo: '72 horas', Prioridad: '2' }],
      },
    };
  }
  throw new Error(`URL no simulada: ${url}`);
};
const smartolt = require('../smartolt');
smartolt.getOnuSignal = async () => null; // "no pude validar automáticamente… pero seguimos"

const db = require('../db');
const { atender } = require('../server');

let inSeq = 0;
const msg = (from, text, id) => ({ from, type: 'text', id: id || `wamid.entrada.${++inSeq}`, text: { body: text } });
const decir = async (from, ...textos) => { for (const t of textos) await atender(msg(from, t)); };
const conv = async (tel) => (await db.query(`SELECT * FROM bot_conversaciones WHERE telefono = $1 ORDER BY id DESC LIMIT 1`, [tel])).rows[0];
const ultimo = (tel) => [...enviados].reverse().find((e) => e.to === tel)?.body || '';
const espera = () => require('../whatsapp').registrosPendientes(); // registros de salientes en cola

async function main() {
  await db.query('DROP TABLE IF EXISTS bot_sla_vencidas, bot_eventos, bot_mensajes, bot_conversaciones CASCADE');
  await db.migrar();

  // 1) Por instalar con SLA vencido → mensaje de prioridad, registro para el programador, "¿algo más?" → no → resuelta_bot
  await decir('571', 'hola', 'sí', 'IBA001');
  await espera();
  assert.match(ultimo('571'), /algo más/);
  let c = await conv('571');
  assert.equal(c.abonado, 'IBA001');
  assert.equal(c.localidad, 'ibague');
  assert.equal(c.sesion.step, 'ASK_ANYTHING_ELSE', 'la sesión vive en Postgres');
  const sla = (await db.query(`SELECT * FROM bot_sla_vencidas`)).rows;
  assert.equal(sla.length, 1);
  assert.equal(sla[0].nro_orden, 'ORD-9');
  assert.equal(sla[0].conversacion_id, c.id);
  await decir('571', 'no');
  await espera();
  c = await conv('571');
  assert.equal(c.estado, 'cerrada');
  assert.equal(c.resultado, 'resuelta_bot');
  const msjs = (await db.query(`SELECT direccion, autor FROM bot_mensajes WHERE conversacion_id = $1`, [c.id])).rows;
  assert.equal(msjs.filter((m) => m.direccion === 'entrante').length, 4);
  assert.ok(msjs.filter((m) => m.direccion === 'saliente').length >= 6, 'salientes registrados');
  console.log('✅ 1. Por instalar + SLA vencido + cierre resuelta_bot');

  // 2) No es cliente → comercial; luego el bot calla
  await decir('572', 'hola', 'no');
  c = await conv('572');
  assert.equal(c.estado, 'esperando_humano');
  assert.equal(c.cola, 'comercial');
  assert.equal(c.motivo_transferencia, 'no_cliente');
  const antes = enviados.length;
  await decir('572', '¿hola? ¿alguien?');
  await espera();
  assert.equal(enviados.length, antes, 'el bot no responde con la conversación en humano');
  const n = (await db.query(`SELECT count(*)::int n FROM bot_mensajes WHERE conversacion_id = $1 AND direccion = 'entrante'`, [c.id])).rows[0].n;
  assert.equal(n, 3, 'pero sí registra lo que escribe el cliente');
  console.log('✅ 2. Transferencia a comercial y silencio del bot');

  // 3) Cortado → "ponte al día" + "¿algo más?" → sí → administrativo
  await decir('573', 'hola', 'si', 'DOR003');
  assert.match(ultimo('573'), /algo más/);
  await decir('573', 'sí');
  c = await conv('573');
  assert.equal(c.cola, 'administrativo');
  assert.equal(c.motivo_transferencia, 'cortado');
  assert.equal(c.localidad, 'ladorada');
  console.log('✅ 3. Cortado con "¿algo más?" y paso a administrativo');

  // 4) Castigado → administrativo en el mismo turno, con los datos del cliente
  await decir('574', 'hola', 'sí', 'LP004');
  c = await conv('574');
  assert.equal(c.estado, 'esperando_humano');
  assert.equal(c.cola, 'administrativo');
  assert.equal(c.abonado, 'LP004');
  assert.equal(c.localidad, 'lospatios');
  console.log('✅ 4. Castigado → administrativo');

  // 5) Pide asesor
  await decir('575', 'hola', 'quiero hablar con un asesor');
  c = await conv('575');
  assert.equal(c.cola, 'servicio_cliente');
  assert.equal(c.motivo_transferencia, 'pide_asesor');
  console.log('✅ 5. Pide asesor → servicio al cliente');

  // 6) El bot no entiende 3 veces seguidas
  await decir('576', 'hola', 'mmm', 'eh?', 'jajaja');
  c = await conv('576');
  assert.equal(c.motivo_transferencia, 'no_entiende');
  const ne = (await db.query(`SELECT count(*)::int n FROM bot_eventos WHERE conversacion_id = $1 AND tipo = 'no_entendido'`, [c.id])).rows[0].n;
  assert.equal(ne, 3);
  console.log('✅ 6. No entiende ×3 → servicio al cliente');

  // 7) Mensaje repetido por Meta (mismo wamid) → se ignora
  await atender(msg('577', 'hola', 'wamid.repetido'));
  const e1 = enviados.length;
  await atender(msg('577', 'hola', 'wamid.repetido'));
  assert.equal(enviados.length, e1);
  console.log('✅ 7. Mensaje duplicado ignorado');

  // 8) Abandono: el cliente deja de responder > 30 min
  await decir('578', 'hola');
  await db.query(`UPDATE bot_conversaciones SET ultimo_mensaje_cliente_en = now() - interval '31 minutes' WHERE telefono = '578'`);
  await require('../conversaciones').cerrarAbandonadas();
  c = await conv('578');
  assert.equal(c.resultado, 'abandonada');
  await decir('578', 'hola de nuevo');
  const c2 = await conv('578');
  assert.notEqual(c2.id, c.id, 'nueva conversación');
  assert.match(ultimo('578'), /ya eres cliente/);
  console.log('✅ 8. Abandono y nueva conversación');

  // 9) #reset
  await decir('579', 'hola', 'sí', '#reset');
  const r = (await db.query(`SELECT resultado FROM bot_conversaciones WHERE telefono = '579' ORDER BY id`)).rows;
  assert.equal(r[0].resultado, 'reiniciada');
  assert.equal(r.length, 2);
  console.log('✅ 9. #reset');

  // 10) Retirado → comercial
  await decir('580', 'hola', 'sí', 'PTO005');
  c = await conv('580');
  assert.equal(c.cola, 'comercial');
  assert.equal(c.localidad, 'puertosalgar');
  console.log('✅ 10. Retirado → comercial');

  await espera();
  const orden = (await db.query(`SELECT texto FROM bot_mensajes WHERE conversacion_id = (SELECT id FROM bot_conversaciones WHERE telefono = '576') ORDER BY id`)).rows.map((r) => r.texto);
  assert.match(orden[1], /^¡Hola!/, 'los mensajes quedan en orden');
  console.log('\nTodo OK');
  await db.pool().end();
}

main().catch(async (err) => {
  console.error('❌', err);
  process.exit(1);
});
