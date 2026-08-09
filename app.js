(() => {
  const $ = (id) => document.getElementById(id);
  const products = window.PRODUCTS || [];
  const woeCatalog = window.WOE_CATALOG || [];
  const woeSelection = new Map();
  let stream = null;
  let labelStream = null;
  let currentProduct = null;
  let currentTier = 'C2';
  const labelItems = [];
  const OCR_MIN_FOCUS = 18;
  const OCR_TARGET_MAX_SIDE = 1600;
  const OCR_VARIANTS = ['normal','contrast','binary'];
  const cameraState = {
    consulta:{ stream:null, track:null, scanning:false, token:0, qualityTimer:null, previousFrame:null, focusBaseline:0, deviceId:'' },
    label:{ stream:null, track:null, scanning:false, token:0, qualityTimer:null, previousFrame:null, focusBaseline:0, deviceId:'' }
  };


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

  const woeSearchRows = woeCatalog.map((item,index) => ({
    item,index,
    text:normalizeText([
      item.idWoe,item.codigoDia,item.descripcionSap,
      ...(item.micros||[]),
      ...(item.merch||[]).flatMap(row => [row.descripcionSci,row.nombrePos,row.nombreInventario,row.skuIntl,row.skuPos,row.base])
    ].join(' '))
  }));
  const woeExactIndex = new Map();
  woeCatalog.forEach(item => {
    [item.idWoe,item.codigoDia].forEach(value => {
      const key=normalizeSku(value);
      if(!key)return;
      const rows=woeExactIndex.get(key)||[];
      rows.push(item);woeExactIndex.set(key,rows);
    });
  });
  let woeSuggestionTimer=null;

  function woeKey(item,index=''){ return `${item.idWoe||'sin-woe'}|${item.codigoDia}|${item.sourceRow || item.origin || index}`; }
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
        <b>${escapeHtml(item.codigoDia)}</b><span>${escapeHtml(item.descripcionSap||(item.micros||[])[0]||item.merch?.[0]?.descripcionSci||'Sin descripción disponible')}</span><small>${item.idWoe?`WOE ${escapeHtml(item.idWoe)}`:'Sin cruce WOE'}</small>
      </button>`).join(''):`<div class="woe-no-suggestion">Sin coincidencia para “${escapeHtml(query)}”.</div>`;
    box.hidden=false;input.setAttribute('aria-expanded','true');
    box.querySelectorAll('[data-woe-suggestion]').forEach((button,index)=>button.addEventListener('click',()=>{
      addWoeItem(matches[index]);input.value='';box.hidden=true;input.setAttribute('aria-expanded','false');input.focus();
    }));
  }

  function addWoeItem(item,render=true){
    woeSelection.set(woeKey(item,woeSelection.size),item);
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
    if(missing.length)$('woeStatus').innerHTML=`<b>Aviso · sin coincidencia:</b> ${missing.map(escapeHtml).join(', ')}. No existe en SAP, Micros ni MERCH; valida el dato en el Excel motor.`;
    else if(added)$('woeStatus').textContent=`${added} coincidencia${added===1?'':'s'} agregada${added===1?'':'s'} a la selección.`;
    else $('woeStatus').textContent='No se agregaron registros nuevos.';
    return {added,missing};
  }

  function renderWoeSelection(){
    const target=$('woeSelection'),items=[...woeSelection.entries()];
    $('woeSelectedCount').textContent=items.length;
    $('woeCopyList').disabled=!items.length;$('woeExport').disabled=!items.length;
    if(!items.length){target.innerHTML='<span class="woe-empty-selection">Sin elementos seleccionados.</span>';return;}
    target.innerHTML=items.map(([key,item])=>`<span class="woe-chip"><b>${escapeHtml(item.codigoDia)}</b> · ${escapeHtml(item.descripcionSap||(item.micros||[])[0]||item.merch?.[0]?.descripcionSci||item.idWoe||'Sin cruce')}<button type="button" aria-label="Quitar ${escapeHtml(item.codigoDia)}" data-woe-remove="${escapeHtml(key)}">×</button></span>`).join('');
    target.querySelectorAll('[data-woe-remove]').forEach(button=>button.addEventListener('click',()=>{woeSelection.delete(button.dataset.woeRemove);renderWoeSelection();if($('woeResults').children.length)renderWoeResults();}));
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

  function woeExportRows(){
    return selectedWoeItems().map(({item})=>{
      const status=operationalWoeStatus(item),merch=item.merch||[];
      return [item.descripcionSap||'Sin descripción SAP',(item.micros||[]).join(' | ')||'Sin coincidencia Micros',item.codigoDia||'',item.idWoe||'',status.label,merch.map(row=>row.skuIntl||row.skuPos).filter(Boolean).join(' | ')||'No aplica'];
    });
  }

  function comparisonText(separator='\t'){
    const rows=[['Descripción SAP','Nombre Micros','#DIA','#SAP','Validación','SKU MERCH (referencia)'],...woeExportRows()];
    return rows.map(row=>row.join(separator)).join('\n');
  }

  async function copyWoeComparison(){
    try{await navigator.clipboard.writeText(comparisonText());$('woeCopyList').textContent='Tabla copiada';setTimeout(()=>$('woeCopyList').textContent='Copiar tabla',1300);}catch(e){$('woeStatus').classList.add('warning');$('woeStatus').textContent='No se pudo copiar. Genera el PDF para conservar el listado.';}
  }

  function woePdfConfig(){
    return window.WOE_PDF_CONFIG||{page:{orientation:'landscape',format:'letter',unit:'pt',width:792,height:612,margin:24,tableTop:78,tableBottom:574,footerY:598},columns:[{key:'descripcionSap',label:'DESCRIPCION SAP',width:240},{key:'nombreMicros',label:'NOMBRE MICROS',width:165},{key:'codigoDia',label:'#DIA',width:50},{key:'idWoe',label:'#SAP',width:60},{key:'validacion',label:'VALIDACION',width:105},{key:'skuMerch',label:'SKU MERCH - APOYO',width:124}],style:{titleSize:18,metaSize:8,headerSize:7.2,bodySize:7.4,lineHeight:8.6,cellPadding:5,maxLinesPerCell:4,green:[0,98,65],dark:[7,63,47],cream:[249,246,239],line:[221,225,220],warning:[180,83,9]}};
  }

  function pdfWoeRows(){
    return selectedWoeItems().map(({item})=>{const status=operationalWoeStatus(item),merch=item.merch||[];return {descripcionSap:item.descripcionSap||'Sin descripcion SAP',nombreMicros:(item.micros||[]).join(' | ')||'Sin coincidencia Micros',codigoDia:item.codigoDia||'-',idWoe:item.idWoe||'-',validacion:status.label,skuMerch:merch.map(row=>row.skuIntl||row.skuPos).filter(Boolean).join(' | ')||'No aplica',statusKind:status.kind};});
  }

  function generateWoePdf(){
    const rows=pdfWoeRows();
    if(!rows.length){$('woeStatus').classList.add('warning');$('woeStatus').textContent='Agrega al menos un artículo antes de generar el PDF.';return;}
    if(!window.jspdf?.jsPDF){$('woeStatus').classList.add('warning');$('woeStatus').textContent='El generador PDF no está disponible. Revisa tu conexión e intenta nuevamente.';return;}
    const exportButton=$('woeExport'),originalLabel=exportButton.textContent;exportButton.disabled=true;exportButton.textContent='Generando PDF...';
    try{
    const config=woePdfConfig(),page=config.page,style=config.style,columns=config.columns,{jsPDF}=window.jspdf;
    const doc=new jsPDF({orientation:page.orientation,unit:page.unit,format:page.format,compress:true,putOnlyUsedFonts:true});
    const selected=rows.length,valid=rows.filter(row=>row.statusKind==='ok').length,review=selected-valid,date=new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(new Date());
    const pageWidth=doc.internal.pageSize.getWidth(),pageHeight=doc.internal.pageSize.getHeight(),tableLeft=page.margin,headerHeight=22;

    function safeLines(value,width){
      const lines=doc.splitTextToSize(String(value||'-'),Math.max(20,width-(style.cellPadding*2)));
      if(lines.length<=style.maxLinesPerCell)return lines;
      const clipped=lines.slice(0,style.maxLinesPerCell);clipped[clipped.length-1]=`${clipped[clipped.length-1].replace(/\s+$/,'')}...`;return clipped;
    }
    function drawHeader(){
      doc.setFillColor(...style.green);doc.roundedRect(page.margin,18,8,42,3,3,'F');
      doc.setTextColor(...style.dark);doc.setFont('helvetica','bold');doc.setFontSize(style.titleSize);doc.text('WOE - Lista de doble check',page.margin+16,33);
      doc.setFont('helvetica','normal');doc.setFontSize(style.metaSize);doc.text(`${selected} articulos | ${valid} validados | ${review} por revisar | ${date}`,page.margin+16,47);
      doc.setTextColor(70,82,76);doc.text('Validacion operativa: SAP + Micros. MERCH se muestra solo como referencia opcional por SKU.',page.margin+16,59);
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
        const isStatus=column.key==='validacion';doc.setTextColor(...(isStatus&&row.statusKind!=='ok'?style.warning:style.dark));doc.setFont('helvetica',isStatus||column.key==='codigoDia'||column.key==='idWoe'?'bold':'normal');
        doc.text(cells[index],x+style.cellPadding,y+style.cellPadding+style.bodySize,{lineHeightFactor:style.lineHeight/style.bodySize,maxWidth:column.width-(style.cellPadding*2)});x+=column.width;
      });
      y+=rowHeight;
    });
    const totalPages=doc.getNumberOfPages();for(let number=1;number<=totalPages;number++){doc.setPage(number);drawFooter(number,totalPages);}
    doc.save(`WOE_Lista_Doble_Check_${new Date().toISOString().slice(0,10)}.pdf`);
    $('woeStatus').classList.remove('warning');$('woeStatus').innerHTML=`<b>PDF generado:</b> ${selected} artículos acomodados en tamaño carta con ${totalPages} página${totalPages===1?'':'s'}.`;
    }catch(error){$('woeStatus').classList.add('warning');$('woeStatus').textContent='No fue posible generar el PDF. Conservamos tu listado para que puedas intentarlo nuevamente.';}
    finally{exportButton.disabled=false;exportButton.textContent=originalLabel;}
  }

  function renderWoeResults(){
    if(!woeSelection.size&&$('woeSearch').value.trim())addWoeQueries($('woeSearch').value);
    const rows=selectedWoeItems(),items=rows.map(row=>row.item),target=$('woeResults');
    if(!items.length){target.innerHTML='';$('woeStatus').classList.remove('warning');$('woeStatus').textContent='No hay registros seleccionados. Busca por WOE, Código DIA o nombre.';return;}
    const reviewed=items.filter(item=>operationalWoeStatus(item).kind==='ok').length,needsReview=items.length-reviewed;
    target.innerHTML=`<div class="woe-result-summary"><div><strong>${items.length}</strong><span>artículos</span></div><div class="ok"><strong>${reviewed}</strong><span>validados</span></div><div class="review"><strong>${needsReview}</strong><span>por revisar</span></div></div><div class="woe-table-wrap"><table class="woe-table"><thead><tr><th>Descripción SAP</th><th>Nombre Micros</th><th>#DIA</th><th>#SAP</th><th>Validación</th><th>Referencia opcional</th><th></th></tr></thead><tbody>${rows.map(({key,item})=>{const status=operationalWoeStatus(item);return `<tr><td data-label="Descripción SAP"><strong>${escapeHtml(item.descripcionSap||'Sin descripción SAP')}</strong></td><td data-label="Nombre Micros">${(item.micros||[]).length?(item.micros||[]).map(escapeHtml).join('<br>'):'<span class="woe-missing">Sin coincidencia</span>'}</td><td data-label="#DIA"><b class="woe-code">${escapeHtml(item.codigoDia||'—')}</b></td><td data-label="#SAP"><b>${escapeHtml(item.idWoe||'—')}</b></td><td data-label="Validación"><span class="woe-op-status ${status.kind}">${status.kind==='ok'?'✓':'!'} ${escapeHtml(status.label)}</span></td><td data-label="Referencia opcional">${merchReferenceHtml(item)}</td><td><button type="button" class="woe-row-remove" data-woe-row-remove="${escapeHtml(key)}" aria-label="Quitar Código DIA ${escapeHtml(item.codigoDia)}">×</button></td></tr>`;}).join('')}</tbody></table></div>`;
    $('woeStatus').classList.toggle('warning',needsReview>0);
    $('woeStatus').innerHTML=needsReview?`<b>Doble check:</b> ${reviewed} validados en SAP + Micros y ${needsReview} por revisar. MERCH no afecta este resultado.`:`<b>Listo:</b> los ${reviewed} artículos tienen cruce SAP + Micros. MERCH se muestra sólo cuando existe como referencia por SKU.`;
    target.querySelectorAll('[data-woe-row-remove]').forEach(button=>button.addEventListener('click',()=>{woeSelection.delete(button.dataset.woeRowRemove);renderWoeSelection();renderWoeResults();}));
  }

  function search(raw){ const p = findProduct(raw); p ? renderProduct(p, raw) : renderNotFound(raw); }

  function showTab(name){
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('active', p.id === name));
  }

  function updateLabelTier(p){
    const sel = $('labelTier'); const keys = p ? tierKeys(p) : ['C1'];
    sel.innerHTML = (keys.length ? keys : ['C2']).map(k => `<option value="${k}">${k}${p?.tier?.[k] ? ' · '+p.tier[k] : ''}</option>`).join('');
    if (p && keys.includes('C2')) sel.value = 'C2';
    sel.disabled = !p || keys.length <= 1;
  }

  function setLabelProduct(p){ updateLabelTier(p); renderLabelPreview(p); }

  function renderLabelPreview(p){
    if (!p) { $('labelPreview').className = 'label-preview empty-small'; $('labelPreview').textContent = 'SKU / nombre no encontrado para etiquetado.'; updateLabelTier(null); return; }
    const tier = $('labelTier').value || tierKeys(p)[0] || 'C1';
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

  function generatePdf(){
    if (!window.jspdf || !window.jspdf.jsPDF) { alert('No cargó el generador PDF. Revisa internet/CDN.'); return; }
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
    const { data:{ text, confidence } } = await Tesseract.recognize(canvas, 'eng', {
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
    if(!window.Tesseract)throw new Error('OCR no cargó; revisa la conexión inicial.');
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
    const latestItem = String(window.PRODUCT_META?.latestItem || '').trim();
    $('latestItem').textContent = latestItem
      ? `Último artículo actualizado: ${latestItem}`
      : 'Último artículo actualizado: información no disponible';
    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
    $('woeTotal').textContent=Number(window.WOE_META?.catalogRows||woeCatalog.length).toLocaleString('es-MX');
    $('woeSearch').addEventListener('input',e=>{clearTimeout(woeSuggestionTimer);const value=e.target.value;woeSuggestionTimer=setTimeout(()=>renderWoeSuggestions(value),90);});
    $('woeSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addWoeQueries(e.target.value);renderWoeResults();}if(e.key==='Escape'){$('woeSuggestions').hidden=true;e.target.setAttribute('aria-expanded','false');}});
    $('woeAdd').addEventListener('click',()=>addWoeQueries($('woeSearch').value));
    $('woeRun').addEventListener('click',()=>{renderWoeResults();requestAnimationFrame(()=>$('woeStatus').scrollIntoView({behavior:'smooth',block:'start'}));});
    $('woeCopyList').addEventListener('click',copyWoeComparison);
    $('woeExport').addEventListener('click',generateWoePdf);
    $('woeClear').addEventListener('click',()=>{woeSelection.clear();renderWoeSelection();$('woeResults').innerHTML='';$('woeStatus').classList.remove('warning');$('woeStatus').textContent='Selección limpia. Escribe un dato para comenzar.';$('woeSearch').focus();});
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
    if('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=codebrew-v9-woe-pdf'));
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
