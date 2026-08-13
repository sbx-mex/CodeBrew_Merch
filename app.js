(() => {
  const $ = (id) => document.getElementById(id);
  const products = window.PRODUCTS || [];
  const woeCatalog = window.WOE_CATALOG || [];
  const visualCatalog = window.MERCH_VISUAL_CATALOG?.products || [];
  const stockConfig = window.STOCK_CONFIG || {};
  const uiConfig = window.UI_CONFIG || {messages:{woeEmpty:'Empieza con WOE, DIA, nombre o SKU.',woeReady:'Listado listo para validar y exportar.',stockEmpty:'Adjunta el Stock on Hand más actual.',stockReady:'Lectura lista para confirmar y exportar.'}};
  const woeSelection = new Map();
  const catalogItemByKey = new Map();
  let catalogCategory = 'all';
  let catalogVisibleLimit = 48;
  let catalogRenderSignature = '';
  let woePdfExported = false;
  let stockRows = [];
  let stockMeta = null;
  let stockPdfName = '';
  let stockConfirmed = false;
  let stockPdfExported = false;
  let stockValidation = null;
  let stockLoadToken = 0;
  let stockLoadingTask = null;
  const stockMatchCache = new Map();
  let stream = null;
  let labelStream = null;
  let currentProduct = null;
  let currentTier = 'C2';
  let labelPreviewToken = 0;
  const labelItems = [];
  const OCR_MIN_FOCUS = 18;
  const OCR_TARGET_MAX_SIDE = 1600;
  const OCR_VARIANTS = ['normal','contrast','binary'];
  const externalLoads = new Map();
  const TAB_NAMES = ['consulta','woe','etiquetado'];
  const cameraState = {
    consulta:{ stream:null, track:null, scanning:false, token:0, qualityTimer:null, previousFrame:null, focusBaseline:0, deviceId:'' },
    label:{ stream:null, track:null, scanning:false, token:0, qualityTimer:null, previousFrame:null, focusBaseline:0, deviceId:'' }
  };

  function loadExternalScript(url,test){
    if(test())return Promise.resolve();
    if(externalLoads.has(url))return externalLoads.get(url);
    const promise=new Promise((resolve,reject)=>{
      const source=new URL(url,location.href);
      if(source.protocol!=='https:'||source.hostname!=='cdn.jsdelivr.net'){reject(new Error('Origen externo no autorizado'));return;}
      const script=document.createElement('script');let settled=false;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
      script.src=source.href;script.async=true;script.crossOrigin='anonymous';script.referrerPolicy='no-referrer';
      script.onload=()=>test()?finish():finish(new Error('La librería no quedó disponible'));
      script.onerror=()=>finish(new Error('No se pudo cargar la librería operativa'));
      const timer=setTimeout(()=>finish(new Error('La carga tardó demasiado')),20000);
      document.head.appendChild(script);
    }).catch(error=>{externalLoads.delete(url);throw error;});
    externalLoads.set(url,promise);return promise;
  }
  function ensureTesseract(){return loadExternalScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',()=>Boolean(window.Tesseract));}
  function ensureQrious(){return loadExternalScript('https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js',()=>Boolean(window.QRious));}
  function ensureJsPdf(){return loadExternalScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',()=>Boolean(window.jspdf?.jsPDF));}
  async function ensurePdfJs(){
    await loadExternalScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',()=>Boolean(window.pdfjsLib?.getDocument));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  function yieldToMain(){return new Promise(resolve=>(window.requestIdleCallback?requestIdleCallback(()=>resolve(),{timeout:90}):setTimeout(resolve,0)));}
  function setStockBusy(busy,current=0,total=0){
    const panel=$('stockPanel'),wrap=$('stockProgressWrap'),progress=$('stockProgress'),output=$('stockProgressText');
    panel.setAttribute('aria-busy',String(busy));wrap.hidden=!busy;$('stockAttach').disabled=busy;
    const percent=total?Math.round((current/total)*100):0;progress.value=percent;output.textContent=total?`${current} de ${total} páginas`:'Preparando…';
  }
  function updateConnectivity(){
    const online=navigator.onLine,target=$('connectionStatus');document.body.classList.toggle('offline',!online);target.classList.toggle('offline',!online);target.textContent=online?'En línea':'Sin conexión';target.title=online?'Conexión disponible':'La consulta continúa con los datos guardados';
  }


  function normalizeSku(value){ return String(value || '').replace(/[^0-9]/g,'').replace(/^0+/,'') || ''; }
  function normalizeText(value){ return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
  function escapeHtml(value){ return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
  function moneyClean(v){ return String(v || '').trim(); }
  function tierKeys(p){ return Object.keys(p.tier || {}).filter(k => moneyClean(p.tier[k])); }
  function priceFor(p, tier){ const keys = tierKeys(p); const k = keys.includes(tier) ? tier : (keys[0] || 'C1'); return p.tier?.[k] || ''; }
  function priceLabel(p, tier){ const keys = tierKeys(p); const k = keys.includes(tier) ? tier : (keys[0] || 'C1'); const price = p.tier?.[k] || ''; return price ? `${k}: ${price}` : '-'; }
  function priceOnly(p, tier){ return priceFor(p, tier) || '-'; }
  function qrValue(p){ return String(p?.skuPos || p?.botonPos || p?.nombrePos || '').trim(); }
  function posButtonText(p){
    const button = p?.botonPos || 'Botón por validar';
    return p?.campaign ? `${button} / ${p.campaign}` : button;
  }
  function routeText(p){ return `Mercancía → ${posButtonText(p)}`; }
  function posStepsHtml(p){
    const btn = posButtonText(p);
    return `<div class="pos-flow-title">Ayuda visual POS</div>
      <div class="pos-flow-visual">
        <div class="pos-step"><b>1</b><span><strong>Identifica Mercancía</strong><br><span class="pos-chip">Mercancía</span></span></div>
        <div class="pos-step"><b>2</b><span><strong>Abre el botón correcto</strong><br>Campaña / Menciona la campaña, su nombre homologado o Discovery.<br><span class="pos-chip">${btn}</span></span></div>
        <div class="pos-step"><b>3</b><span><strong>Escanea el código</strong><br>Usa el código de esta ficha en el POS.</span></div>
      </div>`;
  }

  const numericIndex = new Map();
  const campaignIndex = new Map();
  products.forEach(p => {
    [p.skuIntl, p.codigoDia, p.skuPos].forEach(v => {
      const key = normalizeSku(v);
      if (key && !numericIndex.has(key)) numericIndex.set(key, p);
    });
    (p.campaignAliases || []).forEach(value => {
      const key = normalizeText(value);
      if (key && !campaignIndex.has(key)) campaignIndex.set(key, p);
    });
  });

  function findProduct(raw){
    const input = String(raw || '').trim();
    const numeric = normalizeSku(input);
    if (numeric && numericIndex.has(numeric)) return numericIndex.get(numeric);
    const q = normalizeText(input);
    if (!q) return null;
    if (campaignIndex.has(q)) return campaignIndex.get(q);
    let exact = products.find(p => [p.nombrePos,p.nombreInventario,p.botonPos,p.skuPos].some(v => normalizeText(v) === q));
    if (exact) return exact;
    return products.find(p => normalizeText(`${p.nombrePos} ${p.nombreInventario} ${p.descripcion} ${p.botonPos} ${p.skuPos}`).includes(q)) || null;
  }

  function correctSkuText(value){
    return String(value || '')
      .replace(/[OoQqD]/g,'0')
      .replace(/[Il|!]/g,'1')
      .replace(/[Ss]/g,'5')
      .replace(/[Bb]/g,'8')
      .replace(/[Zz]/g,'2')
      .replace(/[Gg]/g,'6');
  }

  function extractSku(text){
    const raw = String(text || '');
    const prepared = correctSkuText(raw)
      .replace(/S\s*K\s*U/ig,'SKU')
      .replace(/#/g,' # ')
      .replace(/[^A-Za-z0-9#:\-\s]/g,' ');
    const skuPatterns = [
      /SKU\s*#?\s*[:\-]?\s*(0?[0-9][0-9\s\-]{6,16})/i,
      /SKV\s*#?\s*[:\-]?\s*(0?[0-9][0-9\s\-]{6,16})/i,
      /#\s*(0?[0-9][0-9\s\-]{6,16})/i
    ];
    for (const pattern of skuPatterns) {
      const found = prepared.match(pattern);
      if (found) {
        const sku = normalizeSku(found[1]);
        if (sku.length >= 7 && sku.length <= 10) return sku;
      }
    }
    const candidates = prepared.match(/0?[0-9][0-9\s\-]{6,16}/g) || [];
    const scored = candidates
      .map(v => normalizeSku(v))
      .filter(v => v.length >= 7 && v.length <= 10)
      .sort((a,b) => {
        const aKnown = numericIndex.has(a) ? 1 : 0;
        const bKnown = numericIndex.has(b) ? 1 : 0;
        if (aKnown !== bKnown) return bKnown - aKnown;
        return Math.abs(8 - a.length) - Math.abs(8 - b.length);
      });
    return scored[0] || '';
  }

  function qrDataUrl(value, size=260){
    const text = String(value || '').trim();
    if (!text || !window.QRious) return '';
    const qr = new QRious({ value: text, size, level: 'H', padding: 8 });
    return qr.toDataURL('image/png');
  }

  const CODE128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
  function makeBarcodeSVG(value){
    const text = String(value || '').trim();
    if (!text) return '<div class="no-code">Sin código POS</div>';
    const codes = [104];
    for (const ch of text) { const v = ch.charCodeAt(0) - 32; if (v < 0 || v > 95) continue; codes.push(v); }
    let checksum = 104; for (let i = 1; i < codes.length; i++) checksum += codes[i] * i;
    codes.push(checksum % 103, 106);
    const height = 86, scale = 2; let x = 0, bars = '';
    for (const code of codes) {
      const pattern = CODE128[code];
      for (let i = 0; i < pattern.length; i++) { const w = Number(pattern[i]) * scale; if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`; x += w; }
    }
    return `<svg class="barcode" viewBox="0 0 ${x} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Código POS ${text}">${bars}</svg>`;
  }

  function tierSelectHtml(p, selected='C1', id='tierSelect'){
    const keys = tierKeys(p);
    if (keys.length <= 1) return '';
    return `<label class="tier-inline">Tier <select id="${id}">${keys.map(k => `<option value="${k}" ${k===selected?'selected':''}>${k} · ${p.tier[k]}</option>`).join('')}</select></label>`;
  }

  function renderProduct(p, source){
    currentProduct = p;
    const keys = tierKeys(p); if (!keys.includes(currentTier)) currentTier = keys[0] || 'C1';
    const boton = posButtonText(p);
    const skuPos = qrValue(p);
    $('result').className = 'result';
    $('result').innerHTML = `
      <div class="card">
        <div class="info">
          <span class="badge">Mercancía → ${boton}</span>
          <div class="title">${p.nombrePos || 'Sin nombre POS'}</div>
          <p class="desc">${p.descripcion || ''}</p>
          ${tierSelectHtml(p, currentTier, 'tierSelect')}
          <div class="grid">
            <div class="field"><span>SKU leído</span><b>${source || p.skuIntl || '-'}</b></div>
            <div class="field"><span>Botón POS</span><b>${boton}</b><em>${p.base || ''}</em></div>
            <div class="field main"><span>SKU POS</span><b>${skuPos || '-'}</b></div>
            <div class="field"><span>Código DIA</span><b>${p.codigoDia || '-'}</b></div>
            <div class="field"><span>Nombre POS</span><b>${p.nombrePos || '-'}</b></div>
            <div class="field"><span>Precio</span><b class="price">${priceLabel(p, currentTier)}</b></div>
          </div>
          <div class="pos-help"><b>Flujo POS:</b> ${routeText(p)} → escanear código generado.</div>
          <div class="actions" style="margin-top:14px"><button id="addCurrentLabel">Agregar a etiquetado</button></div>
        </div>
        <div class="scanbox">
          <div class="scan-title">Código para escanear en POS</div>
          <div class="barcode-wrap">${makeBarcodeSVG(skuPos)}<div class="human">${skuPos || ''}</div></div>
          ${posStepsHtml(p)}
        </div>
      </div>`;
    const tierSelect = $('tierSelect');
    if (tierSelect) tierSelect.addEventListener('change', e => { currentTier = e.target.value; renderProduct(p, source); });
    $('addCurrentLabel').addEventListener('click', () => { $('labelSku').value = p.skuIntl && p.skuIntl !== 'NA' ? p.skuIntl : (p.nombreInventario || p.nombrePos || source || ''); showTab('etiquetado'); setLabelProduct(p); });
  }

  function renderNotFound(q){
    currentProduct = null;
    $('result').className = 'result notfound';
    $('result').innerHTML = `<div class="not-card"><div class="title">Artículo no encontrado</div><p>Se buscó: <b>${q || 'sin lectura'}</b></p><p class="desc">Verifica SKU #, Código DIA, SKU POS, Nombre POS o Nombre Inventario. Si es producto nuevo, actualiza la Base de Precios.</p></div>`;
  }

  const woeByDay = new Map();
  woeCatalog.forEach(item=>{const key=normalizeSku(item.codigoDia),rows=woeByDay.get(key)||[];if(key){rows.push(item);woeByDay.set(key,rows);}});
  const visualByDay = new Map();
  const visualWoeItems=[];
  visualCatalog.forEach(product=>{
    const day=normalizeSku(product.codigoDia),matches=woeByDay.get(day)||[];
    const linked=matches.length?matches:[{idWoe:'',codigoDia:product.codigoDia,descripcionSap:'',micros:[],merch:[],validation:{sap:false,micros:false,merch:true},origin:'Catálogo visual',sourceRow:product.sourceRow}];
    linked.forEach(match=>visualWoeItems.push({...match,visualProduct:product,quantity:1}));
    const rows=visualByDay.get(day)||[];rows.push(product);visualByDay.set(day,rows);
  });
  const visualDays=new Set(visualCatalog.map(product=>normalizeSku(product.codigoDia)));
  const combinedWoeItems=[...visualWoeItems,...woeCatalog.filter(item=>!visualDays.has(normalizeSku(item.codigoDia)))];
  const woeSearchRows = combinedWoeItems.map((item,index) => {
    const product=item.visualProduct||{};
    return {item,index,text:normalizeText([
      item.idWoe,item.codigoDia,item.descripcionSap,...(item.micros||[]),
      ...(item.merch||[]).flatMap(row => [row.descripcionSci,row.nombrePos,row.nombreInventario,row.skuIntl,row.skuPos,row.base]),
      product.displayName,product.descripcionSci,product.nombrePos,product.nombreInventario,product.skuIntl,product.skuPos,product.nameKey,product.articleKey,product.source
    ].join(' '))};
  });
  const woeExactIndex = new Map();
  combinedWoeItems.forEach(item => {
    [item.idWoe,item.codigoDia,item.visualProduct?.skuIntl,item.visualProduct?.skuPos].forEach(value => {
      const key=normalizeSku(value);
      if(!key)return;
      const rows=woeExactIndex.get(key)||[];
      rows.push(item);woeExactIndex.set(key,rows);
    });
  });
  let woeSuggestionTimer=null;

  function woeKey(item,index=''){ return `${item.visualProduct?.articleKey||'sin-visual'}|${item.idWoe||'sin-sap'}|${item.codigoDia}|${item.sourceRow||item.origin||index}`; }
  function visualProductFor(item){return item?.visualProduct||(visualByDay.get(normalizeSku(item?.codigoDia))||[])[0]||null;}
  function visualStyle(product){const src=String(product?.visual?.src||'').replace(/[^a-zA-Z0-9_./-]/g,'');return src?`--catalog-image:url(${src});--catalog-size:contain;--catalog-position:center`:'';}
  function articleName(item){const product=visualProductFor(item);return product?.descripcionSci||item.descripcionSap||product?.displayName||product?.nombrePos||(item.micros||[])[0]||item.merch?.[0]?.descripcionSci||'Artículo MERCH';}
  function visualQualityLabel(product){return product?.visualSource==='premium-override'?'Restauración HD':product?.visual?.kind==='restored'?'Foto restaurada':'Referencia aproximada';}
  function catalogItemKey(item){return woeKey(item,'catalog');}
  function catalogCategoryLabel(value){return ({all:'Todo',featured:'Destacados HD',mug:'Tazas',tumbler:'Tumblers','cold-cup':'Cold Cups',bottle:'Botellas',brew:'Café',accessory:'Accesorios',other:'Otros'})[value]||value;}
  function openCatalogVisual(item){
    const product=visualProductFor(item);if(!product)return;
    $('catalogVisualImage').setAttribute('style',visualStyle(product));
    $('catalogVisualImage').setAttribute('aria-label',`Vista ampliada de ${articleName(item)}`);
    $('catalogVisualTitle').textContent=articleName(item);
    $('catalogVisualDescription').textContent=product.descripcionSci||item.descripcionSap||'Descripción por validar';
    $('catalogVisualCodes').innerHTML=`<div><small>Código Día</small><b>${escapeHtml(item.codigoDia||product.codigoDia||'—')}</b></div><div><small>Código SAP</small><b>${escapeHtml(item.idWoe||'Sin cruce')}</b></div><div><small>SKU POS</small><b>${escapeHtml(product.skuPos||'—')}</b></div><div><small>Calidad visual</small><b>${escapeHtml(visualQualityLabel(product))}</b></div>`;
    $('catalogVisualDialog').showModal();
  }
  function renderCatalog(raw=''){
    const filters=$('catalogFilters'),grid=$('catalogGrid');if(!filters||!grid)return;
    const categories=['all','featured','mug','tumbler','cold-cup','bottle','brew','accessory','other'];
    filters.innerHTML=categories.map(category=>`<button type="button" class="catalog-filter ${category===catalogCategory?'active':''}" data-catalog-filter="${category}" aria-pressed="${category===catalogCategory}">${catalogCategoryLabel(category)}</button>`).join('');
    const query=normalizeText(raw),tokens=query.split(' ').filter(Boolean),signature=`${catalogCategory}|${query}`;
    if(signature!==catalogRenderSignature){catalogVisibleLimit=48;catalogRenderSignature=signature;}
    const matches=woeSearchRows.filter(row=>row.item.visualProduct&&(catalogCategory==='all'||(catalogCategory==='featured'?row.item.visualProduct.visualSource==='premium-override':row.item.visualProduct.category===catalogCategory))&&tokens.every(token=>row.text.includes(token)));
    const unique=[];const seen=new Set();for(const row of matches){if(seen.has(row.item.visualProduct.articleKey))continue;seen.add(row.item.visualProduct.articleKey);unique.push(row.item);}unique.sort((a,b)=>Number(b.visualProduct.visualSource==='premium-override')-Number(a.visualProduct.visualSource==='premium-override'));
    const visible=unique.slice(0,catalogVisibleLimit),loadMore=$('catalogLoadMore');$('catalogSummary').textContent=`Mostrando ${visible.length.toLocaleString('es-MX')} de ${unique.length.toLocaleString('es-MX')}`;
    loadMore.hidden=visible.length>=unique.length;loadMore.textContent=`Ver ${Math.min(48,unique.length-visible.length)} artículos más`;
    grid.innerHTML=visible.length?visible.map(item=>{
      const product=item.visualProduct,key=catalogItemKey(item),status=operationalWoeStatus(item);catalogItemByKey.set(key,item);
      return `<article class="catalog-card ${product.visualSource==='premium-override'?'is-featured':''}"><button type="button" class="catalog-thumb" data-catalog-visual="${escapeHtml(key)}" style="${visualStyle(product)}" aria-label="Ampliar ${escapeHtml(articleName(item))}"><span class="catalog-visual-quality">${escapeHtml(visualQualityLabel(product))}</span></button><div class="catalog-card-body"><div class="catalog-card-top"><span class="catalog-source">${escapeHtml(product.source)}</span><span class="catalog-match ${status.kind==='ok'?'ok':'review'}">${status.kind==='ok'?'Cruce validado':'Revisar cruce'}</span></div><h3>${escapeHtml(articleName(item))}</h3><p class="catalog-card-description">${escapeHtml(product.displayName||product.nombrePos||item.descripcionSap||'Descripción por validar')}</p><div class="catalog-codes"><div><small>Día</small><b>${escapeHtml(item.codigoDia||'—')}</b></div><div><small>SAP</small><b>${escapeHtml(item.idWoe||'Pendiente')}</b></div></div><div class="catalog-card-action"><div class="catalog-quantity"><button type="button" data-catalog-step="-1" data-catalog-key="${escapeHtml(key)}" aria-label="Restar pieza">−</button><input type="number" min="1" max="9999" value="1" data-catalog-qty="${escapeHtml(key)}" aria-label="Piezas de ${escapeHtml(articleName(item))}"><button type="button" data-catalog-step="1" data-catalog-key="${escapeHtml(key)}" aria-label="Agregar pieza">+</button></div><button type="button" class="catalog-add" data-catalog-add="${escapeHtml(key)}">Añadir al conteo</button></div></div></article>`;
    }).join(''):'<div class="catalog-empty"><b>No encontramos artículos.</b><br>Prueba otra palabra, Código Día, SAP o categoría.</div>';
    filters.querySelectorAll('[data-catalog-filter]').forEach(button=>button.addEventListener('click',()=>{catalogCategory=button.dataset.catalogFilter;renderCatalog($('woeSearch').value);}));
    grid.querySelectorAll('[data-catalog-step]').forEach(button=>button.addEventListener('click',()=>{const input=grid.querySelector(`[data-catalog-qty="${CSS.escape(button.dataset.catalogKey)}"]`);input.value=Math.max(1,Math.min(9999,(Number(input.value)||1)+Number(button.dataset.catalogStep)));}));
    grid.querySelectorAll('[data-catalog-visual]').forEach(button=>button.addEventListener('click',()=>openCatalogVisual(catalogItemByKey.get(button.dataset.catalogVisual))));
    grid.querySelectorAll('[data-catalog-add]').forEach(button=>button.addEventListener('click',()=>{const item=catalogItemByKey.get(button.dataset.catalogAdd),input=grid.querySelector(`[data-catalog-qty="${CSS.escape(button.dataset.catalogAdd)}"]`);addWoeItem(item,true,Number(input?.value)||1);renderWoeResults();}));
  }
  function splitWoeQueries(raw){ return String(raw||'').split(/[\n,;]+/).map(value=>value.trim()).filter(Boolean); }
  function findWoeMatches(raw,limit=12){
    const input=String(raw||'').trim(),numeric=normalizeSku(input),query=normalizeText(input);
    if(!query)return [];
    const exact=numeric?woeExactIndex.get(numeric):null;
    if(exact?.length)return exact.slice(0,limit);
    const tokens=query.split(' ').filter(Boolean);
    return woeSearchRows
      .map(row=>{
        if(!tokens.every(token=>row.text.includes(token)))return null;
        const sap=normalizeText(row.item.descripcionSap),micros=normalizeText((row.item.micros||[]).join(' '));
        let score=tokens.reduce((sum,token)=>sum+(sap.startsWith(token)?8:sap.includes(token)?5:micros.includes(token)?4:2),0);
        if(sap===query||micros===query)score+=30;
        return {item:row.item,score};
      })
      .filter(Boolean).sort((a,b)=>b.score-a.score||String(a.item.codigoDia).localeCompare(String(b.item.codigoDia)))
      .slice(0,limit).map(row=>row.item);
  }

  function renderWoeSuggestions(raw){
    const box=$('woeSuggestions'),input=$('woeSearch'),query=String(raw||'').trim();
    if(!query){box.hidden=true;input.setAttribute('aria-expanded','false');return;}
    const matches=findWoeMatches(query,8);
    box.innerHTML=matches.length?matches.map((item,index)=>`
      <button type="button" class="woe-suggestion" role="option" data-woe-suggestion="${index}">
        <b>${escapeHtml(item.codigoDia)}</b><span>${escapeHtml(articleName(item))}</span><small>${item.idWoe?`SAP ${escapeHtml(item.idWoe)}`:'SAP por validar'}</small>
      </button>`).join(''):`<div class="woe-no-suggestion"><b>Sin coincidencia exacta.</b><br>Si es MERCH, intenta con SKU, Código DIA o una variante del nombre.</div>`;
    box.hidden=false;input.setAttribute('aria-expanded','true');
    box.querySelectorAll('[data-woe-suggestion]').forEach((button,index)=>button.addEventListener('click',()=>{
      addWoeItem(matches[index]);renderWoeResults();input.value='';box.hidden=true;input.setAttribute('aria-expanded','false');input.focus();
    }));
  }

  function setOperationalFlow(flowId,states,messageId,message,ready=false){
    const flow=$(flowId);if(!flow)return;flow.querySelectorAll('[data-step]').forEach(step=>{const state=states[step.dataset.step]||'pending';step.dataset.state=state;step.setAttribute('aria-current',state==='active'?'step':'false');});const target=$(messageId);target.textContent=message;target.classList.toggle('ready',ready);
  }

  function updateWoeFlow(){
    const count=woeSelection.size,query=Boolean($('woeSearch')?.value.trim());
    const states=count?{search:'done',select:'done',export:woePdfExported?'done':'active'}:query?{search:'done',select:'active',export:'pending'}:{search:'active',select:'pending',export:'pending'};
    const message=count?(woePdfExported?'PDF generado; puedes conservar o ajustar el listado.':uiConfig.messages?.woeReady):uiConfig.messages?.woeEmpty;
    setOperationalFlow('woeFlow',states,'woeNextAction',message||'Continúa con el siguiente paso.',count>0);
  }

  function updateStockFlow(){
    const loaded=stockRows.length>0,confirmed=stockConfirmed;
    const states=stockPdfExported?{attach:'done',review:'done',export:'done'}:confirmed?{attach:'done',review:'done',export:'active'}:loaded?{attach:'done',review:'active',export:'pending'}:{attach:'active',review:'pending',export:'pending'};
    const message=loaded?(stockPdfExported?'PDF cruzado generado; conserva el reporte como referencia.':confirmed?'Lectura confirmada; genera tu PDF cruzado.':uiConfig.messages?.stockReady):uiConfig.messages?.stockEmpty;
    setOperationalFlow('stockFlow',states,'stockNextAction',message||'Continúa con el siguiente paso.',loaded);
  }

  function persistWoeSelection(){
    try{sessionStorage.setItem('codebrew-woe-selection-v2',JSON.stringify(selectedWoeItems().map(({key,item})=>({key,quantity:Number(item.quantity)||1})).slice(0,100)));}catch(error){}
  }

  function restoreWoeSelection(){
    try{const saved=JSON.parse(sessionStorage.getItem('codebrew-woe-selection-v2')||'[]');if(Array.isArray(saved))saved.slice(0,100).forEach(entry=>{const item=combinedWoeItems.find(candidate=>woeKey(candidate)===entry.key);if(item)addWoeItem(item,false,entry.quantity);});}catch(error){}
  }

  function addWoeItem(item,render=true,quantity=1){
    if(!item)return;const key=woeKey(item,woeSelection.size),existing=woeSelection.get(key),pieces=Math.max(1,Math.min(9999,Math.trunc(Number(quantity)||1)));
    woePdfExported=false;woeSelection.set(key,{...item,quantity:existing?Math.min(9999,(Number(existing.quantity)||1)+pieces):pieces});
    if(render)renderWoeSelection();
  }

  function addWoeQueries(raw){
    const queries=splitWoeQueries(raw),missing=[];let added=0;
    queries.forEach(query=>{
      const matches=findWoeMatches(query,25);
      if(!matches.length){missing.push(query);return;}
      matches.forEach(item=>{const before=woeSelection.size;addWoeItem(item,false);if(woeSelection.size>before)added++;});
    });
    renderWoeSelection();
    $('woeSearch').value='';$('woeSuggestions').hidden=true;$('woeSearch').setAttribute('aria-expanded','false');
    $('woeStatus').classList.toggle('warning',missing.length>0);
    if(missing.length)$('woeStatus').innerHTML=`<b>Aviso · sin coincidencia exacta:</b> ${missing.map(escapeHtml).join(', ')}. Si es MERCH, considera que el nombre puede variar: prueba con SKU de lista, SKU POS o Código DIA.`;
    else if(added)$('woeStatus').textContent=`${added} coincidencia${added===1?'':'s'} agregada${added===1?'':'s'} a la selección.`;
    else $('woeStatus').textContent='No se agregaron registros nuevos.';
    return {added,missing};
  }

  function renderWoeSelection(){
    const target=$('woeSelection'),items=[...woeSelection.entries()];
    $('woeSelectedCount').textContent=items.length;
    $('woeExport').disabled=!items.length;
    persistWoeSelection();updateWoeFlow();
    if(!items.length){target.innerHTML='<span class="woe-empty-selection">Sin elementos seleccionados.</span>';return;}
    target.innerHTML=items.map(([key,item])=>`<span class="woe-chip"><span class="woe-chip-qty">${Number(item.quantity)||1}</span><b>${escapeHtml(item.codigoDia)}</b> · ${escapeHtml(articleName(item))}<button type="button" aria-label="Quitar ${escapeHtml(item.codigoDia)}" data-woe-remove="${escapeHtml(key)}">×</button></span>`).join('');
    target.querySelectorAll('[data-woe-remove]').forEach(button=>button.addEventListener('click',()=>{woeSelection.delete(button.dataset.woeRemove);woePdfExported=false;renderWoeSelection();if($('woeResults').children.length)renderWoeResults();}));
  }

  function selectedWoeItems(){
    return [...woeSelection.entries()].map(([key,item])=>({key,item})).sort((a,b)=>String(a.item.codigoDia).localeCompare(String(b.item.codigoDia),'es',{numeric:true}));
  }

  function operationalWoeStatus(item){
    const sap=Boolean(item.validation?.sap),micros=Boolean(item.validation?.micros);
    if(sap&&micros)return {kind:'ok',label:'Validado SAP + Micros'};
    if(sap)return {kind:'warning',label:'Revisar en Micros'};
    if(micros)return {kind:'warning',label:'Sin cruce SAP / WOE'};
    return {kind:'missing',label:'Sin cruce operativo'};
  }

  function merchReferenceHtml(item){
    const rows=item.merch||[];
    if(!rows.length)return '<span class="woe-merch-na">No aplica</span>';
    return `<details class="woe-merch-reference"><summary>MERCH homologado · ${rows.length}</summary>${rows.map(row=>`<div><b>${escapeHtml(row.descripcionSci||row.nombreInventario||row.nombrePos||'Artículo MERCH')}</b><small>SKU lista: ${escapeHtml(row.skuIntl||'N/D')} · SKU POS: ${escapeHtml(row.skuPos||'N/D')}</small></div>`).join('')}<p>Revisa con el SKU si continúa activo en WOE; el nombre puede ser distinto.</p></details>`;
  }

  function woePdfConfig(){
    return window.WOE_PDF_CONFIG||{page:{orientation:'portrait',format:'letter',unit:'pt',width:612,height:792,margin:24,tableTop:82,tableBottom:754,footerY:778},columns:[{key:'descripcionSap',label:'DESCRIPCION SAP',width:226},{key:'nombreMicros',label:'NOMBRE MICROS',width:142},{key:'codigoDia',label:'#DIA',width:58},{key:'idWoe',label:'#SAP',width:58},{key:'qty',label:'PZAS',width:50}],style:{titleSize:18,metaSize:8,headerSize:7.5,bodySize:7.8,lineHeight:9.2,cellPadding:5,maxLinesPerCell:4,green:[0,98,65],dark:[7,63,47],cream:[249,246,239],line:[221,225,220],warning:[180,83,9]}};
  }

  function pdfWoeRows(){
    return selectedWoeItems().map(({item})=>{const status=operationalWoeStatus(item);return {descripcionSap:item.descripcionSap||articleName(item)||'Sin descripcion SAP',nombreMicros:(item.micros||[]).join(' | ')||item.visualProduct?.nombrePos||'Sin coincidencia Micros',codigoDia:item.codigoDia||'-',idWoe:item.idWoe||'-',qty:String(Number(item.quantity)||1),statusKind:status.kind};});
  }

  async function generateWoePdf(){
    const rows=pdfWoeRows();
    if(!rows.length){$('woeStatus').classList.add('warning');$('woeStatus').textContent='Agrega al menos un artículo antes de generar el PDF.';return;}
    const exportButton=$('woeExport'),originalLabel=exportButton.textContent;exportButton.disabled=true;exportButton.textContent='Generando PDF...';
    try{
    await ensureJsPdf();
    const config=woePdfConfig(),page=config.page,style=config.style,columns=config.columns,{jsPDF}=window.jspdf;
    const doc=new jsPDF({orientation:page.orientation,unit:page.unit,format:page.format,compress:true,putOnlyUsedFonts:true});
    const selected=rows.length,pieces=rows.reduce((sum,row)=>sum+(Number(row.qty)||0),0),valid=rows.filter(row=>row.statusKind==='ok').length,review=selected-valid,date=new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(new Date());
    const pageWidth=doc.internal.pageSize.getWidth(),pageHeight=doc.internal.pageSize.getHeight(),tableLeft=page.margin,headerHeight=22;

    function safeLines(value,width){
      const lines=doc.splitTextToSize(String(value||'-'),Math.max(20,width-(style.cellPadding*2)));
      if(lines.length<=style.maxLinesPerCell)return lines;
      const clipped=lines.slice(0,style.maxLinesPerCell);clipped[clipped.length-1]=`${clipped[clipped.length-1].replace(/\s+$/,'')}...`;return clipped;
    }
    function drawHeader(){
      doc.setFillColor(...style.green);doc.roundedRect(page.margin,18,8,42,3,3,'F');
      doc.setTextColor(...style.dark);doc.setFont('helvetica','bold');doc.setFontSize(style.titleSize);doc.text('WOE - Lista de doble check',page.margin+16,33);
      doc.setFont('helvetica','normal');doc.setFontSize(style.metaSize);doc.text(`${selected} articulos | ${pieces} piezas | ${valid} validados | ${review} por revisar | ${date}`,page.margin+16,47);
      doc.setTextColor(70,82,76);doc.text('Consulta operativa SAP + Micros. En MERCH el nombre puede variar; valida por SKU cuando aplique.',page.margin+16,59);
      let x=tableLeft;doc.setFillColor(...style.dark);doc.rect(x,page.tableTop,pageWidth-(page.margin*2),headerHeight,'F');
      doc.setTextColor(255,255,255);doc.setFont('helvetica','bold');doc.setFontSize(style.headerSize);
      columns.forEach(column=>{doc.text(column.label,x+style.cellPadding,page.tableTop+14,{maxWidth:column.width-(style.cellPadding*2)});x+=column.width;});
      return page.tableTop+headerHeight;
    }
    function drawFooter(pageNumber,totalPages){
      doc.setDrawColor(...style.line);doc.line(page.margin,page.footerY-10,pageWidth-page.margin,page.footerY-10);
      doc.setFont('helvetica','normal');doc.setFontSize(7);doc.setTextColor(90,101,95);doc.text('CodeBrew | Uso operativo interno',page.margin,page.footerY);doc.text(`Pagina ${pageNumber} de ${totalPages}`,pageWidth-page.margin,page.footerY,{align:'right'});
    }

    doc.setProperties({title:'WOE - Lista de doble check',subject:'Comparativo operativo SAP y Micros',creator:'CodeBrew'});
    let y=drawHeader();
    rows.forEach((row,rowIndex)=>{
      doc.setFont('helvetica','normal');doc.setFontSize(style.bodySize);
      const cells=columns.map(column=>safeLines(row[column.key],column.width));
      const rowHeight=Math.max(18,Math.max(...cells.map(lines=>lines.length))*style.lineHeight+(style.cellPadding*2));
      if(y+rowHeight>page.tableBottom){doc.addPage(page.format,page.orientation);y=drawHeader();}
      if(rowIndex%2===1){doc.setFillColor(...style.cream);doc.rect(tableLeft,y,pageWidth-(page.margin*2),rowHeight,'F');}
      let x=tableLeft;doc.setDrawColor(...style.line);doc.setLineWidth(.35);
      columns.forEach((column,index)=>{
        doc.rect(x,y,column.width,rowHeight);
        doc.setTextColor(...style.dark);doc.setFont('helvetica',column.key==='codigoDia'||column.key==='idWoe'?'bold':'normal');
        doc.text(cells[index],x+style.cellPadding,y+style.cellPadding+style.bodySize,{lineHeightFactor:style.lineHeight/style.bodySize,maxWidth:column.width-(style.cellPadding*2)});x+=column.width;
      });
      y+=rowHeight;
    });
    const totalPages=doc.getNumberOfPages();for(let number=1;number<=totalPages;number++){doc.setPage(number);drawFooter(number,totalPages);}
    doc.save(`WOE_Lista_Doble_Check_${new Date().toISOString().slice(0,10)}.pdf`);
    woePdfExported=true;updateWoeFlow();
    $('woeStatus').classList.remove('warning');$('woeStatus').innerHTML=`<b>PDF generado:</b> ${selected} artículos y ${pieces} piezas, con cruce Día → SAP.`;
    }catch(error){$('woeStatus').classList.add('warning');$('woeStatus').textContent='No fue posible generar el PDF. Conservamos tu listado para que puedas intentarlo nuevamente.';}
    finally{exportButton.disabled=false;exportButton.textContent=originalLabel;}
  }

  function renderWoeResults(){
    if(!woeSelection.size&&$('woeSearch').value.trim())addWoeQueries($('woeSearch').value);
    const rows=selectedWoeItems(),items=rows.map(row=>row.item),target=$('woeResults');
    if(!items.length){target.innerHTML='';$('woeStatus').classList.remove('warning');$('woeStatus').textContent='No hay registros seleccionados. Busca por artículo, Código Día, SAP o SKU.';return;}
    const reviewed=items.filter(item=>operationalWoeStatus(item).kind==='ok').length,needsReview=items.length-reviewed;
    const pieces=items.reduce((sum,item)=>sum+(Number(item.quantity)||1),0);
    target.innerHTML=`<div class="woe-result-summary"><div><strong>${items.length}</strong><span>artículos</span></div><div><strong>${pieces}</strong><span>piezas</span></div><div class="ok"><strong>${reviewed}</strong><span>validados</span></div><div class="review"><strong>${needsReview}</strong><span>por revisar</span></div></div><div class="woe-table-wrap"><table class="woe-table"><thead><tr><th>Visual</th><th>Artículo / Descripción SAP</th><th>#Día</th><th>#SAP</th><th>Piezas</th><th>Validación</th><th></th></tr></thead><tbody>${rows.map(({key,item})=>{const status=operationalWoeStatus(item),product=visualProductFor(item);return `<tr><td class="woe-visual-cell" data-label="Visual">${product?`<button type="button" class="woe-row-thumb" data-woe-visual="${escapeHtml(key)}" style="${visualStyle(product)}" aria-label="Ampliar ${escapeHtml(articleName(item))}"></button>`:'<span class="woe-merch-na">Sin imagen</span>'}</td><td data-label="Artículo"><strong>${escapeHtml(articleName(item))}</strong><small class="woe-table-detail">${escapeHtml(item.descripcionSap||product?.descripcionSci||'Descripción SAP por validar')}</small></td><td data-label="#Día"><b class="woe-code">${escapeHtml(item.codigoDia||'—')}</b></td><td data-label="#SAP"><b>${escapeHtml(item.idWoe||'—')}</b></td><td data-label="Piezas"><input class="woe-qty-input" type="number" min="1" max="9999" value="${Number(item.quantity)||1}" data-woe-qty="${escapeHtml(key)}" aria-label="Piezas de ${escapeHtml(articleName(item))}"></td><td data-label="Validación"><span class="woe-op-status ${status.kind}">${status.kind==='ok'?'✓':'!'} ${escapeHtml(status.label)}</span></td><td><button type="button" class="woe-row-remove" data-woe-row-remove="${escapeHtml(key)}" aria-label="Quitar Código Día ${escapeHtml(item.codigoDia)}">×</button></td></tr>`;}).join('')}</tbody></table></div>`;
    $('woeStatus').classList.toggle('warning',needsReview>0);
    $('woeStatus').innerHTML=needsReview?`<b>Doble check:</b> ${reviewed} artículos validados y ${needsReview} por revisar. Total operativo: ${pieces} piezas.`:`<b>Listo:</b> ${reviewed} artículos con cruce Día → SAP. Total operativo: ${pieces} piezas.`;
    target.querySelectorAll('[data-woe-row-remove]').forEach(button=>button.addEventListener('click',()=>{woeSelection.delete(button.dataset.woeRowRemove);woePdfExported=false;renderWoeSelection();renderWoeResults();}));
    target.querySelectorAll('[data-woe-visual]').forEach(button=>button.addEventListener('click',()=>openCatalogVisual(woeSelection.get(button.dataset.woeVisual))));
    target.querySelectorAll('[data-woe-qty]').forEach(input=>input.addEventListener('change',()=>{const item=woeSelection.get(input.dataset.woeQty);if(!item)return;item.quantity=Math.max(1,Math.min(9999,Math.trunc(Number(input.value)||1)));woePdfExported=false;renderWoeSelection();renderWoeResults();}));
  }

  const stockAliasRows=[];
  const stockExactIndex=new Map();
  const stockTokenIndex=new Map();
  woeCatalog.forEach(item=>(item.micros||[]).forEach(name=>{
    const normalized=normalizeText(name).replace(/^\d+\s+/,''),key=`${item.codigoDia}|${item.idWoe}|${normalized}`;
    if(!normalized||stockAliasRows.some(row=>row.key===key))return;
    const row={key,normalized,name,item,tokens:new Set(normalized.split(' ').filter(Boolean))};
    stockAliasRows.push(row);
    const exact=stockExactIndex.get(normalized)||[];exact.push(row);stockExactIndex.set(normalized,exact);
    row.tokens.forEach(token=>{if(token.length<3)return;const matches=stockTokenIndex.get(token)||[];matches.push(row);stockTokenIndex.set(token,matches);});
  }));

  function stockConfigValue(){
    return stockConfig.parser?stockConfig:{
      parser:{yTolerance:2,itemMaxX:210,unitMinX:205,unitMaxX:330,qtyMinX:330,qtyMaxX:410,zeroTolerance:.049999,previewLimit:250,titleAliases:['stock on hand','stock onhand'],adaptiveLayout:true,minimumHeaderFields:4},
      page:{orientation:'portrait',format:'letter',unit:'pt',width:612,height:792,margin:24,tableTop:112,tableBottom:754,footerY:778},
      columns:[{key:'codigoDia',label:'#DIA',width:45},{key:'idWoe',label:'#SAP',width:45},{key:'descripcionSap',label:'DESCRIPCION SAP',width:160},{key:'nombreMicros',label:'NOMBRE MICROS',width:142},{key:'unidad',label:'UNIDAD STOCK',width:64},{key:'qty',label:'QTY',width:40},{key:'estado',label:'ESTADO',width:68}],
      style:{titleSize:17,metaSize:7.5,headerSize:6.8,bodySize:7,lineHeight:8.2,cellPadding:4,maxLinesPerCell:3,green:[0,98,65],dark:[7,63,47],cream:[249,246,239],line:[221,225,220],warning:[180,83,9]},
      messages:{disclaimer:'Este reporte es un estimado. Realiza un doble check con tu conteo físico del libro y captura en la app al finalizar el servicio.',nameVariation:'El nombre Micros puede variar. Valida por Código DIA cuando el cruce no sea exacto.'}
    };
  }

  function groupStockPdfLines(items){
    const tolerance=Number(stockConfigValue().parser.yTolerance)||2;
    const parts=items.filter(item=>String(item.str||'').trim()).map(item=>({text:String(item.str).trim(),x:Number(item.transform?.[4]||0),y:Number(item.transform?.[5]||0)})).sort((a,b)=>b.y-a.y||a.x-b.x);
    const lines=[];
    parts.forEach(part=>{
      let line=lines.find(candidate=>Math.abs(candidate.y-part.y)<=tolerance);
      if(!line){line={y:part.y,parts:[]};lines.push(line);}
      line.parts.push(part);
    });
    return lines.sort((a,b)=>b.y-a.y).map(line=>{line.parts.sort((a,b)=>a.x-b.x);line.text=line.parts.map(part=>part.text).join(' ').replace(/\s+/g,' ').trim();return line;});
  }

  function parseStockNumber(value){
    let clean=String(value||'').replace(/[−–—]/g,'-').replace(/\s/g,'').trim(),negative=false;
    if(/^\(.+\)$/.test(clean)){negative=true;clean=clean.slice(1,-1);}
    if(/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(clean))clean=clean.replace(/,/g,'');
    else if(/^[-+]?\d+,\d+$/.test(clean))clean=clean.replace(',','.');
    if(!/^[-+]?\d+(?:\.\d+)?$/.test(clean))return null;
    const number=Number(clean);return Number.isFinite(number)?(negative?-Math.abs(number):number):null;
  }

  function detectStockLayout(lines){
    const base=stockConfigValue().parser;
    if(!base.adaptiveLayout)return {...base,detected:false};
    const header=lines.find(line=>{const text=normalizeText(line.text);return text.includes('name')&&text.includes('unit')&&text.includes('qty')&&text.includes('cost');});
    if(!header)return {...base,detected:false};
    const field=(pattern)=>header.parts.find(part=>pattern.test(normalizeText(part.text)));
    const name=field(/^(?:item )?name$/),unit=field(/^(?:standard )?unit$/),qty=field(/^(?:qty|quantity)$/),cost=field(/^cost$/);
    const ordered=[name,unit,qty,cost].every(Boolean)&&name.x<unit.x&&unit.x<qty.x&&qty.x<cost.x;
    if(!ordered)return {...base,detected:false};
    const itemUnit=(name.x+unit.x)/2,unitQty=(unit.x+qty.x)/2,qtyCost=(qty.x+cost.x)/2;
    return {...base,itemMaxX:itemUnit,unitMinX:itemUnit,unitMaxX:unitQty,qtyMinX:unitQty,qtyMaxX:qtyCost,detected:true};
  }

  function parseStockRow(line,pageNumber,parser=stockConfigValue().parser){
    const qtyPart=line.parts.find(part=>part.x>=parser.qtyMinX&&part.x<parser.qtyMaxX&&parseStockNumber(part.text)!==null);
    if(!qtyPart)return null;
    const qty=parseStockNumber(qtyPart.text);
    if(qty===null||Math.abs(qty)<=parser.zeroTolerance)return null;
    let name=line.parts.filter(part=>part.x<parser.itemMaxX).map(part=>part.text).join(' ').replace(/\s+/g,' ').trim();
    let unit=line.parts.filter(part=>part.x>=parser.unitMinX&&part.x<parser.unitMaxX).map(part=>part.text).join(' ').replace(/\s+/g,' ').trim();
    if(!unit){
      const merged=name.match(/(PZA|BTE|PAQ|BOL|BLI|LTA|CJ|KG|LT|MIL|CAJ|BOT|BUL|GAL|GR|ML):\s*(.*)$/i);
      if(merged){name=name.slice(0,merged.index).trim();unit=merged[1]+(merged[2].trim()?`: ${merged[2].trim()}`:'');}
    }
    unit=unit.replace(/^([A-Z]{2,4}):\s*$/i,'$1').trim();
    const normalized=normalizeText(name);
    if(!name||['item name','name','qty','cost','value'].includes(normalized)||/^page \d+ of \d+$/.test(normalized))return null;
    return {sourceName:name,pdfUnit:unit||'N/D',qty,page:pageNumber};
  }

  function tokenScore(left,right){
    if(left===right)return 1;
    if((left.includes(right)||right.includes(left))&&Math.min(left.length,right.length)>=8)return .9+(Math.min(left.length,right.length)/Math.max(left.length,right.length))*.09;
    const a=new Set(left.split(' ').filter(Boolean)),b=new Set(right.split(' ').filter(Boolean));
    const shared=[...a].filter(token=>b.has(token)).length;
    return a.size&&b.size?(2*shared)/(a.size+b.size):0;
  }

  function chooseStockAlias(rows,type,score){
    const unique=[];
    rows.forEach(row=>{if(!unique.some(item=>item.item.codigoDia===row.item.codigoDia&&item.item.idWoe===row.item.idWoe))unique.push(row);});
    unique.sort((a,b)=>Number(Boolean(b.item.descripcionSap))-Number(Boolean(a.item.descripcionSap))||String(a.item.codigoDia).localeCompare(String(b.item.codigoDia),'es',{numeric:true}));
    const selected=unique[0];
    if(!selected)return null;
    return {alias:selected,matchType:unique.length>1?'ambiguous':type,matchScore:score,alternatives:unique.length};
  }

  function matchStockRow(row){
    const query=normalizeText(row.sourceName).replace(/^\d+\s+/,'');
    const cached=stockMatchCache.has(query);
    let chosen=cached?stockMatchCache.get(query):chooseStockAlias(stockExactIndex.get(query)||[],'exact',1);
    if(!cached&&!chosen){
      const candidates=new Set();query.split(' ').filter(token=>token.length>=3).forEach(token=>(stockTokenIndex.get(token)||[]).forEach(alias=>candidates.add(alias)));
      const pool=candidates.size?[...candidates]:stockAliasRows;
      const ranked=pool.map(alias=>({alias,score:tokenScore(query,alias.normalized)})).filter(result=>result.score>=.76).sort((a,b)=>b.score-a.score);
      if(ranked.length&&ranked[0].score-(ranked[1]?.score||0)>=.05)chosen=chooseStockAlias([ranked[0].alias],'probable',ranked[0].score);
    }
    if(!cached)stockMatchCache.set(query,chosen||null);
    if(!chosen)return {...row,codigoDia:'',idWoe:'',descripcionSap:'Sin cruce SAP',nombreMicros:row.sourceName,unidad:row.pdfUnit,matchType:'unmatched',matchScore:0,alternatives:0};
    const item=chosen.alias.item;
    return {...row,codigoDia:item.codigoDia||'',idWoe:item.idWoe||'',descripcionSap:item.descripcionSap||'Sin descripción SAP',nombreMicros:chosen.alias.name,unidad:row.pdfUnit||item.unidadMicros||'N/D',matchType:chosen.matchType,matchScore:chosen.matchScore,alternatives:chosen.alternatives};
  }

  function readStockMeta(lines,items,fileName){
    const aliases=stockConfigValue().parser.titleAliases||['stock on hand'],titleIndex=lines.findIndex(line=>aliases.includes(normalizeText(line.text)));
    const storeLine=titleIndex>=0?lines[titleIndex+1]?.text:'';
    const normalizeDate=value=>{const match=String(value||'').trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);if(!match)return'';const year=match[3].length===2?`20${match[3]}`:match[3];return `${match[1].padStart(2,'0')}/${match[2].padStart(2,'0')}/${year}`;};
    const dateItems=items.map(item=>({text:normalizeDate(item.str),x:Number(item.transform?.[4]||0)})).filter(item=>item.text).sort((a,b)=>a.x-b.x);
    const timeItems=items.filter(item=>/\d{1,2}:\d{2}:\d{2}/.test(String(item.str||''))||/^[ap]\.\s*m\.$/i.test(String(item.str||'').trim())).map(item=>({text:String(item.str).trim(),x:Number(item.transform?.[4]||0)})).sort((a,b)=>a.x-b.x);
    return {titleFound:titleIndex>=0,store:storeLine||'Tienda no identificada',reportDate:dateItems[0]?.text||'',printedDate:dateItems[dateItems.length-1]?.text||dateItems[0]?.text||'',printedTime:timeItems.map(item=>item.text).join(' ').replace(/\s+/g,' ').trim(),fileName};
  }

  function stockTimestamp(meta){
    const match=String(meta.printedDate||meta.reportDate).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(!match)return 0;
    let hour=0,minute=0,second=0;
    const time=String(meta.printedTime||'').toLowerCase().replace(/\s|\./g,'');
    const clock=time.match(/(\d{1,2}):(\d{2}):(\d{2})(am|pm)?/);
    if(clock){hour=Number(clock[1]);minute=Number(clock[2]);second=Number(clock[3]);if(clock[4]==='pm'&&hour<12)hour+=12;if(clock[4]==='am'&&hour===12)hour=0;}
    return new Date(Number(match[3]),Number(match[2])-1,Number(match[1]),hour,minute,second).getTime();
  }

  function stockFreshness(meta){
    const warnings=[];
    const timestamp=stockTimestamp(meta),today=new Date(),dateMatch=String(meta.reportDate).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(!meta.titleFound)warnings.push('El archivo no se identifica como Stock on Hand.');
    if(!timestamp)warnings.push('No fue posible validar la fecha de impresión.');
    if(dateMatch){const reportDay=new Date(Number(dateMatch[3]),Number(dateMatch[2])-1,Number(dateMatch[1]));if(reportDay.toDateString()!==today.toDateString())warnings.push(`El Report Date es ${meta.reportDate}; confirma que sea el reporte más actual.`);}
    try{
      const key=`codebrew-stock-${normalizeText(meta.store)||'tienda'}`,previous=Number(localStorage.getItem(key)||0);
      if(timestamp&&previous&&timestamp<previous)warnings.push('Este PDF es anterior al último reporte leído para la tienda.');
    }catch(error){/* La validación por fecha actual continúa aunque el almacenamiento esté bloqueado. */}
    return warnings;
  }

  function rememberConfirmedStock(meta){
    const timestamp=stockTimestamp(meta);if(!timestamp)return;
    try{const key=`codebrew-stock-${normalizeText(meta.store)||'tienda'}`,previous=Number(localStorage.getItem(key)||0);if(timestamp>=previous)localStorage.setItem(key,String(timestamp));}catch(error){/* La confirmación funciona aun con almacenamiento bloqueado. */}
  }

  function validateStockReading(meta,rows,freshnessWarnings=[]){
    const missingHeader=[];
    if(!meta?.titleFound)missingHeader.push('título Stock on Hand');
    if(!meta?.store||meta.store==='Tienda no identificada')missingHeader.push('tienda');
    if(!meta?.reportDate)missingHeader.push('Report Date');
    if(!meta?.printedDate)missingHeader.push('fecha de impresión');
    if(!meta?.printedTime)missingHeader.push('hora de impresión');
    const invalidItems=rows.filter(row=>!String(row.sourceName||'').trim()).length;
    const invalidUnits=rows.filter(row=>!String(row.pdfUnit||'').trim()||row.pdfUnit==='N/D').length;
    const invalidQty=rows.filter(row=>!Number.isFinite(row.qty)||Math.abs(row.qty)<=Number(stockConfigValue().parser.zeroTolerance||.000001)).length;
    const duplicateKeys=new Set(),duplicates=new Set();
    rows.forEach(row=>{const key=`${normalizeText(row.sourceName)}|${normalizeText(row.pdfUnit)}`;if(duplicateKeys.has(key))duplicates.add(key);else duplicateKeys.add(key);});
    const blocking=[];
    if(missingHeader.length)blocking.push(`Falta validar: ${missingHeader.join(', ')}.`);
    if(meta?.headerMismatches?.length)blocking.push(`El encabezado cambia entre páginas: ${meta.headerMismatches.join(', ')}.`);
    if(!rows.length)blocking.push('No hay artículos con cantidad diferente de cero.');
    if(invalidItems)blocking.push(`${invalidItems} renglón${invalidItems===1?'':'es'} sin artículo.`);
    if(invalidQty)blocking.push(`${invalidQty} cantidad${invalidQty===1?'':'es'} inválida${invalidQty===1?'':'s'}.`);
    if(duplicates.size)blocking.push(`${duplicates.size} artículo${duplicates.size===1?'':'s'} duplicado${duplicates.size===1?'':'s'} por nombre y unidad.`);
    const warnings=[...freshnessWarnings];
    if(invalidUnits)warnings.push(`${invalidUnits} renglón${invalidUnits===1?'':'es'} sin unidad; se conservará${invalidUnits===1?'':'n'} como N/D.`);
    const unmatched=rows.filter(row=>row.matchType==='unmatched'||row.matchType==='ambiguous').length;
    if(unmatched)warnings.push(`${unmatched} artículo${unmatched===1?'':'s'} sin cruce exacto; se conservará${unmatched===1?'':'n'} en el PDF.`);
    if(meta?.reportDate&&meta?.printedDate&&meta.reportDate!==meta.printedDate)warnings.push('Report Date y Printed On corresponden a fechas distintas.');
    return {valid:blocking.length===0,blocking,warnings,missingHeader,invalidItems,invalidUnits,invalidQty,duplicates:duplicates.size,unmatched};
  }

  function closeStockConfirmation(){
    const dialog=$('stockConfirmDialog');
    if(typeof dialog.close==='function'&&dialog.open)dialog.close();else dialog.classList.remove('open');
  }

  function updateStockConfirmAction(){
    $('stockConfirmAccept').disabled=!stockValidation?.valid;
  }

  function openStockConfirmation(){
    if(!stockRows.length||!stockMeta)return;
    const exact=stockRows.filter(row=>row.matchType==='exact').length,probable=stockRows.filter(row=>row.matchType==='probable').length,review=stockRows.length-exact-probable,dialog=$('stockConfirmDialog');
    $('stockConfirmAccept').disabled=!stockValidation?.valid;
    $('stockConfirmSummary').innerHTML=`<div><span>Tienda</span><b>${escapeHtml(stockStoreName(stockMeta.store))}</b></div><div><span>Report Date</span><b>${escapeHtml(stockMeta.reportDate||'No identificado')}</b></div><div><span>Printed On</span><b>${escapeHtml(`${stockMeta.printedDate||''} ${stockMeta.printedTime||''}`.trim()||'No identificado')}</b></div><div><span>Lectura</span><b>${stockRows.length} no cero · ${exact} exactos · ${probable+review} con aviso</b></div>`;
    const block=$('stockConfirmBlock'),messages=[...(stockValidation?.blocking||[]),...(stockValidation?.warnings||[])];
    block.hidden=!messages.length;block.innerHTML=messages.length?`<b>${stockValidation?.valid?'Advertencia':'Exportación bloqueada'}:</b> ${messages.map(escapeHtml).join(' ')}`:'';
    if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else dialog.classList.add('open');
    requestAnimationFrame(()=>(stockValidation?.valid?$('stockConfirmAccept'):$('stockConfirmClose')).focus());
  }

  async function confirmStockReading(){
    updateStockConfirmAction();
    if(!stockValidation?.valid)return;
    stockConfirmed=true;stockPdfExported=false;rememberConfirmedStock(stockMeta);$('stockExport').disabled=false;$('stockExport').textContent='2 · Exportar PDF cruzado';updateStockFlow();
    $('stockStatus').classList.toggle('warning',(stockValidation.warnings||[]).length>0||stockRows.some(row=>row.matchType!=='exact'));
    $('stockStatus').innerHTML=`<b>Lectura confirmada:</b> preparando el PDF cruzado en Carta vertical.`;
    closeStockConfirmation();
    await generateStockPdf();
  }

  function stockStoreName(value){
    const parts=String(value||'').split(' - ').map(part=>part.trim()).filter(Boolean);
    return parts.length>1&&parts[0]===parts[1]?parts[0]:(parts[0]||'Tienda no identificada');
  }

  function renderStockResults(extraWarnings=[]){
    const target=$('stockResults'),metaBox=$('stockMeta'),status=$('stockStatus');
    if(!stockRows.length){target.innerHTML='';metaBox.hidden=true;return;}
    const exact=stockRows.filter(row=>row.matchType==='exact').length,probable=stockRows.filter(row=>row.matchType==='probable').length,review=stockRows.length-exact-probable;
    metaBox.hidden=false;
    metaBox.innerHTML=`<div><span>Tienda</span><b>${escapeHtml(stockStoreName(stockMeta.store))}</b></div><div><span>Report Date</span><b>${escapeHtml(stockMeta.reportDate||'No identificado')}</b></div><div><span>Printed On</span><b>${escapeHtml(`${stockMeta.printedDate||''} ${stockMeta.printedTime||''}`.trim()||'No identificado')}</b></div><div><span>Archivo</span><b>${escapeHtml(stockPdfName)}</b></div>`;
    const warnings=[...extraWarnings];if(probable)warnings.push(`${probable} cruce${probable===1?'':'s'} con variación de nombre.`);if(review)warnings.push(`${review} artículo${review===1?'':'s'} sin cruce exacto; se conservará${review===1?'':'n'}.`);
    status.classList.toggle('warning',warnings.length>0);
    status.innerHTML=warnings.length?`<b>Lectura completa con avisos:</b> ${warnings.map(escapeHtml).join(' ')}`:`<b>Reporte actual y listo:</b> ${exact} artículos cruzados de forma exacta.`;
    const limit=Number(stockConfigValue().parser.previewLimit)||250,ordered=[...stockRows].sort((a,b)=>({unmatched:0,ambiguous:1,probable:2,exact:3}[a.matchType]-{unmatched:0,ambiguous:1,probable:2,exact:3}[b.matchType])||a.nombreMicros.localeCompare(b.nombreMicros,'es'));
    const visible=ordered.slice(0,limit);
    target.innerHTML=`<div class="stock-summary"><div><strong>${stockRows.length}</strong><span>cantidades ≠ 0</span></div><div class="ok"><strong>${exact}</strong><span>cruces exactos</span></div><div class="review"><strong>${probable+review}</strong><span>con aviso</span></div></div><div class="woe-table-wrap stock-table-wrap"><table class="woe-table stock-table"><thead><tr><th>#DIA</th><th>#SAP</th><th>Descripción SAP</th><th>Nombre Micros</th><th>Unidad Stock</th><th>Qty</th><th>Estado</th></tr></thead><tbody>${visible.map(row=>`<tr class="stock-${row.matchType}"><td><b class="woe-code">${escapeHtml(row.codigoDia||'—')}</b></td><td><b>${escapeHtml(row.idWoe||'—')}</b></td><td>${escapeHtml(row.descripcionSap)}</td><td><strong>${escapeHtml(row.nombreMicros)}</strong></td><td>${escapeHtml(row.unidad)}</td><td><b>${row.qty.toFixed(1)}</b></td><td><span class="woe-op-status ${row.matchType==='exact'?'ok':'warning'}">${row.matchType==='exact'?'✓ Exacto':row.matchType==='probable'?'! Variación':'! Sin cruce'}</span></td></tr>`).join('')}</tbody></table></div>${stockRows.length>limit?`<p class="hint">Vista previa de ${limit} registros. El PDF final incluirá los ${stockRows.length} artículos con cantidad diferente de cero.</p>`:''}`;
  }

  async function loadStockPdf(file){
    if(!file)return;
    const loadToken=++stockLoadToken;
    try{await stockLoadingTask?.destroy?.();}catch(error){}
    const status=$('stockStatus');stockRows=[];stockMeta=null;stockPdfName=file.name;stockConfirmed=false;stockPdfExported=false;stockValidation=null;updateStockFlow();$('stockExport').disabled=true;$('stockExport').textContent='2 · Exportar PDF cruzado';$('stockClear').disabled=true;$('stockResults').innerHTML='';$('stockMeta').hidden=true;
    status.classList.remove('warning');status.textContent='Preparando lector y validando el PDF...';
    setStockBusy(true);
    let pdf=null;
    try{
      if(file.size>25*1024*1024)throw new Error('El PDF supera 25 MB. Genera un reporte optimizado directamente desde Micros.');
      const signature=new TextDecoder('ascii').decode(await file.slice(0,5).arrayBuffer());
      if(signature!=='%PDF-')throw new Error('El archivo no tiene una firma PDF válida.');
      await ensurePdfJs();
      const buffer=await file.arrayBuffer(),task=window.pdfjsLib.getDocument({data:new Uint8Array(buffer)});stockLoadingTask=task;pdf=await task.promise;
      if(!pdf.numPages||pdf.numPages>250)throw new Error('El reporte debe contener entre 1 y 250 páginas.');
      const rawRows=[];let firstMeta=null,adaptivePages=0,fallbackPages=0;const headerMismatches=new Set();
      for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
        if(loadToken!==stockLoadToken)throw new DOMException('Lectura reemplazada','AbortError');
        const page=await pdf.getPage(pageNumber),content=await page.getTextContent(),lines=groupStockPdfLines(content.items);
        const pageMeta=readStockMeta(lines,content.items,file.name),layout=detectStockLayout(lines);layout.detected?adaptivePages++:fallbackPages++;
        if(pageNumber===1)firstMeta=pageMeta;
        else for(const field of ['store','reportDate','printedDate','printedTime'])if(pageMeta[field]&&firstMeta?.[field]&&pageMeta[field]!==firstMeta[field])headerMismatches.add(field);
        lines.forEach(line=>{const row=parseStockRow(line,pageNumber,layout);if(row)rawRows.push(row);});
        setStockBusy(true,pageNumber,pdf.numPages);
        if(pageNumber===1||pageNumber%5===0||pageNumber===pdf.numPages)status.textContent=`Leyendo Stock on Hand · página ${pageNumber} de ${pdf.numPages}...`;
        if(pageNumber%4===0)await yieldToMain();
      }
      if(rawRows.length>10000)throw new Error('El reporte contiene demasiados renglones para una validación segura.');
      stockMeta={...(firstMeta||{}),pages:pdf.numPages,adaptivePages,fallbackPages,headerMismatches:[...headerMismatches]};
      stockRows=rawRows.map(matchStockRow);
      if(!stockRows.length)throw new Error('No se localizaron cantidades diferentes de cero. Confirma que el PDF tenga texto seleccionable.');
      const freshness=stockFreshness(stockMeta);if(fallbackPages)freshness.push(`El lector complementario validó ${fallbackPages} página${fallbackPages===1?'':'s'} con el diseño base.`);else freshness.push(`Estructura detectada automáticamente en ${adaptivePages} página${adaptivePages===1?'':'s'}.`);stockValidation=validateStockReading(stockMeta,stockRows,freshness);renderStockResults(freshness);updateStockFlow();$('stockExport').disabled=false;$('stockExport').textContent=stockValidation.valid?'2 · Confirmar lectura':'2 · Lectura bloqueada';$('stockClear').disabled=false;requestAnimationFrame(openStockConfirmation);
    }catch(error){if(loadToken===stockLoadToken&&error?.name!=='AbortError'){status.classList.add('warning');status.textContent=error?.message||'No fue posible leer el PDF Stock on Hand.';$('stockPdfInput').value='';}}
    finally{if(stockLoadingTask&&loadToken===stockLoadToken)stockLoadingTask=null;try{await pdf?.destroy?.();}catch(error){}if(loadToken===stockLoadToken)setStockBusy(false);}
  }

  function clearStockReport(){
    stockLoadToken++;try{stockLoadingTask?.destroy?.();}catch(error){}stockLoadingTask=null;setStockBusy(false);stockRows=[];stockMeta=null;stockPdfName='';stockConfirmed=false;stockPdfExported=false;stockValidation=null;updateStockFlow();$('stockPdfInput').value='';$('stockExport').disabled=true;$('stockExport').textContent='2 · Exportar PDF cruzado';$('stockClear').disabled=true;$('stockMeta').hidden=true;$('stockResults').innerHTML='';$('stockStatus').classList.remove('warning');$('stockStatus').textContent='Adjunta un PDF cuando necesites esta validación opcional.';closeStockConfirmation();$('stockAttach').focus();
  }

  async function generateStockPdf(){
    if(!stockRows.length||!stockMeta)return;
    if(!stockConfirmed||!stockValidation?.valid){openStockConfirmation();return;}
    const finalValidation=validateStockReading(stockMeta,stockRows,[]);
    if(!finalValidation.valid){stockConfirmed=false;stockValidation=finalValidation;$('stockExport').textContent='2 · Lectura bloqueada';openStockConfirmation();return;}
    const button=$('stockExport'),original=button.textContent;button.disabled=true;button.textContent='Creando PDF cruzado...';
    try{
      await ensureJsPdf();
      const config=stockConfigValue(),page=config.page,style=config.style,columns=config.columns,{jsPDF}=window.jspdf;
      const doc=new jsPDF({orientation:page.orientation,unit:page.unit,format:page.format,compress:true,putOnlyUsedFonts:true}),pageWidth=doc.internal.pageSize.getWidth(),tableLeft=page.margin,headerHeight=22;
      const exact=stockRows.filter(row=>row.matchType==='exact').length,review=stockRows.length-exact;
      function safeLines(value,width){const lines=doc.splitTextToSize(String(value||'-'),Math.max(18,width-(style.cellPadding*2)));if(lines.length<=style.maxLinesPerCell)return lines;const clipped=lines.slice(0,style.maxLinesPerCell);clipped[clipped.length-1]=`${clipped[clipped.length-1].replace(/\s+$/,'')}...`;return clipped;}
      function drawHeader(){
        doc.setFillColor(...style.green);doc.roundedRect(page.margin,18,8,44,3,3,'F');doc.setTextColor(...style.dark);doc.setFont('helvetica','bold');doc.setFontSize(style.titleSize);doc.text('Stock on Hand - Referencia operativa',page.margin+16,33);
        doc.setFont('helvetica','normal');doc.setFontSize(style.metaSize);doc.text(`${stockStoreName(stockMeta.store)} | Report Date ${stockMeta.reportDate||'-'} | Printed On ${`${stockMeta.printedDate||''} ${stockMeta.printedTime||''}`.trim()||'-'}`,page.margin+16,47,{maxWidth:pageWidth-page.margin*2-16});
        doc.setTextColor(...style.warning);doc.setFont('helvetica','bold');doc.text(config.messages.disclaimer,page.margin,70,{maxWidth:pageWidth-page.margin*2});doc.setFont('helvetica','normal');doc.setTextColor(70,82,76);doc.text(`${stockRows.length} cantidades distintas de cero | ${exact} cruces exactos | ${review} con aviso`,page.margin,92);
        let x=tableLeft;doc.setFillColor(...style.dark);doc.rect(x,page.tableTop,pageWidth-page.margin*2,headerHeight,'F');doc.setTextColor(255,255,255);doc.setFont('helvetica','bold');doc.setFontSize(style.headerSize);columns.forEach(column=>{doc.text(column.label,x+style.cellPadding,page.tableTop+14,{maxWidth:column.width-style.cellPadding*2});x+=column.width;});return page.tableTop+headerHeight;
      }
      function drawFooter(number,total){doc.setDrawColor(...style.line);doc.line(page.margin,page.footerY-10,pageWidth-page.margin,page.footerY-10);doc.setFont('helvetica','normal');doc.setFontSize(7);doc.setTextColor(90,101,95);doc.text('CodeBrew | Estimado para doble check con conteo físico',page.margin,page.footerY);doc.text(`Página ${number} de ${total}`,pageWidth-page.margin,page.footerY,{align:'right'});}
      doc.setProperties({title:'Stock on Hand - Referencia operativa',subject:'Cruce Stock on Hand con SAP y catálogo Micros',creator:'CodeBrew'});
      let y=drawHeader();stockRows.forEach((row,index)=>{const estado=row.matchType==='exact'?'Exacto':row.matchType==='probable'?'Variación':'Sin cruce',values={...row,estado,qty:row.qty.toFixed(1)},cells=columns.map(column=>safeLines(values[column.key],column.width)),rowHeight=Math.max(18,Math.max(...cells.map(lines=>lines.length))*style.lineHeight+style.cellPadding*2);if(y+rowHeight>page.tableBottom){doc.addPage(page.format,page.orientation);y=drawHeader();}if(index%2===1||row.matchType!=='exact'){doc.setFillColor(...style.cream);doc.rect(tableLeft,y,pageWidth-page.margin*2,rowHeight,'F');}let x=tableLeft;doc.setDrawColor(...style.line);doc.setLineWidth(.35);columns.forEach((column,columnIndex)=>{doc.rect(x,y,column.width,rowHeight);if(column.key==='estado')doc.setTextColor(...(row.matchType==='exact'?style.green:style.warning));else doc.setTextColor(...style.dark);doc.setFont('helvetica',['codigoDia','idWoe','qty','estado'].includes(column.key)?'bold':'normal');doc.setFontSize(style.bodySize);doc.text(cells[columnIndex],x+style.cellPadding,y+style.cellPadding+style.bodySize,{lineHeightFactor:style.lineHeight/style.bodySize,maxWidth:column.width-style.cellPadding*2});x+=column.width;});y+=rowHeight;});
      const pages=doc.getNumberOfPages();for(let number=1;number<=pages;number++){doc.setPage(number);drawFooter(number,pages);}const store=stockStoreName(stockMeta.store).replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'')||'Tienda';doc.save(`Stock_on_Hand_${store}_${String(stockMeta.reportDate||'').replaceAll('/','-')||new Date().toISOString().slice(0,10)}.pdf`);stockPdfExported=true;updateStockFlow();$('stockStatus').classList.toggle('warning',review>0);$('stockStatus').innerHTML=`<b>PDF generado:</b> ${stockRows.length} artículos con cantidad diferente de cero. ${review?`${review} incluyen aviso de cruce y fueron conservados.`:'Todos los cruces fueron exactos.'}`;
    }catch(error){$('stockStatus').classList.add('warning');$('stockStatus').textContent='No fue posible generar el PDF final. El reporte leído se conserva para volver a intentarlo.';}
    finally{button.disabled=false;button.textContent=original;}
  }

  function search(raw){ const p = findProduct(raw); p ? renderProduct(p, raw) : renderNotFound(raw); }

  function showTab(name,{updateHistory=true,focus=false}={}){
    const target=TAB_NAMES.includes(name)?name:'consulta';
    document.querySelectorAll('.tab').forEach(button=>{const active=button.dataset.tab===target;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;if(active&&focus)button.focus();});
    document.querySelectorAll('.tabpage').forEach(panel=>{const active=panel.id===target;panel.classList.toggle('active',active);panel.hidden=!active;});
    try{sessionStorage.setItem('codebrew-tab',target);}catch(error){}
    if(updateHistory&&location.hash!==`#${target}`)history.pushState({tab:target},'',`#${target}`);
  }

  function renderAuditHealth(){
    const target=$('appHealth'),audit=window.APP_AUDIT;
    if(!target)return;
    if(!audit){target.className='app-health warning';target.textContent='Auditoría no disponible';return;}
    target.className=`app-health ${audit.errors?'error':audit.warnings?'warning':'ok'}`;
    target.textContent=audit.errors?`${audit.errors} errores de control`:audit.warnings?`${audit.checksTotal} controles · ${audit.warnings} oportunidades`:`Motor validado · ${audit.checksTotal} controles`;
    target.title=(audit.checks||[]).map(item=>`${item.name}: ${item.detail}`).join('\n');
  }

  function updateLabelTier(p){
    const sel = $('labelTier'); const keys = p ? tierKeys(p) : ['C1'];
    sel.innerHTML = (keys.length ? keys : ['C2']).map(k => `<option value="${k}">${k}${p?.tier?.[k] ? ' · '+p.tier[k] : ''}</option>`).join('');
    if (p && keys.includes('C2')) sel.value = 'C2';
    sel.disabled = !p || keys.length <= 1;
  }

  function setLabelProduct(p){ updateLabelTier(p); void renderLabelPreview(p); }

  async function renderLabelPreview(p){
    const token=++labelPreviewToken;
    if (!p) { $('labelPreview').className = 'label-preview empty-small'; $('labelPreview').textContent = 'SKU / nombre no encontrado para etiquetado.'; updateLabelTier(null); return; }
    const tier = $('labelTier').value || tierKeys(p)[0] || 'C1';
    try{await ensureQrious();}catch(error){/* La ficha continúa disponible aunque el QR remoto no cargue. */}
    if(token!==labelPreviewToken)return;
    const qr = qrDataUrl(qrValue(p), 160);
    $('labelPreview').className = 'label-preview';
    $('labelPreview').innerHTML = `<div class="preview-card">
      <div><b>${posButtonText(p)}</b><small>${p.nombrePos || ''} | ${priceOnly(p, tier)}</small><strong>SKU ${qrValue(p) || '-'}</strong></div>
      ${qr ? `<img class="mini-qr" src="${qr}" alt="QR">` : ''}
    </div>`;
  }

  function addLabel(raw, qty){
    const p = findProduct(raw); setLabelProduct(p); if (!p) return;
    const tier = $('labelTier').value || tierKeys(p)[0] || 'C1';
    const safeQty = Math.max(1, Math.min(500, Number(qty) || 1));
    labelItems.push({ product:p, qty:safeQty, tier });
    renderCart(); $('labelQty').value = 1; $('labelSku').select();
  }

  function renderCart(){
    const total = labelItems.reduce((a,x)=>a+x.qty,0); $('totalLabels').textContent = total; $('pdfLabels').disabled = total === 0;
    if (!labelItems.length) { $('labelCart').className = 'cart empty-small'; $('labelCart').textContent = 'Sin etiquetas agregadas.'; return; }
    $('labelCart').className = 'cart';
    $('labelCart').innerHTML = labelItems.map((x,i)=>`
      <div class="cart-row">
        <div><strong>${posButtonText(x.product)}</strong><small>${x.product.nombrePos || ''} | ${priceOnly(x.product, x.tier)} · ${x.tier}</small></div>
        <div class="sku-col"><small>SKU</small><b>${qrValue(x.product) || '-'}</b></div>
        <input data-i="${i}" class="qtyEdit" type="number" min="1" max="500" value="${x.qty}">
        <button class="remove" data-remove="${i}">×</button>
      </div>`).join('');
    document.querySelectorAll('.qtyEdit').forEach(inp => inp.addEventListener('change', e => { labelItems[Number(e.target.dataset.i)].qty = Math.max(1, Number(e.target.value)||1); renderCart(); }));
    document.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', e => { labelItems.splice(Number(e.target.dataset.remove),1); renderCart(); }));
  }

  async function generatePdf(){
    try{await Promise.all([ensureJsPdf(),ensureQrious()]);}catch(error){alert('No se pudo cargar el generador PDF. Revisa tu conexión e intenta nuevamente.');return;}
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({orientation:'portrait', unit:'in', format:'letter'});
    const labelW = 2, labelH = 1.5;
    const marginX = 0.25, marginY = 0.25, gapX = 0.08, gapY = 0.08;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const usableW = pageW - (marginX * 2);
    const bottomLimit = pageH - marginY;
    const cols = Math.max(1, Math.floor((usableW + gapX) / (labelW + gapX)));
    const gridW = (cols * labelW) + ((cols - 1) * gapX);
    const startX = marginX + Math.max(0, (usableW - gridW) / 2);
    const expanded=[]; labelItems.forEach(item => { for(let i=0;i<item.qty;i++) expanded.push({p:item.product, tier:item.tier}); });
    let col = 0;
    let y = marginY;
    expanded.forEach((it,idx) => {
      if (col === cols) {
        col = 0;
        y += labelH + gapY;
      }
      if (y + labelH > bottomLimit + Number.EPSILON) {
        doc.addPage();
        col = 0;
        y = marginY;
      }
      const x = startX + col * (labelW + gapX);
      const p = it.p, tier = it.tier, sku = qrValue(p);
      doc.setDrawColor(190,170,130); doc.setLineWidth(0.01); doc.roundedRect(x,y,labelW,labelH,0.08,0.08);
      doc.setTextColor(0,72,51); doc.setFont('helvetica','bold'); doc.setFontSize(11.5);
      doc.text(posButtonText(p), x + labelW/2, y + 0.19, {align:'center', maxWidth:labelW-0.12});
      doc.setTextColor(35,43,38); doc.setFont('helvetica','normal'); doc.setFontSize(6.7);
      const line = `${p.nombrePos || ''} | ${priceOnly(p, tier)}`;
      doc.text(doc.splitTextToSize(line, labelW - 0.14).slice(0,2), x + labelW/2, y + 0.36, {align:'center'});
      doc.setFont('helvetica','bold'); doc.setFontSize(11.5); doc.setTextColor(0,72,51);
      doc.text(`SKU ${sku || '-'}`, x + labelW/2, y + 0.60, {align:'center', maxWidth:labelW-0.14});
      const qr = qrDataUrl(sku, 340); if (qr) doc.addImage(qr, 'PNG', x + 0.58, y + 0.70, 0.84, 0.74);
      col += 1;
    });
    doc.save(`CodeBrew_Etiquetas_${expanded.length}_pzas.pdf`);
  }

  function idsForMode(mode){
    const label = mode === 'label';
    return {
      video:label?'labelVideo':'video', status:label?'labelOcrStatus':'ocrStatus',
      start:label?'labelStartCamera':'startCamera', scan:label?'labelScanBtn':'scanBtn',
      stop:label?'labelStopCamera':'stopCamera', canvas:label?'labelSnapshot':'snapshot',
      input:label?'labelSku':'manualSku', camera:label?'labelCameraSelect':'cameraSelect',
      zoomWrap:label?'labelZoomControl':'zoomControl', zoom:label?'labelZoomRange':'zoomRange',
      zoomValue:label?'labelZoomValue':'zoomValue', resetZoom:label?'labelResetZoomBtn':'resetZoomBtn', torch:label?'labelTorchBtn':'torchBtn',
      photo:label?'labelPhotoInput':'photoInput', takePhoto:label?'labelTakePhotoInput':'takePhotoInput',
      preview:label?'labelPhotoPreview':'photoPreview'
    };
  }

  function cameraConstraints(deviceId=''){
    return {
      video: {
        ...(deviceId ? { deviceId:{ exact:deviceId } } : { facingMode:{ ideal:'environment' } }),
        width:{ ideal:1920 },
        height:{ ideal:1080 },
        aspectRatio:{ ideal:1.7777778 },
        frameRate:{ ideal:24, max:30 }
      },
      audio:false
    };
  }

  async function safeApply(track, constraint){
    if (!track?.applyConstraints) return false;
    try { await track.applyConstraints({ advanced:[constraint] }); return true; }
    catch(e) { return false; }
  }

  async function applyCameraEnhancements(mode){
    const state = cameraState[mode], ids = idsForMode(mode), track = state.track;
    const caps = track?.getCapabilities?.() || {};
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) await safeApply(track,{focusMode:'continuous'});
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) await safeApply(track,{exposureMode:'continuous'});
    if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) await safeApply(track,{whiteBalanceMode:'continuous'});
    const zoomWrap=$(ids.zoomWrap), zoom=$(ids.zoom), torch=$(ids.torch);
    if (caps.zoom && Number.isFinite(caps.zoom.min) && Number.isFinite(caps.zoom.max) && caps.zoom.max > caps.zoom.min) {
      zoom.min=caps.zoom.min; zoom.max=caps.zoom.max; zoom.step=caps.zoom.step || .1;
      const initial=Math.min(caps.zoom.max,Math.max(caps.zoom.min,1.15));
      zoom.value=initial; $(ids.zoomValue).textContent=`${Number(initial).toFixed(1)}×`;
      zoomWrap.hidden=false; await safeApply(track,{zoom:initial});
    } else zoomWrap.hidden=true;
    const torchSupported=Boolean(caps.torch);
    torch.hidden=!torchSupported; torch.dataset.on='false'; torch.textContent='Linterna';
    return { caps, settings:track?.getSettings?.() || {} };
  }

  async function populateCameraSelector(mode){
    const ids=idsForMode(mode), select=$(ids.camera);
    if (!navigator.mediaDevices?.enumerateDevices || !select) return;
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
    select.innerHTML='';
    devices.forEach((d,i)=>{
      const option=document.createElement('option');
      option.value=d.deviceId; option.textContent=d.label || `Cámara ${i+1}`;
      if (d.deviceId===cameraState[mode].deviceId) option.selected=true;
      select.appendChild(option);
    });
    select.closest('.camera-selector').hidden=devices.length<2;
  }

  function getSmartZoom(mode){
    const el=$(mode==='label'?'labelSmartZoom':'smartZoom');
    return el?.checked ? 1.28 : 1;
  }

  function drawSourceRegion(source, canvas, mode, variant='normal'){
    const vw=source.videoWidth || source.naturalWidth || source.width || 1280;
    const vh=source.videoHeight || source.naturalHeight || source.height || 720;
    const cropZoom=getSmartZoom(mode);
    const regionW=Math.floor(vw*(cropZoom>1?.72:.88));
    const regionH=Math.floor(vh*(cropZoom>1?.42:.54));
    const sx=Math.max(0,Math.floor((vw-regionW)/2));
    const sy=Math.max(0,Math.floor((vh-regionH)/2));
    const scale=Math.min(2.5,Math.max(1.2,OCR_TARGET_MAX_SIDE/Math.max(regionW,regionH)));
    canvas.width=Math.max(1,Math.floor(regionW*scale));
    canvas.height=Math.max(1,Math.floor(regionH*scale));
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
    ctx.drawImage(source,sx,sy,regionW,regionH,0,0,canvas.width,canvas.height);
    preprocessCanvas(ctx,canvas.width,canvas.height,variant);
    return canvas;
  }

  function drawRegion(video, canvas, mode, variant='normal'){ return drawSourceRegion(video,canvas,mode,variant); }

  function preprocessCanvas(ctx, w, h, variant){
    const image = ctx.getImageData(0, 0, w, h);
    const data = image.data;
    let sum = 0;
    const gray = new Uint8ClampedArray(w*h);
    for (let i=0, j=0; i<data.length; i+=4, j++) {
      let g = Math.round(data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114);
      if (variant === 'contrast' || variant === 'zoom') g = Math.max(0, Math.min(255, (g - 128) * 1.55 + 138));
      gray[j] = g; sum += g;
    }
    const avg = sum / gray.length;
    for (let i=0, j=0; i<data.length; i+=4, j++) {
      let g = gray[j];
      if (variant === 'binary' || variant === 'invert') {
        const threshold = avg * 0.96;
        g = g > threshold ? 255 : 0;
      }
      if (variant === 'invert') g = 255 - g;
      data[i] = data[i+1] = data[i+2] = g;
      data[i+3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    if (variant === 'contrast' || variant === 'zoom') sharpenCanvas(ctx, w, h);
  }

  function sharpenCanvas(ctx, w, h){
    const src = ctx.getImageData(0, 0, w, h);
    const out = ctx.createImageData(w, h);
    const s = src.data, d = out.data;
    const kernel = [0,-1,0,-1,5,-1,0,-1,0];
    for (let y=1; y<h-1; y++) {
      for (let x=1; x<w-1; x++) {
        const idx = (y*w+x)*4;
        let v = 0, k = 0;
        for (let ky=-1; ky<=1; ky++) for (let kx=-1; kx<=1; kx++) v += s[((y+ky)*w+(x+kx))*4] * kernel[k++];
        v = Math.max(0, Math.min(255, v));
        d[idx] = d[idx+1] = d[idx+2] = v; d[idx+3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
  }

  function analyzeFrame(source, mode, remember=true){
    const vw=source.videoWidth || source.naturalWidth || source.width || 0;
    const vh=source.videoHeight || source.naturalHeight || source.height || 0;
    if (!vw || !vh) return {focus:0,brightness:0,contrast:0,motion:0,ready:false,reason:'Cámara no lista'};
    const probe=document.createElement('canvas'); probe.width=240; probe.height=140;
    const ctx=probe.getContext('2d',{willReadFrequently:true});
    const sw=Math.floor(vw*.76),sh=Math.floor(vh*.48);
    ctx.drawImage(source,Math.floor((vw-sw)/2),Math.floor((vh-sh)/2),sw,sh,0,0,probe.width,probe.height);
    const rgba=ctx.getImageData(0,0,probe.width,probe.height).data;
    const gray=new Uint8Array(probe.width*probe.height);
    let sum=0,sumSq=0,lapTotal=0,lapCount=0;
    for(let i=0,j=0;i<rgba.length;i+=4,j++){const g=Math.round(rgba[i]*.299+rgba[i+1]*.587+rgba[i+2]*.114);gray[j]=g;sum+=g;sumSq+=g*g;}
    for(let y=1;y<probe.height-1;y+=2)for(let x=1;x<probe.width-1;x+=2){
      const p=(yy,xx)=>gray[yy*probe.width+xx];
      lapTotal+=Math.abs(4*p(y,x)-p(y-1,x)-p(y+1,x)-p(y,x-1)-p(y,x+1));lapCount++;
    }
    const brightness=sum/gray.length,variance=Math.max(0,sumSq/gray.length-brightness*brightness),contrast=Math.sqrt(variance);
    const state=cameraState[mode]; let motion=0;
    if(state.previousFrame?.length===gray.length){for(let i=0;i<gray.length;i+=4)motion+=Math.abs(gray[i]-state.previousFrame[i]);motion/=Math.ceil(gray.length/4);}
    if(remember)state.previousFrame=gray;
    const focus=lapTotal/Math.max(1,lapCount);
    if(focus>state.focusBaseline)state.focusBaseline=focus;
    const adaptiveFocus=Math.max(10,Math.min(26,(state.focusBaseline||OCR_MIN_FOCUS)*.56));
    let reason='Preparado para leer';
    if(brightness<48)reason='Se necesita más luz';
    else if(brightness>224)reason='Evita el reflejo directo';
    else if(contrast<22)reason='Acerca el texto al área amarilla';
    else if(motion>24)reason='Mantén estable el dispositivo';
    else if(focus<adaptiveFocus)reason='Aleja ligeramente para enfocar';
    return {focus,brightness,contrast,motion,threshold:adaptiveFocus,ready:reason==='Preparado para leer',reason};
  }

  function focusScore(video,mode='consulta'){ return analyzeFrame(video,mode,false).focus; }

  function setQuality(mode, values){
    const prefix = mode === 'label' ? 'label' : '';
    const qEl = $(prefix ? 'labelQualityValue' : 'qualityValue');
    const fEl = $(prefix ? 'labelFocusValue' : 'focusValue');
    const rEl = $(prefix ? 'labelResolutionValue' : 'resolutionValue');
    const readyEl = $(prefix ? 'labelReadyValue' : 'readyValue');
    if (qEl) qEl.textContent = values.quality;
    if (fEl) fEl.textContent = values.focus;
    if (rEl) rEl.textContent = values.resolution;
    if (readyEl) readyEl.textContent = values.ready;
  }

  function updateLiveQuality(mode){
    const ids=idsForMode(mode),video=$(ids.video);
    if(!video?.videoWidth || cameraState[mode].scanning)return;
    const q=analyzeFrame(video,mode,true);
    setQuality(mode,{quality:q.ready?'Alta':(q.focus>=q.threshold*.72?'Media':'Baja'),focus:String(Math.round(q.focus)),resolution:`${video.videoWidth}×${video.videoHeight}`,ready:q.reason});
    $(ids.status).textContent=q.ready?'Cámara lista · puedes leer':q.reason;
  }

  async function waitForSharpFrame(video,statusId,mode,token){
    let best=null;
    for(let attempt=0;attempt<12;attempt++){
      if(token!==cameraState[mode].token)throw new Error('Lectura cancelada');
      const q=analyzeFrame(video,mode,true); if(!best||q.focus>best.focus)best=q;
      setQuality(mode,{quality:q.ready?'Alta':(q.focus>=q.threshold*.72?'Media':'Baja'),focus:String(Math.round(q.focus)),resolution:`${video.videoWidth||0}×${video.videoHeight||0}`,ready:q.reason});
      $(statusId).textContent=q.reason;
      if(q.ready){await new Promise(r=>setTimeout(r,180));return q;}
      await new Promise(r=>setTimeout(r,240));
    }
    throw new Error(best?.reason || 'Aleja ligeramente la cámara hasta que el texto se vea nítido.');
  }

  async function runOcr(canvas, statusId, variant){
    const options = {
      tessedit_char_whitelist: 'SKUsku#0123456789OIl|SsBb:- ',
      preserve_interword_spaces: '1'
    };
    const { data:{ text, confidence } } = await window.Tesseract.recognize(canvas, 'eng', {
      logger:m => { if(m.status) $(statusId).textContent = `${Math.round((m.progress || 0) * 100)}% OCR · ${variant}`; },
      ...options
    });
    return { text, confidence: confidence || 0, sku: extractSku(text), variant };
  }

  function chooseBestOcr(results){
    return results.sort((a,b) => {
      const ak = a.sku && numericIndex.has(a.sku) ? 1000 : 0;
      const bk = b.sku && numericIndex.has(b.sku) ? 1000 : 0;
      const al = a.sku ? 100 : 0;
      const bl = b.sku ? 100 : 0;
      return (bk+bl+b.confidence) - (ak+al+a.confidence);
    })[0] || { sku:'', text:'' };
  }

  async function openCamera(videoId,statusId,startId,scanId,stopId,mode,deviceId=''){
    closeCamera(videoId,statusId,startId,scanId,stopId,mode,false);
    const state=cameraState[mode],ids=idsForMode(mode);
    try{
      if(!window.isSecureContext)throw new Error('La cámara requiere HTTPS');
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Cámara no soportada');
      $(statusId).textContent='Solicitando permiso de cámara';
      const s=await navigator.mediaDevices.getUserMedia(cameraConstraints(deviceId));
      state.stream=s;state.track=s.getVideoTracks?.()[0]||null;state.deviceId=state.track?.getSettings?.().deviceId||deviceId||'';
      if(mode==='label')labelStream=s;else stream=s;
      const video=$(videoId);video.srcObject=s;await video.play();
      const info=await applyCameraEnhancements(mode);
      await populateCameraSelector(mode);
      $(scanId).disabled=false;$(stopId).disabled=false;$(startId).disabled=true;
      $(statusId).textContent='Cámara lista';
      setQuality(mode,{quality:'Midiendo',focus:'-',resolution:`${info.settings.width||video.videoWidth||0}×${info.settings.height||video.videoHeight||0}`,ready:'Mantén estable el dispositivo'});
      clearInterval(state.qualityTimer);state.qualityTimer=setInterval(()=>updateLiveQuality(mode),450);
    }catch(err){
      $(statusId).textContent=err?.name==='NotAllowedError'?'Permiso de cámara rechazado':(err?.message||'No se pudo abrir la cámara');
      $(startId).disabled=false;$(scanId).disabled=true;$(stopId).disabled=true;
    }
  }

  function closeCamera(videoId,statusId,startId,scanId,stopId,mode,reset=true){
    const state=cameraState[mode];state.token++;state.scanning=false;
    clearInterval(state.qualityTimer);state.qualityTimer=null;state.previousFrame=null;state.focusBaseline=0;
    if(state.stream)state.stream.getTracks().forEach(t=>t.stop());
    state.stream=null;state.track=null;if(mode==='label')labelStream=null;else stream=null;
    const video=$(videoId);if(video){video.pause();video.srcObject=null;}
    $(scanId).disabled=true;$(stopId).disabled=true;$(startId).disabled=false;
    $(idsForMode(mode).zoomWrap).hidden=true;$(idsForMode(mode).torch).hidden=true;
    if(reset){$(statusId).textContent='Listo';setQuality(mode,{quality:'-',focus:'-',resolution:'-',ready:'Listo'});}
  }

  async function scanSource(source,canvas,statusId,targetInputId,mode,token,validateLive){
    $(statusId).textContent='Preparando lector OCR';
    await ensureTesseract();
    const votes=new Map(),results=[];
    for(let frame=0;frame<3;frame++){
      if(token!==cameraState[mode].token)throw new Error('Lectura cancelada');
      if(validateLive)await waitForSharpFrame(source,statusId,mode,token);
      const frameResults=[];
      for(const variant of OCR_VARIANTS){
        if(token!==cameraState[mode].token)throw new Error('Lectura cancelada');
        drawSourceRegion(source,canvas,mode,variant);
        $(statusId).textContent=frame===0?'Buscando texto':`Confirmando lectura ${frame+1}/3`;
        const result=await runOcr(canvas,statusId,variant);results.push(result);frameResults.push(result);
        if(result.sku&&numericIndex.has(result.sku))break;
      }
      const frameBest=chooseBestOcr(frameResults);
      if(frameBest.sku)votes.set(frameBest.sku,(votes.get(frameBest.sku)||0)+1);
      const confirmed=[...votes.entries()].sort((a,b)=>b[1]-a[1])[0];
      if(confirmed?.[1]>=2)break;
      if(validateLive)await new Promise(r=>setTimeout(r,180));
    }
    const confirmed=[...votes.entries()].sort((a,b)=>b[1]-a[1])[0];
    const best=chooseBestOcr(results),sku=confirmed?.[1]>=2?confirmed[0]:(best.sku&&numericIndex.has(best.sku)?best.sku:'');
    $(targetInputId).value=sku;
    if(sku){$(statusId).textContent=`Lectura encontrada: ${sku}`;if(mode==='label')setLabelProduct(findProduct(sku));else search(sku);}
    else{$(statusId).textContent='No se pudo reconocer; corrige manualmente o intenta nuevamente';if(mode==='label')setLabelProduct(null);}
    return sku;
  }

  async function scanFromCamera(videoId,canvasId,statusId,scanBtnId,targetInputId,mode){
    const state=cameraState[mode],video=$(videoId),canvas=$(canvasId);
    if(!video.videoWidth){$(statusId).textContent='Cámara no lista';return;}
    if(state.scanning)return;state.scanning=true;const token=++state.token;$(scanBtnId).disabled=true;
    try{await scanSource(video,canvas,statusId,targetInputId,mode,token,true);}
    catch(e){if(token===state.token)$(statusId).textContent=e.message||'Error OCR';}
    finally{if(token===state.token){state.scanning=false;$(scanBtnId).disabled=false;}}
  }

  async function toggleTorch(mode){
    const state=cameraState[mode],ids=idsForMode(mode),btn=$(ids.torch);
    const next=btn.dataset.on!=='true';
    if(await safeApply(state.track,{torch:next})){btn.dataset.on=String(next);btn.textContent=next?'Apagar linterna':'Linterna';}
  }

  async function setOpticalZoom(mode,value){
    const state=cameraState[mode],ids=idsForMode(mode),zoom=Number(value);
    if(await safeApply(state.track,{zoom}))$(ids.zoomValue).textContent=`${zoom.toFixed(1)}×`;
  }

  async function loadImageFile(file){
    if(!file)return null;
    if('createImageBitmap' in window){try{return await createImageBitmap(file,{imageOrientation:'from-image'});}catch(e){}}
    return await new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file),img=new Image();
      img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('No se pudo abrir la imagen'));};img.src=url;
    });
  }

  async function scanPhotoFile(mode,input){
    const file=input.files?.[0],ids=idsForMode(mode),state=cameraState[mode];if(!file)return;
    const token=++state.token;state.scanning=true;$(ids.scan).disabled=true;$(ids.status).textContent='Preparando fotografía';
    let image=null,previewUrl='';
    try{
      image=await loadImageFile(file);
      const quality=analyzeFrame(image,mode,false);
      if(!quality.ready&&['Se necesita más luz','Evita el reflejo directo','Aleja ligeramente para enfocar'].includes(quality.reason))throw new Error(quality.reason);
      previewUrl=URL.createObjectURL(file);const preview=$(ids.preview);preview.src=previewUrl;preview.hidden=false;
      await scanSource(image,$(ids.canvas),ids.status,ids.input,mode,token,false);
    }catch(e){if(token===state.token)$(ids.status).textContent=e.message||'No se pudo reconocer la fotografía';}
    finally{image?.close?.();if(previewUrl)setTimeout(()=>URL.revokeObjectURL(previewUrl),1000);input.value='';state.scanning=false;if(cameraState[mode].stream)$(ids.scan).disabled=false;}
  }

  function init(){
    renderAuditHealth();
    updateConnectivity();window.addEventListener('online',updateConnectivity);window.addEventListener('offline',updateConnectivity);
    const latestItem = String(window.PRODUCT_META?.latestItem || '').trim();
    $('latestItem').textContent = latestItem
      ? `Último artículo actualizado: ${latestItem}`
      : 'Último artículo actualizado: información no disponible';
    const tabButtons=[...document.querySelectorAll('.tab')];
    tabButtons.forEach((button,index)=>{
      button.addEventListener('click',()=>showTab(button.dataset.tab));
      button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let next=index;if(event.key==='ArrowLeft')next=(index-1+tabButtons.length)%tabButtons.length;if(event.key==='ArrowRight')next=(index+1)%tabButtons.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabButtons.length-1;showTab(tabButtons[next].dataset.tab,{focus:true});});
    });
    let initialTab=location.hash.slice(1);try{if(!TAB_NAMES.includes(initialTab))initialTab=sessionStorage.getItem('codebrew-tab')||'consulta';}catch(error){initialTab='consulta';}showTab(initialTab,{updateHistory:false});
    window.addEventListener('hashchange',()=>showTab(location.hash.slice(1),{updateHistory:false}));
    $('woeTotal').textContent=Number(window.MERCH_VISUAL_CATALOG?.meta?.products||visualCatalog.length||window.WOE_META?.catalogRows||woeCatalog.length).toLocaleString('es-MX');
    restoreWoeSelection();renderWoeSelection();updateStockFlow();
    renderCatalog('');
    $('catalogLoadMore').addEventListener('click',()=>{catalogVisibleLimit+=48;renderCatalog($('woeSearch').value);});
    $('woeSearch').addEventListener('input',e=>{clearTimeout(woeSuggestionTimer);const value=e.target.value;$('woeSearchClear').hidden=!value;woePdfExported=false;updateWoeFlow();renderCatalog(value);woeSuggestionTimer=setTimeout(()=>renderWoeSuggestions(value),90);});
    $('woeSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addWoeQueries(e.target.value);renderWoeResults();}if(e.key==='Escape'){$('woeSuggestions').hidden=true;e.target.setAttribute('aria-expanded','false');}});
    $('woeAdd').addEventListener('click',()=>{addWoeQueries($('woeSearch').value);renderWoeResults();requestAnimationFrame(()=>$('woeStatus').scrollIntoView({behavior:'smooth',block:'nearest'}));});
    $('woeSearchClear').addEventListener('click',()=>{clearTimeout(woeSuggestionTimer);$('woeSearch').value='';$('woeSearchClear').hidden=true;$('woeSuggestions').hidden=true;$('woeSearch').setAttribute('aria-expanded','false');renderCatalog('');updateWoeFlow();$('woeSearch').focus();});
    $('woeExport').addEventListener('click',generateWoePdf);
    $('woeClear').addEventListener('click',()=>{woeSelection.clear();woePdfExported=false;renderWoeSelection();$('woeResults').innerHTML='';$('woeStatus').classList.remove('warning');$('woeStatus').textContent='Selección limpia. Escribe un dato para comenzar.';$('woeSearch').focus();});
    $('catalogVisualClose').addEventListener('click',()=>$('catalogVisualDialog').close());
    $('catalogVisualDialog').addEventListener('cancel',event=>{event.preventDefault();$('catalogVisualDialog').close();});
    $('catalogVisualDialog').addEventListener('click',event=>{if(event.target===$('catalogVisualDialog'))$('catalogVisualDialog').close();});
    $('stockAttach').addEventListener('click',()=>$('stockPdfInput').click());
    $('stockPdfInput').addEventListener('change',event=>loadStockPdf(event.target.files?.[0]));
    $('stockExport').addEventListener('click',generateStockPdf);
    $('stockClear').addEventListener('click',clearStockReport);
    $('stockConfirmAccept').addEventListener('click',confirmStockReading);
    $('stockConfirmClose').addEventListener('click',closeStockConfirmation);
    $('stockConfirmDialog').addEventListener('cancel',event=>{event.preventDefault();closeStockConfirmation();});
    document.addEventListener('keydown',event=>{
      if(event.altKey&&['1','2','3'].includes(event.key)){event.preventDefault();showTab(TAB_NAMES[Number(event.key)-1],{focus:true});return;}
      if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'')){event.preventDefault();const active=document.querySelector('.tab.active')?.dataset.tab;(active==='woe'?$('woeSearch'):active==='etiquetado'?$('labelSku'):$('manualSku')).focus();}
    });
    $('manualBtn').addEventListener('click', () => search($('manualSku').value));
    $('manualSku').addEventListener('keydown', e => { if(e.key === 'Enter') search(e.target.value); });
    $('labelAddBtn').addEventListener('click', () => addLabel($('labelSku').value, $('labelQty').value));
    $('labelSku').addEventListener('keydown', e => { if(e.key === 'Enter') addLabel(e.target.value, $('labelQty').value); });
    $('labelSku').addEventListener('input', e => setLabelProduct(findProduct(e.target.value)));
    $('labelTier').addEventListener('change', () => renderLabelPreview(findProduct($('labelSku').value)));
    $('clearLabels').addEventListener('click', () => { labelItems.length = 0; renderCart(); });
    $('pdfLabels').addEventListener('click', generatePdf);
    $('startCamera').addEventListener('click', () => openCamera('video','ocrStatus','startCamera','scanBtn','stopCamera','consulta'));
    $('stopCamera').addEventListener('click', () => closeCamera('video','ocrStatus','startCamera','scanBtn','stopCamera','consulta'));
    $('scanBtn').addEventListener('click', () => scanFromCamera('video','snapshot','ocrStatus','scanBtn','manualSku','consulta'));
    $('labelStartCamera').addEventListener('click', () => openCamera('labelVideo','labelOcrStatus','labelStartCamera','labelScanBtn','labelStopCamera','label'));
    $('labelStopCamera').addEventListener('click', () => closeCamera('labelVideo','labelOcrStatus','labelStartCamera','labelScanBtn','labelStopCamera','label'));
    $('labelScanBtn').addEventListener('click', () => scanFromCamera('labelVideo','labelSnapshot','labelOcrStatus','labelScanBtn','labelSku','label'));
    ['consulta','label'].forEach(mode => {
      const ids=idsForMode(mode);
      $(ids.zoom).addEventListener('input',e=>setOpticalZoom(mode,e.target.value));
      $(ids.resetZoom).addEventListener('click',()=>{const z=$(ids.zoom);z.value=z.min;setOpticalZoom(mode,z.min);});
      $(ids.torch).addEventListener('click',()=>toggleTorch(mode));
      $(ids.camera).addEventListener('change',e=>openCamera(ids.video,ids.status,ids.start,ids.scan,ids.stop,mode,e.target.value));
      $(ids.photo).addEventListener('change',e=>scanPhotoFile(mode,e.target));
      $(ids.takePhoto).addEventListener('change',e=>scanPhotoFile(mode,e.target));
    });
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){
        closeCamera('video','ocrStatus','startCamera','scanBtn','stopCamera','consulta',false);
        closeCamera('labelVideo','labelOcrStatus','labelStartCamera','labelScanBtn','labelStopCamera','label',false);
        $('ocrStatus').textContent='Cámara pausada';$('labelOcrStatus').textContent='Cámara pausada';
      }
    });
    window.addEventListener('pagehide',()=>{
      closeCamera('video','ocrStatus','startCamera','scanBtn','stopCamera','consulta',false);
      closeCamera('labelVideo','labelOcrStatus','labelStartCamera','labelScanBtn','labelStopCamera','label',false);
    });
    renderCart();
    if('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=codebrew-v23-remastered-catalog'));
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
