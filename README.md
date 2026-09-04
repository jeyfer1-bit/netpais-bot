# netpais-bot — Bot de soporte por WhatsApp

Bot de atención al cliente construido sobre la WhatsApp Cloud API (Meta), con Node.js + Express.

## 1. Instalación local

```bash
npm install
cp .env.example .env
```

Abre `.env` y llena:
- `WHATSAPP_TOKEN`: el token que copiaste del panel de Meta (Paso 1. Pruébalo → "Generar token").
- `PHONE_NUMBER_ID`: el que aparece en el panel (ej: `1359415357249667`).
- `VERIFY_TOKEN`: invéntate cualquier palabra, ej: `mi_token_secreto_123`. La vas a necesitar en el paso 3.

## 2. Correrlo local

```bash
npm run dev
```

Debería mostrar: `🚀 Servidor escuchando en el puerto 3000`

## 3. Exponerlo a internet con ngrok (para probar sin desplegar todavía)

Instala ngrok si no lo tienes: https://ngrok.com/download

```bash
ngrok http 3000
```

Te va a dar una URL tipo `https://abcd-1234.ngrok-free.app`. Esa es tu URL pública temporal.

## 4. Configurar el webhook en el panel de Meta

En **Casos de uso → Conectar en WhatsApp → Paso 2: Configuración de producción → Configurar webhooks**:

- **URL de devolución de llamada**: `https://abcd-1234.ngrok-free.app/webhook` (tu URL de ngrok + `/webhook`)
- **Token de verificación**: el mismo valor que pusiste en `VERIFY_TOKEN` dentro de tu `.env`
- Clic en **"Verificar y guardar"**

Si todo está bien, en la consola de tu servidor vas a ver: `✅ Webhook verificado correctamente`

## 5. Probar el bot

Desde tu WhatsApp (el número que verificaste como destinatario de prueba), mándale un mensaje al número de prueba de Meta. Deberías ver en tu consola el mensaje recibido, y el bot te debería responder automáticamente.

## 6. Desplegar en Railway (para tener una URL permanente)

1. Sube este proyecto a un repositorio de GitHub (sin el archivo `.env`, el `.gitignore` ya lo excluye).
2. Entra a [railway.app](https://railway.app) y crea un proyecto nuevo → **"Deploy from GitHub repo"**.
3. Selecciona tu repositorio.
4. En la pestaña **Variables**, agrega las mismas variables de tu `.env`: `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `VERIFY_TOKEN`.
5. Railway te va a dar una URL pública fija, tipo `https://netpais-bot-production.up.railway.app`.
6. Vuelve al panel de Meta y actualiza la **URL de devolución de llamada** por esa URL de Railway + `/webhook`, dejando el mismo `VERIFY_TOKEN`.

## Próximos pasos sugeridos

- Reemplazar la función `buildReply()` en `server.js` con tu lógica real de soporte (o conectarla a un LLM).
- Generar un **token permanente** (System User token) en vez del temporal de 24h, para que el bot no se caiga cada día.
- Completar la verificación del negocio en Meta y conectar tu número real de WhatsApp (no el de prueba) cuando estés listo para producción.
