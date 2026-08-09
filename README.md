# CodeBrew Merch POS · WOE

Versión estable enfocada en mejora de OCR móvil para lectura de SKU.

## Buscador WOE independiente
- Busca por ID WOE, Código DIA, descripción SAP, nombre Micros o nombre de inventario.
- Permite seleccionar y consultar varios artículos en una sola vista.
- Cruza `SAP` y `Catalogo Micros` con Base_Campaña, Discovery, Homologados y Essentials mediante Código DIA.
- Elimina duplicados exactos de forma defensiva, conserva relaciones uno-a-varios y muestra mensajes explícitos cuando no existe coincidencia.
- También muestra artículos presentes sólo en Micros o MERCH y los identifica como `Sin cruce SAP/WOE`.
- El Excel `Lista_Precios_Base.xlsx` continúa como único motor; Python genera `data/products.js`, `data/woe.js` y la auditoría.

## Cambios principales
- Restricciones progresivas sin mínimos obligatorios que bloqueen cámaras limitadas.
- Cámara trasera priorizada y selector cuando el navegador expone varias cámaras.
- Enfoque, exposición y balance continuos únicamente cuando la cámara los soporta.
- Zoom óptico y linterna visibles solo cuando existen capacidades reales.
- Validación adaptativa de nitidez, iluminación, contraste y movimiento antes del OCR.
- Región de lectura ampliada con margen adicional y diseño responsive.
- Confirmación OCR por repetición de resultados en varios fotogramas.
- Prevención de procesos OCR simultáneos y cancelación al cerrar u ocultar la aplicación.
- Respaldo local mediante selección o captura de fotografía.
- Liberación de pistas, referencias de imagen y temporizadores.
- Cache PWA actualizado para GitHub Pages.
- Leyenda de diseño integrada una sola vez.

## Publicación
Subir a GitHub Pages desde `main` / `/root` con `index.html` en raíz.

## Actualización de precios
1. Reemplazar `Lista_Precios_Base.xlsx` en la raíz, conservando exactamente ese nombre.
2. Subir el cambio a la rama `main`.
3. La acción `Actualizar lista de precios` valida las seis pestañas y genera `data/products.js` y `data/woe.js`.
4. Si la validación falla, los datos publicados anteriormente no se reemplazan.

La búsqueda exacta por ID WOE o Código DIA utiliza un índice en memoria; las sugerencias se procesan con una pausa mínima para evitar trabajo repetido mientras se escribe.

El resultado técnico del último procesamiento queda en `data/import-report.json`.

## Limpieza segura
El workflow `Auditar y limpiar obsoletos` inicia en modo auditoría. Sólo con la opción `aplicar` elimina archivos incluidos en una lista segura y que no tengan referencias activas dentro del proyecto.
