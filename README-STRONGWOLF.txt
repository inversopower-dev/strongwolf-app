STRONGWOLF TRAINING CENTER - APP DE REVISION

COMO ABRIR LA APP

Opcion rapida:
1. Abre index.html con doble clic.
2. Si el navegador pregunta, permite ejecutar scripts locales.

Opcion con servidor local:
1. Abre start-strongwolf.bat con doble clic.
2. Deja abierta la ventana negra del servidor.
3. El navegador se abrira en http://127.0.0.1:4173/index.html

PIN DE PRUEBA

Perfil Alfa / Gerente:
111111

Perfil Cachorro / Recepcion:
222222

IMPORTANTE

La app funciona para revision desde esta carpeta. Los datos se guardan en el navegador
del computador usando localStorage. En esta version todavia no hay base de datos ni
conexion entre dispositivos.

NOVEDADES DE ESTA ENTREGA

- Gestion de usuarios demo: crear, eliminar logicamente y cambiar PIN.
- Exportacion de usuarios en CSV compatible con Excel.
- Informe ejecutivo descargable.
- Finanzas 360 con indicadores de liquidez, actividad, endeudamiento,
  rentabilidad e inductores de valor.
- Supuestos financieros editables para recalcular indicadores.

Cuando aprobemos pantallas y flujo, el siguiente paso recomendado es convertirla en
app web con backend, base de datos y autenticacion real para que varios dispositivos
puedan compartir la misma informacion.

ARCHIVOS PRINCIPALES

index.html              Entrada de la app
styles.css              Diseno visual Strongwolf
app.js                  Logica completa de la aplicacion
manifest.webmanifest    Configuracion de app instalable
sw.js                   Cache offline para servidor web
start-strongwolf.bat    Lanzador con servidor local
abrir-app-directo.bat   Apertura directa sin servidor
GUIA-PUBLICACION-MULTIDISPOSITIVO.txt
                        Ruta para llevarla a web, movil y WhatsApp
