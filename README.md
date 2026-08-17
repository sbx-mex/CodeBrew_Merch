# CodeBrew · Catálogo General

PWA operativa con tres accesos: **Catálogo General**, **Revisión de Merch** y **Exportación HTML a PDF/Excel**.

## Motores

- `Lista_Precios_Base.xlsx`: motor operativo SAP, Micros, Discovery y homologaciones.
- `engines/merch-lists/*.xlsx`: listas visuales independientes. El proceso descubre entre 1 y 99 archivos sin depender de un nombre fijo.
- `engines/visual-sources/*.zip`: exportaciones HTML de las listas; permiten confirmar por fila que cada foto corresponde al Código Día y SKU internacional.
- `assets/catalog/images/lote-01..04/`: cuatro carpetas persistentes; cada una debe contener de 1 a 99 archivos.
- `engines/image-overrides/`: reconstrucciones premium excepcionales nombradas con su Código Día, por ejemplo `16999.png`.
- `scripts/generate_products.py`: construye el cruce operativo.
- `scripts/generate_manual_catalog.py`: normaliza los artículos sin procesar miles de imágenes; mantiene rápida la actualización.
- `scripts/integrate_uploaded_images.py`: conserva los cuatro lotes y cruza cada foto por SKU internacional, Código Día, SKU POS o nombre único.
- `Control_Fotos_CodeBrew.xlsx`: pestaña única de validación, priorizada por los artículos con existencia; filtra `CON FOTO` o `FALTA FOTO`.

Llaves generadas:

- `articleKey`: `dia-{codigo-dia}--pos-{sku-pos-o-nombre}`.
- `nameKey`: nombre del artículo normalizado, sin acentos ni caracteres especiales.

Las fotos manuales tienen prioridad y permanecen después de cada compilación. El cruce revisa tanto las listas visuales como `Lista_Precios_Base.xlsx`; los artículos operativos ausentes de las listas visuales se incorporan al catálogo cuando su SKU o Código Día coincide. Si un archivo sigue sin relación, se conserva en su lote y se marca en `data/photo-coverage.json`; nunca se asigna por semejanza visual o por suposición.

El catálogo es exclusivamente una herramienta interna de conteo: no publica precios ni campos monetarios.

## Actualizar listas

1. Reemplaza o agrega los Excel dentro de `engines/merch-lists/`.
2. Reemplaza también la exportación HTML comprimida correspondiente en `engines/visual-sources/` cuando esté disponible.
3. Conserva los encabezados `CÓDIGO DIA`, `Imagen`, `Descripción SCI`, `NOMBRE POS`, `NOMBRE INVENTARIO` y `SKU POS`.
4. Sube el cambio a `main`.
5. Para agregar fotos, usa exactamente `lote-01` a `lote-04`, con menos de 100 imágenes en cada una. Nombra cada archivo con SKU internacional, Código Día, SKU POS o nombre exacto del artículo.
6. El workflow regenera el catálogo, reaplica las fotos manuales, audita la relación y publica únicamente si todo pasa.

Para actualizar una foto ya existente, reemplaza el archivo conservando su nombre. El integrador bloquea nombres repetidos, contenido duplicado y más de una foto asignada al mismo artículo. La interfaz muestra cada imagen una sola vez y no abre una segunda vista ampliada.

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
- Ninguna carpeta puede contener 100 archivos.
- El catálogo usa una foto directa por artículo, sin atlas ni duplicados.
- Revisión de Merch carga cinco artículos por bloque mediante `Ver más artículos` y filtra por nombre, Día, SAP, SKU y categoría.

## Auditoría y limpieza

```bash
pip install --requirement scripts/requirements.txt
python scripts/build_all.py
python -m unittest discover -s tests -p "test_*.py"
```

El workflow `Auditar y limpiar obsoletos` sólo elimina candidatos autorizados, comprueba que no tengan referencias activas y vuelve a auditar el proyecto antes de publicar.
