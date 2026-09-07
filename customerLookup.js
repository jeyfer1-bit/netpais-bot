// customerLookup.js
//
// Busca un cliente EN VIVO llamando a un flujo de Power Automate
// (disparado por HTTP) que consulta directamente el Excel en
// SharePoint por cédula o número de abonado.
//
// ⚠️ IMPORTANTE — contrato de respuesta esperado: el flujo debe
// devolver SIEMPRE un arreglo bajo la clave "matches", ej:
//   { "matches": [ { documento, nro_abonado, nombre, estado, barrio, zona }, ... ] }
// - 0 elementos → no se encontró nada
// - 1 elemento → coincidencia única (lo normal al buscar por abonado,
//   que es único)
// - 2+ elementos → varios abonados asociados a la misma cédula (puede
//   pasar al buscar por cédula)
//
// Esto es un cambio respecto al diseño original del flujo (que usaba
// "Obtener una fila" y devolvía un solo objeto). Para soportar varios
// abonados por cédula, el flujo de Power Automate debe cambiar esa
// acción por "Enumerar filas presentes en una tabla" con un filtro por
// documento/abonado, y envolver el resultado en "matches".

const axios = require('axios');

/**
 * Busca un cliente por cédula (documento) o número de abonado.
 * @param {string} idOrAbonado - lo que el cliente escribió
 * @returns {Promise<object[]>} arreglo de coincidencias (puede estar vacío)
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

  const rows = response.data?.matches || [];

  return rows
    .filter((row) => row && row.documento)
    .map((row) => ({
      documento: String(row.documento ?? ''),
      abonado: String(row.nro_abonado ?? ''),
      nombre: String(row.nombre ?? ''),
      estado: String(row.estado ?? ''),
      barrio: String(row.barrio ?? ''),
      zona: String(row.zona ?? ''),
    }));
}

module.exports = { findCustomer };
