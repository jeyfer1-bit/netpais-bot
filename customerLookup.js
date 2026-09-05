// customerLookup.js
//
// Busca un cliente EN VIVO llamando a un flujo de Power Automate
// (disparado por HTTP) que consulta directamente el Excel en
// SharePoint por cédula o número de abonado, usando "Obtener una
// fila" — una búsqueda puntual y eficiente, sin importar que la
// tabla tenga decenas de miles de filas.

const axios = require('axios');

/**
 * Busca un cliente por cédula (documento) o número de abonado.
 * @param {string} idOrAbonado - lo que el cliente escribió
 * @returns {Promise<object|null>}
 */
async function findCustomer(idOrAbonado) {
  const flowUrl = process.env.POWER_AUTOMATE_LOOKUP_URL;
  if (!flowUrl) {
    throw new Error('Falta la variable de entorno POWER_AUTOMATE_LOOKUP_URL');
  }

  const response = await axios.post(
    flowUrl,
    { query: String(idOrAbonado).trim() },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const row = response.data;

  // El flujo devuelve un objeto vacío {} cuando no encontró nada.
  if (!row || !row.documento) {
    return null;
  }

  return {
    documento: String(row.documento ?? ''),
    abonado: String(row.nro_abonado ?? ''),
    nombre: String(row.nombre ?? ''),
    estado: String(row.estado ?? ''),
    barrio: String(row.barrio ?? ''),
    zona: String(row.zona ?? ''),
  };
}

module.exports = { findCustomer };
