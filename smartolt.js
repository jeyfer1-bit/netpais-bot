// smartolt.js
//
// Valida el estado de la conexión de un abonado consultando SmartOLT.
// netpaís tiene una instalación de SmartOLT distinta por ciudad; el
// prefijo del número de abonado nos dice a cuál conectarnos.
//
// SmartOLT identifica cada ONU por su "unique_external_id" (el serial
// del equipo), NO por el abonado. El abonado vive dentro del campo
// "Name" del ONU (ej: "IBA007342 - 5833517 - JOSE PAEZ"). Por eso la
// consulta se hace en 2 pasos:
//   1) Buscar el ONU filtrando por "name" = abonado -> sacar su
//      unique_external_id (serial).
//   2) Con ese serial, consultar estado (get_onu_status) y señal
//      (get_onu_signal).

const axios = require('axios');

const PREFIX_TO_CITY = {
  IBA: 'ibague',
  DOR: 'ladorada',
  PTO: 'puertosalgar',
  VDR: 'villadelrosario',
  LPT: 'lospatios',
};

function getCityFromAbonado(abonado) {
  const prefix = String(abonado).trim().slice(0, 3).toUpperCase();
  return PREFIX_TO_CITY[prefix] || null;
}

// Credenciales por ciudad. Algunas ciudades tienen más de un OLT
// (ej: Ibagué tiene 2), así que guardamos un arreglo de API keys por
// ciudad y probamos cada una hasta encontrar el ONU.
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

/**
 * Busca el ONU cuyo "Name" empiece con el abonado, y devuelve su
 * unique_external_id (serial). Devuelve null si no está en este OLT.
 */
async function findOnuExternalId(baseUrl, apiKey, abonado) {
  try {
    const response = await axios.get(`${baseUrl}/api/onu/get_all_onus_details`, {
      headers: { 'X-Token': apiKey },
      params: { name: abonado, page: 1, page_size: 5 },
      validateStatus: (s) => s === 200 || s === 400,
    });

    if (response.status !== 200 || !Array.isArray(response.data?.onus)) {
      return null;
    }

    const abonadoUpper = abonado.toUpperCase();
    const match = response.data.onus.find((onu) =>
      String(onu.name || '').toUpperCase().startsWith(abonadoUpper)
    );

    return match ? match.unique_external_id || match.sn : null;
  } catch (err) {
    console.warn('⚠️  Error buscando ONU por nombre en SmartOLT:', err.message);
    return null;
  }
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
 * Consulta el estado/señal del ONU asociado a un abonado, probando
 * cada OLT (API key) configurado para su ciudad hasta encontrarlo.
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

  for (const apiKey of apiKeys) {
    const externalId = await findOnuExternalId(baseUrl, apiKey, abonado);
    if (!externalId) continue; // no está en este OLT, probamos el siguiente

    const [statusData, signalData] = await Promise.all([
      fetchOnuField(baseUrl, apiKey, externalId, '/api/onu/get_onu_status'),
      fetchOnuField(baseUrl, apiKey, externalId, '/api/onu/get_onu_signal'),
    ]);

    return {
      status: statusData?.onu_status || '',
      lastStatusChange: statusData?.last_status_change || 'N/D',
      signal: signalData?.onu_signal || '',
    };
  }

  return null; // no se encontró en ningún OLT de la ciudad
}

// Traduce los valores crudos de SmartOLT a frases claras para el cliente.
function translateStatus(status) {
  const map = {
    online: 'en línea (conexión OK)',
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

module.exports = {
  getOnuSignal,
  translateStatus,
  translateSignal,
};
