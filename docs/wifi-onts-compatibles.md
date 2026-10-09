# ONTs compatibles con el cambio de clave WiFi desde el bot

Un modelo entra a `wifiCompatibles.js` solo después de una prueba en caliente exitosa.
Compras nuevas: solo ZTE. Marcas que se esperan compatibles (por confirmar modelo a modelo):
ZTE, Bestcom, ADC, algunas Latic y Huawei.

## Cómo probar un modelo

1. Agregar el abonado de prueba en Railway: `WIFI_ABONADOS_PRUEBA=IBAxxxxxx` (separados por comas).
2. Antes: `railway run node scripts/wifi_diag.js IBAxxxxxx` → anotar `onu_type_name`, modo y `wifi_ports` (SSID actual).
3. Hacer el flujo por WhatsApp con ese abonado (opción 7) en la(s) banda(s) que tenga.
4. Verificar en sitio: el SSID no cambió, la clave nueva funciona en 2,4 y/o 5 GHz.
5. Después: correr de nuevo `wifi_diag.js` y comparar.
6. Pasar el resultado → se agrega el modelo (o se descarta) y se quita el abonado de `WIFI_ABONADOS_PRUEBA`.

## Registro de pruebas

| Fecha | Marca | onu_type_name | Abonado | Bandas | SSID conservado | Clave aplicada | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
