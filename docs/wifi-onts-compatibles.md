# Cambio de clave WiFi: compatibilidad de ONUs

El bot intenta el cambio con **cualquier ONU que esté Online** y guarda cada intento
(modelo `onu_type_name`, banda, resultado, si se conservó el SSID) en `bot_wifi_intentos`.

- **Compatible**: el modelo/banda tiene al menos un cambio exitoso → se sigue intentando.
- **No compatible**: 3 fallos (`WIFI_FALLOS_PARA_DESCARTAR`) y ningún éxito → el bot ya no lo intenta y va directo a MDA.
- **En prueba**: menos de 3 fallos y ningún éxito → se intenta; si falla, va a MDA.
- Si la clave cambia pero SmartOLT reporta otro SSID después, cuenta como **fallo** y va a MDA.

Ver la lista: `railway run node scripts/wifi_compat.js`
Diagnóstico de una ONU: `railway run node scripts/wifi_diag.js <abonado>`

Marcas que se esperan compatibles (por confirmar con los datos): ZTE, Bestcom, ADC, algunas Latic y Huawei.
Compras nuevas: solo ZTE.
