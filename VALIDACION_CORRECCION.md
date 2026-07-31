# Validación de corrección CodeBrew Merch

Fecha: 2026-07-31

## Resultado

- Procesamiento del Excel: aprobado; se leyeron las cuatro pestañas requeridas.
- Productos válidos generados: 952.
- Excel original y Excel después de las pruebas: SHA-256 idéntico `dcda17321fa01088f0f42601efce56fcd0b1cb54840c87bea5d0f7f3e797b3ff`.
- Sintaxis: `app.js`, `sw.js` y `scripts/generate_products.py` aprobados.
- PWA: recursos del `APP_SHELL` presentes, rutas relativas y `start_url`/`scope` en `./`.

## Campañas y Paso 2

- Equivalencias aprobadas: `SI` y `SII` → `Summer`; `WC` → `World Cup`; `SP` → `Spring`; `WT` → `Winter`; `XM` → `Christmas`.
- Nombres completos aprobados: `Summer`, `World Cup`, `Spring`, `Winter` y `Christmas`.
- Mayúsculas, minúsculas y espacios exteriores: aprobados.
- Coincidencias incompletas o ambiguas (`S`, `W`, `SUM`) se rechazan.
- El código original se conserva en `campaignOriginal`; la presentación usa `campaign`.
- Búsqueda integrada aprobada para `SI`, `SII`, `Summer`, `WC`, `World Cup`, `SP`, `Spring`, `WT`, `Winter` y `Discovery`.
- Título aprobado: `Abre el botón correcto`.
- Instrucción aprobada: `Campaña / Menciona la campaña, su nombre homologado o Discovery.`
- Los valores originales de `botonPos`, incluido `DISCOVERY`, no se reescriben; solo se complementa su presentación.

## PDF Carta

Tamaño de etiqueta conservado: 2 × 1.5 pulgadas. Márgenes: 0.25 pulgadas. La prueba interceptó las coordenadas enviadas al generador PDF y verificó cada rectángulo contra el área imprimible de 8.5 × 11 pulgadas.

| Etiquetas | Páginas | Resultado |
|---:|---:|---|
| 1 | 1 | Completa y dentro de márgenes |
| 2 | 1 | Completas y alineadas |
| 18 | 1 | Sin corte inferior |
| 19 | 2 | Salto antes de la etiqueta 19 |
| 40 | 3 | Paginación correcta |

Límites máximos observados: borde derecho 7.33 pulgadas y borde inferior 9.65 pulgadas; ambos permanecen dentro de los límites imprimibles de 8.25 y 10.75 pulgadas.

## Limitaciones reales

- El Excel actual contiene campañas `SII`, `WC`, `SP` y `WT`; no contiene filas `SI` ni `XM`. Sus equivalencias y nombres completos fueron validados directamente contra la función de homologación.
- No se publicó en GitHub Pages ni se realizó una prueba física en impresora. La compatibilidad se validó mediante sintaxis, rutas relativas, caché PWA y geometría de las llamadas al generador PDF.
