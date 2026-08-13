# CodeBrew Merch · Catálogo visual premium

PWA para consultar artículos MERCH, capturar piezas y validar el cruce operativo `Código Día → Código SAP → Descripción SAP`.

## Motores

- `Lista_Precios_Base.xlsx`: motor operativo SAP, Micros, Discovery y homologaciones.
- `engines/merch-lists/*.xlsx`: listas visuales independientes. El proceso descubre entre 1 y 99 archivos sin depender de un nombre fijo.
- `engines/visual-sources/*.zip`: exportaciones HTML de las listas; permiten confirmar por fila que cada foto corresponde al Código Día y SKU internacional.
- `engines/image-overrides/`: reconstrucciones premium excepcionales nombradas con su Código Día, por ejemplo `16999.png`.
- `scripts/generate_products.py`: construye el cruce operativo.
- `scripts/generate_visual_catalog.py`: normaliza artículos, crea llaves estables y restaura cada fotografía por separado en un lienzo uniforme de 768 × 768 px; no usa atlas al ampliar.

Llaves generadas:

- `articleKey`: `dia-{codigo-dia}--pos-{sku-pos-o-nombre}`.
- `nameKey`: nombre del artículo normalizado, sin acentos ni caracteres especiales.

Cada imagen disponible se coteja entre Excel y HTML, se elige la fuente con mayor resolución y se remasteriza sin cambiar el producto. Si ninguna fuente trae foto, se utiliza una referencia por categoría. **Imagen recreada de la Lista de Precio; es una aproximación visual.**

El catálogo es exclusivamente una herramienta interna de conteo: no publica precios ni campos monetarios.

## Actualizar listas

1. Reemplaza o agrega los Excel dentro de `engines/merch-lists/`.
2. Reemplaza también la exportación HTML comprimida correspondiente en `engines/visual-sources/` cuando esté disponible.
3. Conserva los encabezados `CÓDIGO DIA`, `Imagen`, `Descripción SCI`, `NOMBRE POS`, `NOMBRE INVENTARIO` y `SKU POS`.
4. Sube el cambio a `main`.
5. El workflow valida dos veces la relación artículo-imagen, regenera el catálogo y publica únicamente si todo pasa.

Las filas pueden aumentar o disminuir. El cruce se reconstruye completo en cada ejecución; no depende del número de fila anterior.

## Límites y rendimiento

- Ningún archivo puede alcanzar 25 MB.
- Ninguna carpeta puede contener 100 archivos.
- Las imágenes de 384 px se agrupan en atlas de 16; así permanecen nítidas y ninguna carpeta alcanza 100 archivos.
- El catálogo carga 48 artículos por bloque mediante `Ver más artículos` y filtra por nombre, Día, SAP, SKU y categoría.

## Auditoría y limpieza

```bash
pip install --requirement scripts/requirements.txt
python scripts/build_all.py
python -m unittest discover -s tests -p "test_*.py"
```

El workflow `Auditar y limpiar obsoletos` sólo elimina candidatos autorizados, comprueba que no tengan referencias activas y vuelve a auditar el proyecto antes de publicar.
