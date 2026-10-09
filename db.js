// db.js — conexión al Postgres de netpais-reporte (mismo proyecto de Railway).
//
// El bot guarda aquí cada conversación, sus mensajes y sus eventos, para que
// el tablero del bot en el portal (módulo /bot/ de netpais-reporte) las lea.
// Variable de entorno: DATABASE_URL (en Railway, como referencia al Postgres
// del reporte: ${{Postgres.DATABASE_URL}}). Sin ella, el bot funciona igual
// que antes: sesiones en memoria y sin registro.
//
// Las tablas bot_* son del bot: las crea y las migra él al arrancar.

let pool = null;

const url = process.env.DATABASE_URL || '';

function activa() {
  return Boolean(pool);
}

if (url) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' || /sslmode=require/.test(url) ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  pool.on('error', (err) => console.error('Postgres (pool):', err.message));
}

async function query(sql, params) {
  if (!pool) throw new Error('Sin base de datos (falta DATABASE_URL)');
  return pool.query(sql, params);
}

async function migrar() {
  if (!pool) {
    console.warn('⚠️ Sin DATABASE_URL: las conversaciones no se guardan y las sesiones viven solo en memoria.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_conversaciones (
      id BIGSERIAL PRIMARY KEY,
      telefono TEXT NOT NULL,
      abonado TEXT,
      cliente_nombre TEXT,
      localidad TEXT,                -- ibague | ladorada | puertosalgar | villadelrosario | lospatios
      estado TEXT NOT NULL DEFAULT 'bot',  -- bot | esperando_humano | con_humano | cerrada
      resultado TEXT,                -- resuelta_bot | transferida | abandonada | cerrada_humano | reiniciada
      categoria TEXT,                -- orden | novedadconservicio | sinservicio | tv | aplicaciones | velocidadcontratada
      cola TEXT,                     -- mda | administrativo | comercial | servicio_cliente
      agente_id TEXT,
      motivo_transferencia TEXT,
      sesion JSONB,                  -- estado del flujo del bot (antes vivía en un Map en memoria)
      creada_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      ultimo_mensaje_en TIMESTAMPTZ,
      ultimo_mensaje_cliente_en TIMESTAMPTZ,   -- ventana de 24 h de WhatsApp
      transferida_en TIMESTAMPTZ,
      primera_respuesta_humana_en TIMESTAMPTZ,
      cerrada_en TIMESTAMPTZ,
      calificacion SMALLINT
    );
    -- Una sola conversación abierta por teléfono
    CREATE UNIQUE INDEX IF NOT EXISTS bot_conv_abierta ON bot_conversaciones (telefono) WHERE estado <> 'cerrada';
    CREATE INDEX IF NOT EXISTS bot_conv_estado ON bot_conversaciones (estado, cola);
    CREATE INDEX IF NOT EXISTS bot_conv_creada ON bot_conversaciones (creada_en);
    -- Fase 3: desde cuándo espera en su cola actual (se reinicia al reasignar)
    ALTER TABLE bot_conversaciones ADD COLUMN IF NOT EXISTS en_cola_desde TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS bot_conv_agente ON bot_conversaciones (agente_id) WHERE estado = 'con_humano';
    -- Fase 5: calificación 1-5 que se pide al cerrar un asesor, y anonimización por retención (Ley 1581)
    ALTER TABLE bot_conversaciones ADD COLUMN IF NOT EXISTS calificacion_pedida_en TIMESTAMPTZ;
    ALTER TABLE bot_conversaciones ADD COLUMN IF NOT EXISTS anonimizada_en TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS bot_conv_cerrada_en ON bot_conversaciones (cerrada_en) WHERE anonimizada_en IS NULL;

    CREATE TABLE IF NOT EXISTS bot_mensajes (
      id BIGSERIAL PRIMARY KEY,
      conversacion_id BIGINT NOT NULL REFERENCES bot_conversaciones(id),
      direccion TEXT NOT NULL,       -- entrante | saliente
      autor TEXT NOT NULL,           -- cliente | bot | agente
      agente_id TEXT,
      tipo TEXT NOT NULL DEFAULT 'text',  -- text | audio | image | ...
      texto TEXT,
      media_id TEXT,                 -- id de WhatsApp del audio/imagen (se descarga con la API de medios)
      wa_message_id TEXT,
      error TEXT,                    -- si el envío falló
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Meta a veces reenvía el mismo mensaje: el id de WhatsApp no se repite
    CREATE UNIQUE INDEX IF NOT EXISTS bot_msj_wa ON bot_mensajes (wa_message_id) WHERE wa_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS bot_msj_conv ON bot_mensajes (conversacion_id, id);

    CREATE TABLE IF NOT EXISTS bot_eventos (
      id BIGSERIAL PRIMARY KEY,
      conversacion_id BIGINT NOT NULL REFERENCES bot_conversaciones(id),
      tipo TEXT NOT NULL,            -- transferida | tomada | reasignada | cerrada | reabierta | devuelta | nota | no_entendido | error_integracion
      de_cola TEXT, a_cola TEXT,
      de_agente TEXT, a_agente TEXT,
      nota TEXT,
      usuario_id TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bot_evt_conv ON bot_eventos (conversacion_id, id);
    CREATE INDEX IF NOT EXISTS bot_evt_tipo ON bot_eventos (tipo, creado_en);

    -- Órdenes con SLA vencido que el bot le informó al cliente ("la vamos a priorizar").
    -- El tablero programador las lee para darles prioridad 1.
    CREATE TABLE IF NOT EXISTS bot_sla_vencidas (
      nro_orden TEXT PRIMARY KEY,
      abonado TEXT NOT NULL,
      localidad TEXT,
      detalle_orden TEXT,
      fecha_emision TEXT,
      conversacion_id BIGINT REFERENCES bot_conversaciones(id),
      veces INTEGER NOT NULL DEFAULT 1,       -- cuántas veces la consultó el cliente
      primera_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      ultima_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      atendida_en TIMESTAMPTZ,                -- la marca el programador
      atendida_por TEXT
    );

    -- Cada intento de cambio de clave WiFi desde el bot, por modelo de ONU y banda.
    -- De aquí sale la lista de modelos compatibles / no compatibles (wifiCompat.js).
    CREATE TABLE IF NOT EXISTS bot_wifi_intentos (
      id BIGSERIAL PRIMARY KEY,
      modelo TEXT NOT NULL,                   -- onu_type_name en SmartOLT
      banda TEXT NOT NULL,                    -- '24' | '5'
      puerto TEXT,                            -- wifi_0/1, wifi_0/5
      modo TEXT,                              -- Routing / Bridging
      abonado TEXT,
      ok BOOLEAN NOT NULL,                    -- SmartOLT confirmó y el SSID se conservó
      ssid_conservado BOOLEAN,                -- null = SmartOLT no reporta el SSID
      respuesta TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bot_wifi_modelo ON bot_wifi_intentos (modelo, banda);

    -- Fallas masivas y ventanas de mantenimiento (correos de MDA vía Power Automate).
    CREATE TABLE IF NOT EXISTS bot_eventos_red (
      id BIGSERIAL PRIMARY KEY,
      clave TEXT NOT NULL UNIQUE,             -- asunto normalizado, sin RE:/RV:
      asunto TEXT,
      tipo TEXT NOT NULL,                     -- falla_masiva | ventana
      titulo TEXT,
      ciudad TEXT,                            -- ibague | ladorada | puertosalgar | villadelrosario | lospatios
      zona TEXT,
      olt INTEGER, board INTEGER, puerto INTEGER,   -- ventanas por puerto PON
      afectacion TEXT,
      tiempo_txt TEXT,
      horas_estimadas NUMERIC,
      fecha_txt TEXT,
      descripcion TEXT,
      radicado TEXT,
      usuarios INTEGER,
      abonados TEXT[] NOT NULL DEFAULT '{}',
      estado TEXT NOT NULL DEFAULT 'abierto', -- abierto | cerrado
      ultimo_correo_id TEXT,
      abierto_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      cerrado_en TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS bot_eventos_red_estado ON bot_eventos_red (estado, actualizado_en);
  `);
  console.log('🗄️ Tablas del bot listas en Postgres');
}

module.exports = { query, migrar, activa, pool: () => pool };
