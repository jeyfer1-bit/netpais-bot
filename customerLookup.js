// customerLookup.js
//
// Lee el archivo Excel (compartido vía enlace público de solo lectura
// en SharePoint) y busca un cliente por cédula (documento) o número de
// abonado (nro_abonado).
//
// Cómo funciona:
// 1. Descarga el archivo .xlsx desde el enlace guardado en la variable
//    de entorno EXCEL_SHARE_URL.
// 2. Lo cachea en memoria por unos minutos (para no descargarlo en
//    cada mensaje, lo cual sería lento e innecesario).
// 3. Busca en TODAS las hojas cuyo nombre empiece con "Usuarios"
//    (según tu archivo: "Usuarios SaePlus Centro", "Usuarios SaePlus
//    NorteS", etc.) — así cubrimos clientes de cualquier zona.
//
// Nota de seguridad: EXCEL_SHARE_URL es un enlace "cualquier persona
// con el vínculo puede ver". Trátalo como una contraseña: solo debe
// vivir en la variable de entorno de Railway, nunca en el código ni
// en GitHub.

const axios = require('axios');
const XLSX = require('xlsx');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

let cache = {
  data: null,
  fetchedAt: 0,
};

function toDownloadUrl(shareUrl) {
  // Los enlaces de SharePoint/OneDrive personal descargan el archivo
  // directamente si se les agrega este parámetro.
  if (shareUrl.includes('download=1')) return shareUrl;
  const separator = shareUrl.includes('?') ? '&' : '?';
  return `${shareUrl}${separator}download=1`;
}

async function fetchWorkbookRows() {
  const shareUrl = process.env.EXCEL_SHARE_URL;
  if (!shareUrl) {
    throw new Error('Falta la variable de entorno EXCEL_SHARE_URL');
  }

  const downloadUrl = toDownloadUrl(shareUrl);
  const response = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
  });

  const workbook = XLSX.read(response.data, { type: 'buffer' });

  // Junta las filas de todas las hojas que empiecen con "Usuarios"
  let allRows = [];
  for (const sheetName of workbook.SheetNames) {
    if (!sheetName.toLowerCase().startsWith('usuarios')) continue;
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    allRows = allRows.concat(rows);
  }

  return allRows;
}

async function getRows() {
  const isStale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (!cache.data || isStale) {
    cache.data = await fetchWorkbookRows();
    cache.fetchedAt = Date.now();
  }
  return cache.data;
}

/**
 * Busca un cliente por cédula (documento) o número de abonado.
 * @param {string} idOrAbonado - lo que el cliente escribió
 * @returns {Promise<object|null>}
 */
async function findCustomer(idOrAbonado) {
  const query = String(idOrAbonado).trim().toLowerCase();
  const rows = await getRows();

  const match = rows.find((row) => {
    const documento = String(row.documento ?? '').trim().toLowerCase();
    const abonado = String(row.nro_abonado ?? '').trim().toLowerCase();
    return documento === query || abonado === query;
  });

  if (!match) return null;

  return {
    documento: String(match.documento ?? ''),
    abonado: String(match.nro_abonado ?? ''),
    nombre: String(match.nombre ?? ''),
    estado: String(match.estado ?? ''),
    barrio: String(match.barrio ?? ''),
    zona: String(match.zona ?? ''),
  };
}

module.exports = { findCustomer };
