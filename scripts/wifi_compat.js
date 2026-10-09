// scripts/wifi_compat.js — lista de compatibilidad de ONUs para el cambio de clave WiFi,
// aprendida de los intentos reales del bot.
//   railway run node scripts/wifi_compat.js
const wifiCompat = require('../wifiCompat');
const db = require('../db');

(async () => {
  if (!db.activa()) {
    console.log('Falta DATABASE_URL (córrelo con railway run).');
    process.exit(1);
  }
  const filas = await wifiCompat.resumen();
  if (filas.length === 0) console.log('Todavía no hay intentos registrados.');
  console.table(
    filas.map((r) => ({
      modelo: r.modelo,
      banda: r.banda === '24' ? '2,4 GHz' : '5 GHz',
      estado: r.estado,
      exitos: Number(r.exitos),
      fallos: Number(r.fallos),
      ssid_perdido: Number(r.ssid_perdido),
      ultimo: r.ultimo ? new Date(r.ultimo).toISOString().slice(0, 10) : '',
      ultimo_error: (r.ultimo_error || '').slice(0, 60),
    }))
  );
  console.log(`Se descarta un modelo/banda con ${wifiCompat.FALLOS_PARA_DESCARTAR} fallos y ningún éxito.`);
  await db.pool().end();
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
