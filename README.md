# CodeBrew Merch POS v3

Versión estable enfocada en mejora de OCR móvil para lectura de SKU.

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
