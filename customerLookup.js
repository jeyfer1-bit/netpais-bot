// customerLookup.js
//
// Esta función busca un cliente por cédula o número de abonado.
// HOY: devuelve datos simulados (para poder probar el flujo completo).
// DESPUÉS: aquí se conecta la API de Microsoft Graph para leer el
// Excel Online real. Cuando tengamos las credenciales de Azure y la
// estructura exacta del archivo, reemplazamos el contenido de esta
// función sin tocar el resto del bot.

// Datos de prueba — bórralos cuando conectemos el Excel real.
const MOCK_CUSTOMERS = [
  {
    documento: '123456789',
    abonado: 'AB001',
    nombre: 'Jeyfer Rojas',
    estado: 'Activo', // Activo | Cortado | Retirado | Retirado M
  },
  {
    documento: '987654321',
    abonado: 'AB002',
    nombre: 'Maria Gomez',
    estado: 'Cortado',
  },
  {
    documento: '111222333',
    abonado: 'AB003',
    nombre: 'Carlos Perez',
    estado: 'Retirado',
  },
];

/**
 * Busca un cliente por cédula o número de abonado.
 * @param {string} idOrAbonado - lo que el cliente escribió (cédula o abonado)
 * @returns {Promise<object|null>} el cliente encontrado, o null si no existe
 */
async function findCustomer(idOrAbonado) {
  const query = String(idOrAbonado).trim().toLowerCase();

  // TODO: reemplazar este bloque por una llamada real a Microsoft Graph
  // (Excel Online) cuando tengamos las credenciales de Azure AD.
  const match = MOCK_CUSTOMERS.find(
    (c) =>
      c.documento.toLowerCase() === query ||
      c.abonado.toLowerCase() === query
  );

  return match || null;
}

module.exports = { findCustomer };
