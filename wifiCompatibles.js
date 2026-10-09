// wifiCompatibles.js
//
// Modelos de ONU con los que YA se probó en caliente el cambio de
// contraseña WiFi desde el bot (SmartOLT set_wifi_port_lan).
// La llave es el onu_type_name EXACTO que muestra SmartOLT
// (node scripts/wifi_diag.js <abonado> lo imprime).
//   bandas: 'dual' (2,4 y 5 GHz) | '24' (solo 2,4 GHz)
//   puerto5: puerto de 5 GHz si no es wifi_0/5 (opcional)
// Cada modelo nuevo se agrega SOLO después de una prueba exitosa,
// registrada en docs/wifi-onts-compatibles.md.
//
// En Railway también se pueden sumar modelos sin desplegar con
// WIFI_ONU_MODELOS=MODELO:dual,OTRO:24 (se suman a esta lista).
//
// Pruebas en caliente: los abonados en WIFI_ABONADOS_PRUEBA (separados
// por comas) pueden hacer el cambio aunque su modelo no esté en la lista,
// para poder probar modelos nuevos sin abrirlo a todos los clientes.

const MODELOS = {
  // 'ZTE-F670L': { bandas: 'dual' },   ← ejemplo de formato, aún sin probar
};

const PUERTO_24 = 'wifi_0/1';
const PUERTO_5 = 'wifi_0/5';

function modelosDesdeEnv() {
  const extra = {};
  String(process.env.WIFI_ONU_MODELOS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((item) => {
      const [modelo, bandas] = item.split(':').map((x) => (x || '').trim());
      if (modelo) extra[modelo.toUpperCase()] = { bandas: (bandas || '24').toLowerCase() === 'dual' ? 'dual' : '24' };
    });
  return extra;
}

/** Config del modelo ({ bandas, puertos }) o null si no está probado. */
function configModelo(onuTypeName) {
  const nombre = String(onuTypeName || '').trim().toUpperCase();
  const todos = { ...modelosDesdeEnv() };
  Object.entries(MODELOS).forEach(([k, v]) => { todos[k.toUpperCase()] = v; });
  const cfg = todos[nombre];
  if (!cfg) return null;
  return { bandas: cfg.bandas === 'dual' ? 'dual' : '24', puertos: { '24': PUERTO_24, '5': cfg.puerto5 || PUERTO_5 } };
}

/** ¿Este abonado está habilitado para pruebas en caliente? */
function esAbonadoPrueba(abonado) {
  const lista = String(process.env.WIFI_ABONADOS_PRUEBA || '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  return lista.includes(String(abonado || '').trim().toUpperCase());
}

module.exports = { configModelo, esAbonadoPrueba, PUERTO_24, PUERTO_5 };
