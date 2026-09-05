// smartolt.js
//
// Valida el estado de la conexión de un abonado consultando SmartOLT.
// netpaís tiene una instalación de SmartOLT distinta por ciudad; el
// prefijo del número de abonado nos dice a cuál conectarnos.
//
// IMPORTANTE — límite de SmartOLT: "get_all_onus_details" solo
// permite 15 llamadas por hora (por API key). Como esa lista casi no
// cambia, la traemos completa UNA VEZ POR HORA y la guardamos en
// memoria. Las consultas de cada cliente ("get_onu_status" y
// "get_onu_signal", con límite de 500/hora) sí se hacen en vivo.

const axios = require('axios');

const PREFIX_TO_CITY = {
  IBA: 'ibague',
  DOR: 'ladorada',
  PTO: 'puertosalgar',
  VDR: 'villadelrosario',
  LP: 'lospatios',
};

const ONU_LIST_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

// cache[city] = { fetchedAt: number, entries: [{ name, externalId, apiKey }] }
const cache = {};
// refreshing[city] = Promise en curso, para no disparar 2 refrescos a la vez
const refreshing = {};

function getCityFromAbonado(abonado) {
  const clean = String(abonado).trim().toUpperCase();
  // Los prefijos tienen distinto largo (la mayoría 3 letras, "LP" son 2),
  // así que probamos del más largo al más corto para no confundirlos.
  const prefixesByLength = Object.keys(PREFIX_TO_CITY).sort((a, b) => b.length - a.length);
  const match = prefixesByLength.find((prefix) => clean.startsWith(prefix));
  return match ? PREFIX_TO_CITY[match] : null;
}

// Credenciales por ciudad. Algunas ciudades tienen más de un OLT
// (ej: Ibagué tiene 2), así que guardamos un arreglo de API keys.
// Variables de entorno esperadas, ej. para Ibagué:
//   SMARTOLT_IBAGUE_URL=https://clancolombia-ibague.smartolt.com
//   SMARTOLT_IBAGUE_API_KEYS=282956cd46584dd7b56c7d0a5ef937db,af0b3286da1e42acbcfc06148e13e2a5
function getCityConfig(city) {
  const envPrefix = `SMARTOLT_${city.toUpperCase()}`;
  const baseUrl = process.env[`${envPrefix}_URL`];
  const apiKeysRaw = process.env[`${envPrefix}_API_KEYS`] || '';
  const apiKeys = apiKeysRaw.split(',').map((k) => k.trim()).filter(Boolean);
  return { baseUrl, apiKeys };
}

// Trae TODOS los ONUs de TODOS los OLTs de una ciudad (1 llamada por
// OLT, sin paginar) y los guarda en cache.
async function refreshCityOnuList(city) {
  const { baseUrl, apiKeys } = getCityConfig(city);
  let entries = [];

  for (const apiKey of apiKeys) {
    try {
      const response = await axios.get(`${baseUrl}/api/onu/get_all_onus_details`, {
        headers: { 'X-Token': apiKey },
      });
      const onus = response.data?.onus || [];
      entries = entries.concat(
        onus.map((onu) => ({
          name: onu.name || '',
          externalId: onu.unique_external_id || onu.sn,
          apiKey,
        }))
      );
    } catch (err) {
      console.warn(`⚠️  Error trayendo lista de ONUs de SmartOLT (${city}):`, err.message);
    }
  }

  cache[city] = { fetchedAt: Date.now(), entries };
  console.log(`🔄 SmartOLT (${city}): ${entries.length} ONUs cacheados`);
}

async function getCityOnuList(city) {
  const cached = cache[city];
  const isStale = !cached || Date.now() - cached.fetchedAt > ONU_LIST_CACHE_TTL_MS;

  if (isStale) {
    // Evita refrescos duplicados si llegan varias consultas a la vez
    if (!refreshing[city]) {
      refreshing[city] = refreshCityOnuList(city).finally(() => {
        delete refreshing[city];
      });
    }
    await refreshing[city];
  }

  return cache[city]?.entries || [];
}

function findOnuInList(entries, abonado) {
  const abonadoUpper = abonado.toUpperCase();
  return entries.find((e) => e.name.toUpperCase().startsWith(abonadoUpper));
}

async function fetchOnuField(baseUrl, apiKey, externalId, path) {
  try {
    const response = await axios.get(
      `${baseUrl}${path}/${encodeURIComponent(externalId)}`,
      { headers: { 'X-Token': apiKey }, validateStatus: (s) => s === 200 || s === 400 }
    );
    return response.status === 200 ? response.data : null;
  } catch (err) {
    console.warn(`⚠️  Error consultando SmartOLT (${path}):`, err.message);
    return null;
  }
}

/**
 * Consulta el estado/señal del ONU asociado a un abonado.
 * @param {string} abonado - número de abonado (ej: "IBA007342")
 * @returns {Promise<{status:string, signal:string, lastStatusChange:string}|null>}
 */
async function getOnuSignal(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) {
    console.warn(`⚠️  Prefijo de abonado no reconocido para SmartOLT: ${abonado}`);
    return null;
  }

  const { baseUrl, apiKeys } = getCityConfig(city);
  if (!baseUrl || apiKeys.length === 0) {
    console.warn(`⚠️  Faltan credenciales de SmartOLT para la ciudad: ${city}`);
    return null;
  }

  const entries = await getCityOnuList(city);
  const match = findOnuInList(entries, abonado);
  if (!match) return null; // no está en la lista cacheada de esta ciudad

  const [statusData, signalData] = await Promise.all([
    fetchOnuField(baseUrl, match.apiKey, match.externalId, '/api/onu/get_onu_status'),
    fetchOnuField(baseUrl, match.apiKey, match.externalId, '/api/onu/get_onu_signal'),
  ]);

  return {
    status: statusData?.onu_status || '',
    lastStatusChange: statusData?.last_status_change || 'N/D',
    signal: signalData?.onu_signal || '',
  };
}

// Traduce los valores crudos de SmartOLT a frases claras para el cliente.
function translateStatus(status) {
  const map = {
    online: 'en línea',
    offline: 'sin conexión de fibra óptica',
    'power fail': 'sin conexión a energía eléctrica',
    los: 'sin conexión de energía y fibra óptica',
  };
  return map[String(status).toLowerCase()] || status || 'desconocido';
}

function translateSignal(signal) {
  const map = {
    'very good': 'muy buena',
    warning: 'en advertencia (será revisada)',
    critical: 'crítica (requiere revisión inmediata)',
  };
  const key = String(signal).toLowerCase();
  if (map[key]) return map[key];
  return 'sin señal de conexión de fibra óptica';
}

// SmartOLT manda algo como "2026-09-02 02:45:47.425187" — lo
// convertimos a algo legible como "2 de septiembre, 2:45 a. m."
function formatLastStatusChange(rawDate) {
  if (!rawDate || rawDate === 'N/D') return 'sin datos recientes';

  const cleaned = rawDate.split('.')[0].replace(' ', 'T');
  const date = new Date(cleaned);
  if (isNaN(date.getTime())) return rawDate;

  return date.toLocaleString('es-CO', {
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

module.exports = {
  getOnuSignal,
  translateStatus,
  translateSignal,
  formatLastStatusChange,
};
