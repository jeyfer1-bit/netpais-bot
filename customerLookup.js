// customerLookup.js
//
// Busca un cliente EN VIVO llamando a un flujo de Power Automate
// (disparado por HTTP) que consulta el modelo de Power BI "Reporte
// SaePlus" con DAX, por cédula o número de abonado.
//
// ⚠️ IMPORTANTE — contrato de respuesta esperado: el flujo devuelve
// SIEMPRE un arreglo bajo la clave "matches", ej:
//   { "matches": [ { documento, nro_abonado, nombre, estado, barrio, zona, nombre_franq }, ... ] }
// - 0 elementos → no se encontró nada
// - 1 elemento → coincidencia única (lo normal al buscar por abonado)
// - 2+ elementos → varios abonados asociados a la misma cédula
//
// Como el valor que escribe el cliente termina DENTRO de la consulta
// DAX, se limpia antes con limpiarId(): solo letras y números, 3 a 20
// caracteres. Si no pasa, ni siquiera se llama al flujo.

const axios = require('axios');

const ID_MIN = 3;
const ID_MAX = 20;

/**
 * Normaliza una cédula o número de abonado antes de mandarlo a Power
 * Automate: quita todo lo que no sea letra o número (espacios, puntos,
 * guiones, comillas…) y pasa a mayúsculas.
 *   "1.234.567"   -> "1234567"
 *   " iba-015859" -> "IBA015859"
 * @param {*} valor
 * Además exige al menos un dígito (toda cédula/abonado lo tiene), así
 * respuestas como "hola" o "gracias" no disparan una consulta.
 * @returns {string|null} el id limpio, o null si no es válido
 */
function limpiarId(valor) {
  const limpio = String(valor ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (limpio.length < ID_MIN || limpio.length > ID_MAX) return null;
  if (!/[0-9]/.test(limpio)) return null;
  return limpio;
}

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

  const id = limpiarId(idOrAbonado);
  if (!id) {
    console.warn(`🔎 Búsqueda de cliente descartada: "${String(idOrAbonado).slice(0, 40)}" no es un documento/abonado válido`);
    return [];
  }

  const response = await axios.post(
    flowUrl,
    { query: id },
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

module.exports = { findCustomer, limpiarId };
