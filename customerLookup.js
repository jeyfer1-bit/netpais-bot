// customerLookup.js
//
// Guarda en memoria los datos de clientes que llegan desde Power
// Automate (vía el endpoint POST /excel-sync?source=XXX en server.js),
// y permite buscar un cliente por cédula (documento) o número de
// abonado, combinando todas las fuentes/zonas.

const dataBySource = {}; // { centro: [...], norte: [...] }
const lastSyncBySource = {}; // { centro: Date, norte: Date }

/**
 * Reemplaza los datos de una fuente/zona específica.
 * Se llama desde el endpoint /excel-sync cada vez que Power Automate
 * manda una actualización de esa tabla.
 * @param {string} source - identificador de la fuente (ej: "centro", "norte")
 * @param {Array<object>} rows - filas tal como las manda "Listar filas
 *   presentes en una tabla" de Power Automate
 */
function setCustomers(source, rows) {
  if (!Array.isArray(rows)) {
    throw new Error('Se esperaba un arreglo de filas');
  }
  dataBySource[source] = rows;
  lastSyncBySource[source] = new Date();
  console.log(
    `🔄 Excel sincronizado (${source}): ${rows.length} filas (${lastSyncBySource[source].toISOString()})`
  );
}

function getSyncStatus() {
  const sources = Object.keys(dataBySource).map((source) => ({
    source,
    totalCustomers: dataBySource[source].length,
    lastSyncAt: lastSyncBySource[source],
  }));
  return { sources };
}

function getAllCustomers() {
  return Object.values(dataBySource).flat();
}

/**
 * Busca un cliente por cédula (documento) o número de abonado, en
 * todas las fuentes/zonas combinadas.
 * @param {string} idOrAbonado - lo que el cliente escribió
 * @returns {Promise<object|null>}
 */
async function findCustomer(idOrAbonado) {
  const query = String(idOrAbonado).trim().toLowerCase();
  const allCustomers = getAllCustomers();

  const match = allCustomers.find((row) => {
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

module.exports = { findCustomer, setCustomers, getSyncStatus };
