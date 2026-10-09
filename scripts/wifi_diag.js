// scripts/wifi_diag.js — diagnóstico para probar en caliente el cambio de clave WiFi.
//
// Uso (desde la carpeta del bot, con las variables de Railway):
//   railway run node scripts/wifi_diag.js IBA015859
//
// Muestra lo que el bot ve de la ONU (estado, modo, modelo, puertos WiFi)
// y si hoy el bot permitiría el cambio. No cambia nada en la ONU.
// Las contraseñas que reporte SmartOLT se ocultan.
const { ubicarOnu, fetchOnuField, revisarCambioWifi } = require('../smartolt');
const { configModelo, esAbonadoPrueba } = require('../wifiCompatibles');

function ocultar(obj) {
  return JSON.parse(JSON.stringify(obj || {}, (k, v) => (/pass|key|psk|secret/i.test(k) && v ? '***' : v)));
}

(async () => {
  const abonado = String(process.argv[2] || '').trim().toUpperCase();
  if (!abonado) {
    console.log('Uso: railway run node scripts/wifi_diag.js <abonado>');
    process.exit(1);
  }
  const onu = await ubicarOnu(abonado);
  if (!onu) {
    console.log(`No encontré la ONU de ${abonado} en SmartOLT (o faltan variables de esa ciudad).`);
    process.exit(1);
  }
  const [st, det] = await Promise.all([
    fetchOnuField(onu.baseUrl, onu.apiKey, onu.externalId, '/api/onu/get_onu_status'),
    fetchOnuField(onu.baseUrl, onu.apiKey, onu.externalId, '/api/onu/get_onu_details'),
  ]);
  const d = det?.onu_details || {};
  console.log('==== ONU', abonado);
  console.log('external_id   :', onu.externalId);
  console.log('estado        :', st?.onu_status);
  console.log('modo          :', d.mode);
  console.log('onu_type_name :', d.onu_type_name);
  console.log('sn            :', d.sn);
  console.log('en la lista   :', JSON.stringify(configModelo(d.onu_type_name)));
  console.log('abonado prueba:', esAbonadoPrueba(abonado));
  console.log('wifi_ports    :', JSON.stringify(ocultar(d.wifi_ports), null, 2));
  console.log('==== ¿El bot permitiría el cambio hoy?');
  console.log(JSON.stringify(ocultar(await revisarCambioWifi(abonado)), null, 2));
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
