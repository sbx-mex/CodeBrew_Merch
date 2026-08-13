# CodeBrew Merch · Catálogo visual premium

PWA para consultar artículos MERCH, capturar piezas y validar el cruce operativo `Código Día → Código SAP → Descripción SAP`.

## Motores

- `Lista_Precios_Base.xlsx`: motor operativo SAP, Micros, Discovery y homologaciones.
- `engines/merch-lists/*.xlsx`: listas visuales independientes. El proceso descubre entre 1 y 99 archivos sin depender de un nombre fijo.
- `scripts/generate_products.py`: construye el cruce operativo.
- `scripts/generate_visual_catalog.py`: normaliza artículos, crea llaves estables y compacta las imágenes en atlas WebP.

Llaves generadas:

- `articleKey`: `dia-{codigo-dia}--pos-{sku-pos-o-nombre}`.
- `nameKey`: nombre del artículo normalizado, sin acentos ni caracteres especiales.

Si una lista no trae imagen, se utiliza una recreación por categoría basada en el nombre. **Imagen recreada de la Lista de Precio; es una aproximación visual.**

## Actualizar listas

1. Reemplaza o agrega los Excel dentro de `engines/merch-lists/`.
2. Conserva los encabezados `CÓDIGO DIA`, `Imagen`, `Descripción SCI`, `NOMBRE POS`, `NOMBRE INVENTARIO`, `SKU POS` y al menos un precio `C1`–`C6`.
3. Sube el cambio a `main`.
4. El workflow `Actualizar lista de precios` valida los motores, regenera datos e imágenes, ejecuta pruebas y publica únicamente si todo pasa.

Las filas pueden aumentar o disminuir. El cruce se reconstruye completo en cada ejecución; no depende del número de fila anterior.

## Límites y rendimiento

- Ningún archivo puede alcanzar 25 MB.
- Ninguna carpeta puede contener 100 archivos.
- Las miniaturas se agrupan en atlas de 64 imágenes; el navegador carga sólo los recursos que utiliza.
- El catálogo muestra hasta 32 resultados a la vez y filtra por nombre, Día, SAP, SKU y categoría.

## Auditoría y limpieza

```bash
pip install --requirement scripts/requirements.txt
python scripts/build_all.py
python -m unittest discover -s tests -p "test_*.py"
```

El workflow `Auditar y limpiar obsoletos` sólo elimina candidatos autorizados, comprueba que no tengan referencias activas y vuelve a auditar el proyecto antes de publicar.
