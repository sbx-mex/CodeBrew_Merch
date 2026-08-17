# CodeBrew · Catálogo General

PWA operativa con tres accesos: **Catálogo General**, **Revisión de Merch** y **Exportación HTML a PDF/Excel**.

## Motores

- `Lista_Precios_Base.xlsx`: motor operativo SAP, Micros, Discovery y homologaciones.
- `Merch_Existente15_08(1).csv`: fuente de existencia; se limpia, consolida sin duplicados y ordena de mayor a menor en cada compilación.
- `engines/merch-lists/*.xlsx`: listas visuales independientes. El proceso descubre entre 1 y 99 archivos sin depender de un nombre fijo.
- `assets/catalog/images/lote-01..04/`: las únicas cuatro rutas de fotos; admiten hasta 100 imágenes por carpeta.
- `scripts/generate_products.py`: construye el cruce operativo.
- `scripts/generate_manual_catalog.py`: normaliza los artículos sin procesar miles de imágenes; mantiene rápida la actualización.
- `scripts/integrate_uploaded_images.py`: cruza únicamente por Código Día o SKU internacional y llena primero `lote-01`, después `lote-02`, `lote-03` y `lote-04`.
- `Control_Fotos_CodeBrew.xlsx`: pestaña única de validación; muestra primero `CON FOTO` por existencia de mayor a menor y después los artículos `FALTA FOTO`.

Llaves generadas:

- `articleKey`: `dia-{codigo-dia}--pos-{sku-pos-o-nombre}`.
- `nameKey`: nombre del artículo normalizado, sin acentos ni caracteres especiales.

Las fotos manuales tienen prioridad y permanecen después de cada compilación. Si un archivo no coincide exactamente con Código Día o SKU internacional, se conserva, se marca como `pending-match` en `data/photo-coverage.json` y no detiene la publicación; nunca se asigna por nombre, semejanza visual o suposición. En cuanto el código exista en una pestaña operativa, la siguiente compilación lo relaciona automáticamente.

En Revisión de Merch, los artículos con foto aparecen primero y se ordenan por existencia de mayor a menor. Después se muestran los pendientes con el estado visible **Foto pendiente**. Sólo esas tarjetas muestran la acción compacta **Enviar foto por WhatsApp**. El buscador permanece abierto al seleccionar una coincidencia y cruza Código Día, SAP, SKU internacional, Micros y todas las pestañas operativas, incluso si el artículo aún no tiene ficha visual.

El catálogo es exclusivamente una herramienta interna de conteo: no publica precios ni campos monetarios.

## Actualizar listas

1. Reemplaza o agrega los Excel dentro de `engines/merch-lists/`.
2. Conserva los encabezados `CÓDIGO DIA`, `Descripción SCI`, `NOMBRE POS`, `NOMBRE INVENTARIO` y `SKU POS`.
3. Agrega la foto en cualquiera de las cuatro carpetas y nómbrala sólo con Código Día o SKU internacional, por ejemplo `16999.jpg` o `11186659.jpg`.
4. Reemplaza `Merch_Existente15_08(1).csv` cuando cambie la existencia.
5. Sube el cambio a `main`. El workflow limpia duplicados del CSV, ordena las fotos desde `lote-01`, regenera el catálogo y publica únicamente si toda la auditoría pasa.

Para actualizar una foto ya existente, reemplaza el archivo conservando su nombre. El integrador publica una sola foto por artículo y descarta copias repetidas. La interfaz muestra cada imagen una sola vez y no abre una segunda vista ampliada.
Si la misma foto o identificador aparece en más de una carpeta, se conserva la primera según el orden `lote-01` a `lote-04` y las copias posteriores se ignoran y desaparecen al publicar. Esto evita que un duplicado detenga el workflow.

Las filas pueden aumentar o disminuir. El cruce se reconstruye completo en cada ejecución; no depende del número de fila anterior.

## WOE e inventario PDF

El apartado WOE conserva su buscador, selección, conteo y exportación actuales. El bloque **Cruce de inventario** acepta dos fuentes sin enviarlas a un servidor:

- **Stock on Hand:** mantiene el cruce por nombre Micros y exporta la referencia operativa WOE.
- **HTML SAP (recomendado):** usa `Ctrl+S / Guardar como → Página web completa`, lee directamente la tabla local y cruza `Código SAP → Código Día + nombre de inventario`.
- **PDF SAP (respaldo):** conserva la lectura paginada y genera `Inventario Cruzado · Detalle`.

En HTML/PDF SAP sólo se leen la primera `Cantidad` y la primera `UMB` ubicadas junto al artículo. `$ Stock` se incorpora únicamente cuando la columna aparece de forma inequívoca. El control **Validar todo el inventario** incluye los artículos en cero. La entrada local acepta hasta 35 MB; el límite de 25 MB se mantiene únicamente para archivos versionados dentro de GitHub.

La vista puede descargarse como PDF o imprimirse con el botón **Imprimir vista** / `Ctrl+P`.

## Catálogo Micros y navegación

La pestaña `Catalogo Micros` se lee por encabezado, no por posición fija. Sus columnas operativas son `Agrupado`, `Familia`, `Conteo`, `Nombre Micros` y `Codigo DIA`; pueden aumentar o disminuir filas sin modificar el código. WOE permite buscar cualquier artículo sin filtros redundantes. En Revisión de Merch se muestran sólo cinco imágenes inicialmente; el buscador consulta todo el motor.

Para exportar inventario desde SAP: al finalizar el conteo, usa **clic derecho → Guardar como… → Página web completa (*.html)** y adjunta ese HTML. La exportación generada desde HTML incluye únicamente productos con Cantidad o `$ Stock` mayor a cero.

El PDF agrega `Conteo` desde `Catalogo Micros` y compacta cada registro a un solo renglón. El Excel conserva `Agrupado`, `Familia` y `Conteo`, además de códigos, descripciones, UMB, Cantidad y `$ Stock`. Los códigos sin coincidencia permanecen como aviso para evitar asignaciones inventadas.

## Límites y rendimiento

- Ningún archivo puede alcanzar 25 MB.
- Cada carpeta admite como máximo 100 imágenes.
- El catálogo usa una foto directa por artículo, sin atlas ni duplicados.
- Revisión de Merch carga cinco artículos por bloque mediante `Ver más artículos` y filtra por nombre, Día, SAP, SKU y categoría.

## Auditoría y limpieza

```bash
pip install --requirement scripts/requirements.txt
python scripts/build_all.py
python -m unittest discover -s tests -p "test_*.py"
```

El workflow `Auditar y limpiar obsoletos` sólo elimina candidatos autorizados, comprueba que no tengan referencias activas y vuelve a auditar el proyecto antes de publicar.
