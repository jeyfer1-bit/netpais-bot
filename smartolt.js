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
//   SMARTOLT_IBAGUE_API_KEYS=<key1>,<key2>   (los valores reales solo en Railway)
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
          // Ubicación en la red, para cruzar con ventanas de mantenimiento por puerto PON
          oltName: onu.olt_name || '',
          board: onu.board != null ? Number(onu.board) : null,
          port: onu.port != null ? Number(onu.port) : null,
          // Foto del estado al momento del refresco (para los vecinos del puerto PON en el tablero)
          status: onu.status || '',
          signal: onu.signal || '',
          signal1310: onu.signal_1310 || null, // dBm del ONU leído en la OLT (subida)
          signal1490: onu.signal_1490 || null, // dBm recibido por la ONU (bajada)
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
    offline: 'desconectado',
    'power fail': 'sin energía eléctrica',
    los: 'sin señal de fibra óptica',
  };
  return map[String(status).toLowerCase()] || status || 'desconocido';
}

function translateSignal(signal) {
  const map = {
    'very good': 'muy buena',
    warning: 'baja (en advertencia)',
    critical: 'muy baja (nivel crítico)',
  };
  const key = String(signal).toLowerCase();
  if (map[key]) return map[key];
  return 'sin lectura de señal';
}

// SmartOLT manda algo como "2026-09-02 02:45:47.425187" — lo
// convertimos a algo legible como "2 de septiembre, 2:45 a. m."
function formatLastStatusChange(rawDate) {
  if (!rawDate || rawDate === 'N/D') return 'sin datos recientes';

  const cleaned = rawDate.split('.')[0].replace(' ', 'T');
  const date = new Date(cleaned);
  if (isNaN(date.getTime())) return rawDate;

  // "8 de octubre, 10:00 a. m." → "8 de octubre a las 10:00 a. m."
  // (termina en "m.": no ponerlo al final de una frase con otro punto)
  return date
    .toLocaleString('es-CO', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/,\s*/, ' a las ');
}

/**
 * Envía el comando de reinicio remoto a la ONU de un abonado.
 * @param {string} abonado
 * @returns {Promise<boolean>} true si SmartOLT confirmó que el comando fue enviado
 */
async function rebootOnu(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) {
    console.warn(`⚠️  Prefijo de abonado no reconocido para reinicio SmartOLT: ${abonado}`);
    return false;
  }

  const { baseUrl, apiKeys } = getCityConfig(city);
  if (!baseUrl || apiKeys.length === 0) return false;

  const entries = await getCityOnuList(city);
  const match = findOnuInList(entries, abonado);
  if (!match) return false;

  try {
    const response = await axios.post(
      `${baseUrl}/api/onu/reboot/${encodeURIComponent(match.externalId)}`,
      {},
      { headers: { 'X-Token': match.apiKey }, validateStatus: (s) => s === 200 || s === 400 }
    );
    const success = response.status === 200 && response.data?.status === true;
    console.log(`🔄 Reinicio ONU (${abonado}): ${success ? 'comando enviado' : 'falló'} — respuesta: ${JSON.stringify(response.data)}`);
    return success;
  } catch (err) {
    console.warn(`⚠️  Error reiniciando ONU en SmartOLT:`, err.message);
    return false;
  }
}

/**
 * Consulta el plan (perfil de velocidad) configurado en SmartOLT para
 * la ONU de un abonado. Siempre se usa el de "download" para comparar
 * contra los test de velocidad del cliente, tal como se acordó.
 * @param {string} abonado
 * @returns {Promise<{ uploadProfile: string, downloadProfile: string } | null>}
 */
async function getOnuSpeedProfiles(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) return null;

  const { baseUrl, apiKeys } = getCityConfig(city);
  if (!baseUrl || apiKeys.length === 0) return null;

  const entries = await getCityOnuList(city);
  const match = findOnuInList(entries, abonado);
  if (!match) return null;

  try {
    const response = await axios.get(
      `${baseUrl}/api/onu/get_onu_speed_profiles/${encodeURIComponent(match.externalId)}`,
      { headers: { 'X-Token': match.apiKey }, validateStatus: (s) => s === 200 || s === 400 }
    );

    if (response.status !== 200 || !response.data?.status) return null;

    return {
      uploadProfile: response.data.upload_speed_profile_name,
      downloadProfile: response.data.download_speed_profile_name,
    };
  } catch (err) {
    console.warn(`⚠️  Error consultando perfil de velocidad en SmartOLT:`, err.message);
    return null;
  }
}

/**
 * Consulta el estado del puerto de TV (CATV) de la ONU de un abonado.
 * Confirmado con la documentación completa de SmartOLT: el campo es
 * "catv_status", con valores "Enabled" / "Disabled" / "CATV not
 * supported by ONU-Type".
 *
 * @param {string} abonado
 * @returns {Promise<'enabled'|'disabled'|'unsupported'|null>}
 */
async function getOnuCatvStatus(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) return null;

  const { baseUrl, apiKeys } = getCityConfig(city);
  if (!baseUrl || apiKeys.length === 0) return null;

  const entries = await getCityOnuList(city);
  const match = findOnuInList(entries, abonado);
  if (!match) return null;

  try {
    const response = await axios.get(`${baseUrl}/api/onu/get_onus_catv_statuses`, {
      headers: { 'X-Token': match.apiKey },
      validateStatus: (s) => s === 200 || s === 400,
    });

    if (response.status !== 200 || !response.data?.status) return null;

    const list = response.data.response || [];
    const entry = list.find((e) => e.unique_external_id === match.externalId);

    if (!entry) {
      console.warn(`⚠️  No se encontró el ONU ${match.externalId} dentro de get_onus_catv_statuses`);
      return null;
    }

    console.log(`📺 CATV status crudo (${abonado}):`, JSON.stringify(entry));

    const raw = String(entry.catv_status || '').toLowerCase();
    if (raw.includes('disab')) return 'disabled';
    if (raw.includes('not supported')) return 'unsupported';
    if (raw.includes('enab')) return 'enabled';

    console.warn(`⚠️  Campo catv_status con valor inesperado: "${entry.catv_status}"`);
    return null;
  } catch (err) {
    console.warn(`⚠️  Error consultando estado CATV en SmartOLT:`, err.message);
    return null;
  }
}

/**
 * Enciende (habilita) el puerto de TV (CATV) de la ONU de un abonado.
 * @param {string} abonado
 * @returns {Promise<boolean>}
 */
async function enableOnuCatv(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) return false;

  const { baseUrl, apiKeys } = getCityConfig(city);
  if (!baseUrl || apiKeys.length === 0) return false;

  const entries = await getCityOnuList(city);
  const match = findOnuInList(entries, abonado);
  if (!match) return false;

  try {
    const response = await axios.post(
      `${baseUrl}/api/onu/enable_catv/${encodeURIComponent(match.externalId)}`,
      {},
      { headers: { 'X-Token': match.apiKey }, validateStatus: (s) => s === 200 || s === 400 }
    );
    const success = response.status === 200 && response.data?.status === true;
    console.log(`📺 Enable CATV (${abonado}): ${success ? 'encendido' : 'falló'} — respuesta: ${JSON.stringify(response.data)}`);
    return success;
  } catch (err) {
    console.warn(`⚠️  Error encendiendo CATV en SmartOLT:`, err.message);
    return false;
  }
}

async function fetchOnuGraph(abonado, path, graphType) {
  const city = getCityFromAbonado(abonado);
  if (!city) return null;

  const { baseUrl, apiKeys } = getCityConfig(city);
  if (!baseUrl || apiKeys.length === 0) return null;

  const entries = await getCityOnuList(city);
  const match = findOnuInList(entries, abonado);
  if (!match) return null;

  try {
    const response = await axios.get(
      `${baseUrl}${path}/${encodeURIComponent(match.externalId)}/${graphType}`,
      {
        headers: { 'X-Token': match.apiKey },
        responseType: 'arraybuffer',
        validateStatus: (s) => s === 200 || s === 400,
      }
    );

    if (response.status !== 200) return null; // sin gráfico disponible aún, o ID no encontrado
    return Buffer.from(response.data);
  } catch (err) {
    console.warn(`⚠️  Error trayendo gráfico de SmartOLT (${path}):`, err.message);
    return null;
  }
}

/**
 * Trae el gráfico de tráfico (PNG) de la ONU de un abonado.
 * @param {string} abonado
 * @param {'hourly'|'daily'|'weekly'|'monthly'|'yearly'} graphType
 * @returns {Promise<Buffer|null>}
 */
async function getOnuTrafficGraph(abonado, graphType = 'daily') {
  return fetchOnuGraph(abonado, '/api/onu/get_onu_traffic_graph', graphType);
}

/**
 * Trae el gráfico de señal (PNG) de la ONU de un abonado.
 * @param {string} abonado
 * @param {'hourly'|'daily'|'weekly'|'monthly'|'yearly'} graphType
 * @returns {Promise<Buffer|null>}
 */
async function getOnuSignalGraph(abonado, graphType = 'daily') {
  return fetchOnuGraph(abonado, '/api/onu/get_onu_signal_graph', graphType);
}


// ---------------------------------------------------------------
// Cambio de contraseña WiFi
// ---------------------------------------------------------------
// El bot lo intenta con cualquier ONU que esté Online. Qué modelos sirven
// y cuáles no se aprende de los intentos reales (ver wifiCompat.js).
const PUERTO_24 = 'wifi_0/1';
const PUERTO_5 = 'wifi_0/5';
const PUERTO_BANDA = { '24': PUERTO_24, '5': PUERTO_5 };

async function ubicarOnu(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) return null;
  const { baseUrl, apiKeys } = getCityConfig(city);
  if (!baseUrl || apiKeys.length === 0) return null;
  const match = findOnuInList(await getCityOnuList(city), abonado);
  return match ? { baseUrl, ...match } : null;
}

function leerPuertosWifi(det) {
  const puertos = {};
  (Array.isArray(det?.wifi_ports) ? det.wifi_ports : []).forEach((p) => {
    if (p && p.port) puertos[p.port] = { ssid: p.ssid || null, dhcp: p.dhcp || null };
  });
  return puertos;
}

/**
 * Lee la ONU antes de cambiar la clave.
 * @returns {Promise<{ok:false, motivo:string} | {ok:true, modelo, modo, bandas:string[]|null, puertos:object}>}
 *   motivo: no_encontrada | sin_respuesta | offline
 *   bandas: ['24','5'] / ['24'] según los puertos que reporta SmartOLT; null si no reporta ninguno
 */
async function revisarCambioWifi(abonado) {
  const onu = await ubicarOnu(abonado);
  if (!onu) return { ok: false, motivo: 'no_encontrada' };

  const [statusData, detailData] = await Promise.all([
    fetchOnuField(onu.baseUrl, onu.apiKey, onu.externalId, '/api/onu/get_onu_status'),
    fetchOnuField(onu.baseUrl, onu.apiKey, onu.externalId, '/api/onu/get_onu_details'),
  ]);
  const det = detailData?.onu_details;
  if (!statusData || !det) return { ok: false, motivo: 'sin_respuesta' };

  const modelo = String(det.onu_type_name || 'DESCONOCIDO').toUpperCase();
  const puertos = leerPuertosWifi(det);
  const nombres = Object.keys(puertos);
  const bandas = nombres.length === 0 ? null : nombres.includes(PUERTO_5) ? ['24', '5'] : ['24'];
  console.log(
    `📶 Cambio WiFi ${abonado}: estado=${statusData.onu_status}, modo=${det.mode}, modelo=${modelo}, puertos=${nombres.join(',') || 'sin reportar'}`
  );

  if (String(statusData.onu_status || '').toLowerCase() !== 'online') return { ok: false, motivo: 'offline' };
  return { ok: true, modelo, modo: det.mode || null, bandas, puertos };
}

/**
 * Cambia la contraseña de una banda (WPA2), reenviando el SSID y el DHCP
 * actuales cuando SmartOLT los reporta, y después verifica que el SSID
 * no haya cambiado. NUNCA se loguea la contraseña.
 * @returns {Promise<{ok:boolean, respuesta:string|null, puerto:string, ssidConservado:boolean|null}>}
 */
async function cambiarClaveWifi(abonado, banda, password, puertos = {}) {
  const puerto = PUERTO_BANDA[banda];
  const onu = await ubicarOnu(abonado);
  if (!puerto || !onu) return { ok: false, respuesta: 'ONU no encontrada', puerto, ssidConservado: null };

  const antes = puertos[puerto] || {};
  const form = new URLSearchParams({ wifi_port: puerto, password, authentication_mode: 'WPA2' });
  if (antes.ssid) form.set('ssid', antes.ssid);
  if (antes.dhcp) form.set('dhcp', antes.dhcp);

  let ok = false;
  let respuesta = null;
  try {
    const response = await axios.post(
      `${onu.baseUrl}/api/onu/set_wifi_port_lan/${encodeURIComponent(onu.externalId)}`,
      form.toString(),
      {
        headers: { 'X-Token': onu.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: (st) => st === 200 || st === 400,
      }
    );
    ok = response.status === 200 && response.data?.status === true;
    respuesta = response.data?.response || response.data?.error || `HTTP ${response.status}`;
  } catch (err) {
    respuesta = err.message;
  }

  // Verificación: ¿el SSID sigue igual? (solo si SmartOLT lo reportaba antes)
  let ssidConservado = null;
  if (ok && antes.ssid) {
    const det = await fetchOnuField(onu.baseUrl, onu.apiKey, onu.externalId, '/api/onu/get_onu_details');
    const despues = leerPuertosWifi(det?.onu_details)[puerto];
    if (despues && despues.ssid) ssidConservado = despues.ssid === antes.ssid;
  }
  if (ssidConservado === false) ok = false; // la clave cambió pero la red quedó con otro nombre: lo arregla MDA

  console.log(`📶 Cambio WiFi ${abonado} ${puerto}: ${ok ? 'OK' : 'falló'} — ${respuesta}${ssidConservado === false ? ' (SSID cambió)' : ''}`);
  return { ok, respuesta, puerto, ssidConservado };
}

// ---------------------------------------------------------------
// Tablero de gestión de clientes
// ---------------------------------------------------------------
const ABONADO_RE = /\b(IBA|DOR|PTO|VDR|LP)\d{3,}\b/i;

/**
 * ONUs del mismo puerto PON (misma OLT, board y puerto), de la lista cacheada.
 * El estado es el del último refresco de la lista (máximo 1 hora).
 */
async function vecinosPon(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) return null;
  const entries = await getCityOnuList(city);
  const yo = findOnuInList(entries, abonado);
  if (!yo || yo.board == null || yo.port == null) return null;
  const vecinos = entries.filter((e) => e !== yo && e.oltName === yo.oltName && e.board === yo.board && e.port === yo.port);
  const st = (e) => String(e.status || '').toLowerCase();
  const sg = (e) => String(e.signal || '').toLowerCase();
  const conProblema = vecinos
    .filter((e) => (st(e) && st(e) !== 'online') || sg(e) === 'warning' || sg(e) === 'critical')
    .map((e) => ({
      abonado: (e.name.match(ABONADO_RE) || [null])[0]?.toUpperCase() || null,
      nombre: e.name,
      estado: e.status || null,
      estadoTexto: translateStatus(e.status),
      senal: e.signal || null,
      senalTexto: e.signal ? translateSignal(e.signal) : null,
      senal1310: e.signal1310,
      senal1490: e.signal1490,
    }));
  const cuenta = (f) => vecinos.filter(f).length;
  return {
    olt: yo.oltName,
    board: yo.board,
    puerto: yo.port,
    total: vecinos.length,
    enLinea: cuenta((e) => st(e) === 'online'),
    los: cuenta((e) => st(e) === 'los'),
    sinEnergia: cuenta((e) => st(e) === 'power fail'),
    desconectadas: cuenta((e) => st(e) === 'offline'),
    senalMala: cuenta((e) => sg(e) === 'warning' || sg(e) === 'critical'),
    conProblema,
    actualizadoEn: cache[city]?.fetchedAt ? new Date(cache[city].fetchedAt).toISOString() : null,
  };
}

/**
 * Ficha técnica de la ONU de un abonado, en vivo desde SmartOLT.
 * @returns {Promise<{encontrada:false}|object>}
 */
async function fichaOnu(abonado) {
  const onu = await ubicarOnu(abonado);
  if (!onu) return { encontrada: false };
  const campo = (path) => fetchOnuField(onu.baseUrl, onu.apiKey, onu.externalId, path);
  const [statusData, signalData, detailData, perfiles, catv] = await Promise.all([
    campo('/api/onu/get_onu_status'),
    campo('/api/onu/get_onu_signal'),
    campo('/api/onu/get_onu_details'),
    getOnuSpeedProfiles(abonado).catch(() => null),
    getOnuCatvStatus(abonado).catch(() => null),
  ]);
  const det = detailData?.onu_details || null;
  const puertos = leerPuertosWifi(det);
  const nombres = Object.keys(puertos);
  const status = statusData?.onu_status || '';
  const signal = signalData?.onu_signal || '';
  return {
    encontrada: true,
    ciudad: getCityFromAbonado(abonado),
    ubicacion: { olt: onu.oltName, board: onu.board, puerto: onu.port },
    estado: status || null,
    estadoTexto: status ? translateStatus(status) : 'sin respuesta de SmartOLT',
    ultimoCambio: statusData?.last_status_change || null,
    ultimoCambioTexto: statusData ? formatLastStatusChange(statusData.last_status_change) : null,
    senal: signal || null,
    senalTexto: signalData ? translateSignal(signal) : null,
    senalValor: signalData?.onu_signal_value || null,
    senal1490: signalData?.onu_signal_1490 || null, // recibido por la ONU (bajada)
    senal1310: signalData?.onu_signal_1310 || null, // leído en la OLT (subida)
    modelo: det?.onu_type_name ? String(det.onu_type_name).toUpperCase() : null,
    modo: det?.mode || null,
    serial: det?.sn || null,
    nombre: det?.name || null,
    zona: det?.zone_name || null,
    bandasWifi: det ? (nombres.length === 0 ? null : nombres.includes(PUERTO_5) ? ['24', '5'] : ['24']) : null,
    // SSID de cada banda (sin contraseñas: SmartOLT no las devuelve y no se piden)
    redesWifi: nombres.map((p) => ({ banda: p === PUERTO_5 ? '5' : p === PUERTO_24 ? '24' : p, puerto: p, ssid: puertos[p].ssid })),
    catv, // enabled | disabled | unsupported | null
    perfil: perfiles ? { subida: perfiles.uploadProfile || null, bajada: perfiles.downloadProfile || null } : null,
  };
}

/** OLT, board y puerto PON de la ONU de un abonado (de la lista cacheada). */
async function ubicacionOnu(abonado) {
  const city = getCityFromAbonado(abonado);
  if (!city) return null;
  const match = findOnuInList(await getCityOnuList(city), abonado);
  if (!match) return null;
  return { city, oltName: match.oltName, board: match.board, port: match.port };
}

module.exports = {
  vecinosPon,
  fichaOnu,
  ubicacionOnu,
  revisarCambioWifi,
  cambiarClaveWifi,
  ubicarOnu,
  fetchOnuField,
  getCityFromAbonado,
  getOnuSignal,
  translateStatus,
  translateSignal,
  formatLastStatusChange,
  rebootOnu,
  getOnuSpeedProfiles,
  getOnuCatvStatus,
  enableOnuCatv,
  getOnuTrafficGraph,
  getOnuSignalGraph,
};
