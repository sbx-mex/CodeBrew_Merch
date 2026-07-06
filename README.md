# CodeBrew Merch POS v2

Versión estable enfocada en mejora de OCR móvil para lectura de SKU.

## Cambios principales
- Cámara priorizando resolución alta, cámara trasera, enfoque continuo y soporte de zoom cuando el navegador lo permite.
- Marco central de lectura para reducir ruido fuera de la etiqueta.
- Medidor visible de calidad, enfoque, resolución y estado.
- Preprocesamiento automático antes de OCR: recorte central, escalado, escala de grises, contraste, nitidez, binarización e inversión cuando se requiere.
- OCR progresivo: normal, contraste, zoom, binarizado e invertido.
- Corrección inteligente de caracteres similares: O/0, I/1, S/5, B/8.
- Cache PWA actualizado para GitHub Pages.
- Limpieza de duplicados no conectados en raíz.

## Publicación
Subir a GitHub Pages desde `main` / `/root` con `index.html` en raíz.
