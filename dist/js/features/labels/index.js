/*
 * Emissor de etiquetas PRELUX.
 *
 * As etiquetas de pedidos concluídos vêm do Supabase. O editor avulso e seu
 * histórico local continuam disponíveis para uso fora desse fluxo.
 */
export function initializeLabels({ operationsRepository } = {}) {
const $ = (id) => document.getElementById(id);
    const template = new Image();
    const canvas = $('labelCanvas'); const ctx = canvas.getContext('2d');
    const fields = { id:$('pieceId'), quantity:$('quantity'), client:$('client'), notes:$('notes') };
    let editingKey = null; let previewIndex = 1;
    let activeGenerated = null;
    let generatedLabels = [];
    let generatedOrderId = null;
    let printRecords = null;
    const pendingPrintKey = 'prelux-label-print-requests-v1';
    const key = 'prelux-rastreabilidade-registros-v1';
    // Persistência local: o histórico de etiquetas fica no navegador atual.
    const getRecords = () => { try{return JSON.parse(localStorage.getItem(key)||'[]')}catch{return[]} };
    const setRecords = (items) => localStorage.setItem(key, JSON.stringify(items));
    const showToast = (msg) => { const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>t.classList.remove('show'),2600); };
    async function recordGeneratedLabelPrints(records){
      const printedBy=$('labelPrintActor').value.trim();
      if(!printedBy){$('labelPrintActor').focus();throw new Error('Informe o responsável pela emissão ou reimpressão.');}
      if(!operationsRepository?.recordProductionLabelPrints)throw new Error('O registro de impressões ainda não está disponível.');
      const labels=records.map(record=>({productionOrderId:record.production_order_id,versionNumber:record.version_number||1}))
        .sort((a,b)=>a.productionOrderId.localeCompare(b.productionOrderId));
      const signature=JSON.stringify({printedBy,labels});
      let pending={};
      try{pending=JSON.parse(sessionStorage.getItem(pendingPrintKey)||'{}')}catch{}
      const idempotencyKey=pending[signature]||crypto.randomUUID();
      if(!pending[signature]){
        pending[signature]=idempotencyKey;
        const keys=Object.keys(pending);if(keys.length>20)delete pending[keys[0]];
        try{sessionStorage.setItem(pendingPrintKey,JSON.stringify(pending))}catch{}
      }
      const result=await operationsRepository.recordProductionLabelPrints({printedBy,idempotencyKey,labels});
      delete pending[signature];try{sessionStorage.setItem(pendingPrintKey,JSON.stringify(pending))}catch{}
      return result;
    }
    const getQuantity = () => Math.max(1,Math.min(100,Number.parseInt(fields.quantity.value,10)||1));
    const normalizeBase = (value) => String(value||'').trim().toUpperCase().replace(/\s+/g,'-');
    const labelId = (index=1) => { if(activeGenerated)return activeGenerated.label_code;const base=normalizeBase(fields.id.value); return base ? `${base}-${String(index).padStart(3,'0')}` : '—'; };
    const recordBase = (r) => normalizeBase(r.baseId || String(r.id||'').replace(/-\d{3}$/,''));
    const recordQuantity = (r) => Math.max(1,Math.min(100,Number.parseInt(r.quantity,10)||1));
    const recordKey = (r) => r.key || `${recordBase(r)}|${r.client||''}`;
    const recordRange = (r) => { const base=recordBase(r), qty=recordQuantity(r); return qty===1?`${base}-001`:`${base}-001 até ${base}-${String(qty).padStart(3,'0')}`; };
    function fitText(text, maxWidth, font, maxSize=36){ let size=maxSize; ctx.font=font.replace('{size}',size); while(ctx.measureText(text).width>maxWidth&&size>16){size-=1;ctx.font=font.replace('{size}',size)} return size; }
    function makeLines(text,maxWidth){ const words=(text||'').trim().split(/\s+/).filter(Boolean);let line='',lines=[];for(const word of words){if(ctx.measureText(word).width>maxWidth){if(line){lines.push(line);line=''}let chunk='';for(const character of word){const test=chunk+character;if(ctx.measureText(test).width>maxWidth&&chunk){lines.push(chunk);chunk=character}else chunk=test}line=chunk;continue}const test=line?line+' '+word:word;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=word}else line=test}if(line)lines.push(line);return lines; }
    function updateNotesCounter(){const count=Math.min(500,fields.notes.value.length);$('notesCount').textContent=`${count}/500`;$('notesCount').classList.toggle('limit',count>=500)}
    function drawObservationText(text){ if(!text)return;const top=706,height=250,maxWidth=1400;let chosen=null;for(let size=36;size>=12;size--){ctx.font=`700 ${size}px Arial`;const lineHeight=Math.round(size*1.18),lines=makeLines(text.slice(0,500),maxWidth),maxLines=Math.floor(height/lineHeight);if(lines.length<=maxLines){chosen={size,lineHeight,lines};break}}if(!chosen){const size=12;ctx.font=`700 ${size}px Arial`;const lineHeight=15;let lines=makeLines(text.slice(0,500),maxWidth).slice(0,Math.floor(height/lineHeight));if(lines.length)lines[lines.length-1]=`${lines[lines.length-1].slice(0,-1)}…`;chosen={size,lineHeight,lines}}ctx.font=`700 ${chosen.size}px Arial`;ctx.fillStyle='#111';const total=chosen.lines.length*chosen.lineHeight;const firstY=top+(height-total)/2+chosen.lineHeight/2;chosen.lines.forEach((line,i)=>ctx.fillText(line,59,firstY+i*chosen.lineHeight)); }
    // Renderiza a etiqueta no canvas usando o modelo PNG e os campos preenchidos.
    function drawLabel(idOverride=null, record=null){
      if(!template.complete||!template.naturalWidth)return;
      const id=idOverride || (fields.id.value.trim()?labelId(previewIndex):'—'); const client=(record?.client_name || fields.client.value).trim()||'—'; const notes=(record?.observations ?? fields.notes.value).trim().slice(0,500);
      ctx.clearRect(0,0,1536,1024);ctx.drawImage(template,0,0,1536,1024);ctx.fillStyle='#111';ctx.textBaseline='middle';
      ctx.font=`800 ${fitText(id,920,'800 {size}px Arial',37)}px Arial`;ctx.fillText(id,520,316);
      ctx.font=`800 ${fitText(client,920,'800 {size}px Arial',37)}px Arial`;ctx.fillText(client,520,424);
      // As caixas de status permanecem vazias para preenchimento manual na fábrica.
      drawObservationText(notes);
      $('previewMeta').textContent=`Etiqueta ${previewIndex} de ${getQuantity()} · PNG · 1536 × 1024 px`;
    }
    function updatePreview(){ previewIndex=Math.max(1,Math.min(getQuantity(),previewIndex)); drawLabel(); }
    template.onload=updatePreview; template.src='assets/PRE_RASTRE.png';
    async function ensureTemplate(){if(!template.complete||!template.naturalWidth)await template.decode();}
    ['input','change'].forEach(ev=>document.addEventListener(ev,e=>{if(e.target.closest('#pieceForm')){if(e.target===fields.quantity)previewIndex=1;if(e.target===fields.notes)updateNotesCounter();updatePreview();}}));
    function setGeneratedMode(enabled){for(const field of Object.values(fields))field.readOnly=enabled;$('saveBtn').hidden=enabled;$('sampleBtn').hidden=enabled;$('pieceForm').querySelector('button[type="submit"]').hidden=enabled;$('downloadAllBtn').hidden=enabled;$('printBtn').hidden=enabled;}
    function resetForm(){ activeGenerated=null;setGeneratedMode(false);$('pieceForm').reset(); fields.quantity.value=1; editingKey=null; $('saveBtn').textContent='Salvar peça'; previewIndex=1; updateNotesCounter(); updatePreview(); }
    // Atualiza a tabela de histórico a partir dos registros salvos localmente.
    function renderRecords(){ const q=$('search').value.toLowerCase().trim();const all=getRecords();const rows=all.filter(r=>`${recordBase(r)} ${recordRange(r)} ${r.client} ${r.notes}`.toLowerCase().includes(q));$('recordCount').textContent=`${all.length} registro${all.length===1?'':'s'} salvo${all.length===1?'':'s'} neste navegador`; $('recordsBody').innerHTML=rows.length?rows.map(r=>`<tr><td>${escapeHtml(recordRange(r))}</td><td>${recordQuantity(r)}</td><td>${escapeHtml(r.client||'—')}</td><td>${escapeHtml(r.notes||'—')}</td><td><div class="row-actions"><button class="icon-btn" data-action="load" data-key="${encodeURIComponent(recordKey(r))}">Editar</button><button class="icon-btn" data-action="png" data-key="${encodeURIComponent(recordKey(r))}">PNG</button><button class="icon-btn" data-action="delete" data-key="${encodeURIComponent(recordKey(r))}">Excluir</button></div></td></tr>`).join(''):`<tr><td colspan="5" class="empty">Nenhuma peça encontrada.</td></tr>`; }
    function escapeHtml(v){return String(v).replace(/[&<>'"]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[s]))}
    function renderGeneratedLabels(){
      const visible=generatedLabels.filter(label=>!generatedOrderId||label.order_id===generatedOrderId);
      document.querySelector('.label-print-actor').hidden=visible.length===0;
      $('generatedLabelCount').textContent=`${visible.length} etiqueta${visible.length===1?'':'s'} gerada${visible.length===1?'':'s'} no banco`;
      const groups=new Map();
      for(const label of visible){const rows=groups.get(label.order_id)||[];rows.push(label);groups.set(label.order_id,rows);}
      $('generatedLabelsBody').innerHTML=groups.size?[...groups].map(([orderId,rows])=>{
        rows.sort((a,b)=>a.label_code.localeCompare(b.label_code,'pt-BR'));
        const order=escapeHtml(rows[0].order_number);
        return `<tr class="generated-order-row"><td colspan="4"><strong>${order}</strong> · ${rows.length} etiqueta${rows.length===1?'':'s'} <span class="row-actions"><button class="icon-btn" type="button" data-generated-action="zip-order" data-order-id="${escapeHtml(orderId)}">Baixar pedido (ZIP)</button><button class="icon-btn" type="button" data-generated-action="print-order" data-order-id="${escapeHtml(orderId)}">Imprimir pedido</button></span></td></tr>`+
          rows.map(label=>`<tr><td><strong>${escapeHtml(label.label_code)}</strong><span class="muted">${order} · v${Number(label.version_number)||1}</span></td><td>${escapeHtml(label.piece_code)} · ${escapeHtml(label.piece_name)}</td><td>${escapeHtml(label.client_name)}</td><td><div class="row-actions"><button class="icon-btn" type="button" data-generated-action="preview" data-label-id="${escapeHtml(label.production_order_id)}">Prévia</button><button class="icon-btn" type="button" data-generated-action="png" data-label-id="${escapeHtml(label.production_order_id)}">PNG</button></div></td></tr>`).join('');
      }).join(''):`<tr><td colspan="4" class="empty">${generatedOrderId?'Nenhuma etiqueta deste pedido.':'As etiquetas são geradas quando o pedido é aprovado e a produção começa.'}</td></tr>`;
    }
    function loadGeneratedLabel(label){
      activeGenerated=label;editingKey=null;fields.id.value=label.label_code;fields.quantity.value=1;
      fields.client.value=label.client_name;fields.notes.value=label.observations||'';
      setGeneratedMode(true);previewIndex=1;updateNotesCounter();updatePreview();
      $('editorCard').scrollIntoView({behavior:'smooth',block:'start'});
    }
    async function openGeneratedLabels(event){
      generatedOrderId=event?.detail?.orderId||null;
      try{
        const data=Array.isArray(event?.detail?.data?.productionLabels)
          ? event.detail.data : await operationsRepository.getOperationsData();
        generatedLabels=data.productionLabels||[];
        if(activeGenerated&&!generatedLabels.some(label=>label.production_order_id===activeGenerated.production_order_id&&(!generatedOrderId||label.order_id===generatedOrderId)))resetForm();
        renderGeneratedLabels();
      }catch(error){
        document.querySelector('.label-print-actor').hidden=true;
        $('generatedLabelCount').textContent='Não foi possível carregar as etiquetas.';
        $('generatedLabelsBody').innerHTML=`<tr><td colspan="4" class="empty">${escapeHtml(error.message||'Falha de conexão.')}</td></tr>`;
      }
    }
    window.addEventListener('prelux:labels:open',openGeneratedLabels);
    $('generatedLabelsBody').addEventListener('click',async event=>{
      const button=event.target.closest('button[data-generated-action]');if(!button)return;
      const action=button.dataset.generatedAction;
      const label=generatedLabels.find(row=>row.production_order_id===button.dataset.labelId);
      const orderRows=generatedLabels.filter(row=>row.order_id===button.dataset.orderId);
      if(action==='preview'&&label){loadGeneratedLabel(label);return;}
      if(action==='png'&&label){loadGeneratedLabel(label);exportPng(label.label_code,1,label);return;}
      if(!orderRows.length)return;
      if(action==='print-order'){openPrintModal(orderRows);return;}
      if(action==='zip-order'){
        button.disabled=true;const old=button.textContent;button.textContent='Gerando ZIP…';
        try{const blob=await buildZip(orderRows);await recordGeneratedLabelPrints(orderRows);const link=document.createElement('a');link.download=`PRELUX_${normalizeBase(orderRows[0].order_number)}_ETIQUETAS.zip`;link.href=URL.createObjectURL(blob);link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);showToast(`${orderRows.length} etiquetas do pedido geradas.`);}
        catch(error){showToast(error.message||'Não foi possível gerar o ZIP.');}
        finally{button.disabled=false;button.textContent=old;drawLabel();}
      }
    });
    function findRecord(k){return getRecords().find(x=>recordKey(x)===k)}
    function loadRecord(k){ const r=findRecord(k);if(!r)return;activeGenerated=null;setGeneratedMode(false);fields.id.value=recordBase(r);fields.quantity.value=recordQuantity(r);fields.client.value=r.client||'';fields.notes.value=(r.notes||'').slice(0,500);updateNotesCounter();editingKey=recordKey(r);$('saveBtn').textContent='Atualizar peça';previewIndex=1;updatePreview();window.scrollTo({top:0,behavior:'smooth'}); }
    // Gera e baixa uma etiqueta PNG individual.
    async function exportPng(recordName,index=previewIndex,generatedRecord=null){try{await ensureTemplate();previewIndex=Math.max(1,Math.min(getQuantity(),index));drawLabel(labelId(previewIndex));const png=canvas.toDataURL('image/png');if(generatedRecord)await recordGeneratedLabelPrints([generatedRecord]);const link=document.createElement('a');link.download=`PRELUX_${(recordName||labelId(previewIndex)||'etiqueta').replace(/[^a-z0-9_-]+/gi,'_')}.png`;link.href=png;link.click();drawLabel();showToast('Etiqueta PNG baixada.');}catch(error){showToast(error.message||'Não foi possível carregar o modelo da etiqueta.');}}
    function concatBytes(parts){const total=parts.reduce((n,p)=>n+p.length,0);const out=new Uint8Array(total);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length}return out}
    // Rotinas para montar um arquivo ZIP sem dependências externas.
    const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
    function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0}
    const u16=(n)=>new Uint8Array([n&255,(n>>>8)&255]); const u32=(n)=>new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);
    async function canvasBytes(id,record=null){await ensureTemplate();drawLabel(id,record);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('Não foi possível desenhar a etiqueta.');return new Uint8Array(await blob.arrayBuffer())}
    async function buildZip(records=null){
      const entries=records?records.map(record=>({id:record.label_code,record}))
        :Array.from({length:getQuantity()},(_,index)=>({id:labelId(index+1),record:null}));
      const files=[];
      for(const entry of entries){
        const filename=`PRELUX_${entry.id.replace(/[^a-z0-9_-]+/gi,'_')}.png`;
        files.push({name:filename,data:await canvasBytes(entry.id,entry.record)});
      }
      const locals=[],centrals=[];let offset=0;
      for(const file of files){
        const name=new TextEncoder().encode(file.name),crc=crc32(file.data),size=file.data.length;
        const local=concatBytes([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(size),u32(size),u16(name.length),u16(0),name,file.data]);
        locals.push(local);centrals.push({name,crc,size,offset});offset+=local.length;
      }
      const centralOffset=offset,centralParts=centrals.map(file=>concatBytes([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(file.crc),u32(file.size),u32(file.size),u16(file.name.length),u16(0),u16(0),u16(0),u16(0),u32(file.offset),file.name]));
      const centralSize=centralParts.reduce((sum,part)=>sum+part.length,0);
      return new Blob([...locals,...centralParts,concatBytes([u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(centralSize),u32(centralOffset),u16(0)])],{type:'application/zip'});
    }
    // Formatos de papel e cálculo de quantas etiquetas cabem por folha.
    const PAPERS={"210x297":{"name":"A4","w":210,"h":297},"297x420":{"name":"A3","w":297,"h":420},"320x450":{"name":"SRA3","w":320,"h":450},"420x594":{"name":"A2","w":420,"h":594},"216x279":{"name":"Carta","w":216,"h":279},"216x356":{"name":"Ofício","w":216,"h":356},"600x900":{"name":"60 × 90 cm","w":600,"h":900}};
    function getLabelDimensions(){const value=$('labelSize').value;if(value==='custom')return{w:Number($('customLabelW').value)||150,h:Number($('customLabelH').value)||100};const [w,h]=value.split('x').map(Number);return{w,h}}
    function fitLayout(w,h,lw,lh,margin,gap){const cols=Math.max(0,Math.floor((w-2*margin+gap)/(lw+gap)));const rows=Math.max(0,Math.floor((h-2*margin+gap)/(lh+gap)));return{w,h,cols,rows,perSheet:cols*rows}}
    function getPrintConfig(){const paper=PAPERS[$('paperSize').value],label=getLabelDimensions(),margin=Math.max(0,Number($('printMargin').value)||0),gap=Math.max(0,Number($('printGap').value)||0),orientation=$('paperOrientation').value;let choices=orientation==='portrait'?[fitLayout(paper.w,paper.h,label.w,label.h,margin,gap)]:orientation==='landscape'?[fitLayout(paper.h,paper.w,label.w,label.h,margin,gap)]:[fitLayout(paper.w,paper.h,label.w,label.h,margin,gap),fitLayout(paper.h,paper.w,label.w,label.h,margin,gap)];const layout=choices.sort((a,b)=>b.perSheet-a.perSheet)[0],count=printRecords?.length??getQuantity();return{paper,label,margin,gap,orientation:layout.w===paper.w?'Retrato':'Paisagem',...layout,sheets:layout.perSheet?Math.ceil(count/layout.perSheet):0,count}}
    function updatePrintSummary(){const c=getPrintConfig();$('customSize').classList.toggle('visible',$('labelSize').value==='custom');if(!c.perSheet){$('printSummary').innerHTML='<strong>Essa combinação não comporta a etiqueta.</strong><br>Reduza o tamanho da etiqueta ou a margem.';return}const utilization=(c.perSheet*c.label.w*c.label.h/(c.w*c.h)*100).toFixed(0);$('printSummary').innerHTML=`<strong>${c.paper.name} · ${c.orientation}</strong> (${c.w} × ${c.h} mm)<br><strong>${c.perSheet} etiquetas por folha</strong> · ${c.sheets} folha${c.sheets===1?'':'s'} para ${c.count} peça${c.count===1?'':'s'} · aproveitamento aproximado: ${utilization}%`}
    function openPrintModal(records=null){printRecords=Array.isArray(records)?records:null;$('printModal').hidden=false;updatePrintSummary();}
    function closePrintModal(){ $('printModal').hidden=true; }
    // Monta as páginas de impressão e abre a janela de impressão do navegador.
    async function generatePrint(){const c=getPrintConfig();if(!c.perSheet){showToast('A etiqueta não cabe nessa configuração.');return}const btn=$('confirmPrint'),old=btn.textContent;btn.disabled=true;btn.textContent='Montando impressão…';let w=null;try{if(printRecords){w=window.open('','_blank');if(!w){showToast('Permita pop-ups para gerar a impressão.');return}}await ensureTemplate();const images=[];if(printRecords){for(const record of printRecords){drawLabel(record.label_code,record);images.push(canvas.toDataURL('image/png'));}}else{for(let i=1;i<=getQuantity();i++){drawLabel(labelId(i));images.push(canvas.toDataURL('image/png'));}}drawLabel();if(printRecords)await recordGeneratedLabelPrints(printRecords);const pages=[];for(let start=0;start<images.length;start+=c.perSheet){const chunk=images.slice(start,start+c.perSheet);pages.push(`<div class="print-sheet">${chunk.map(src=>`<img src="${src}">`).join('')}</div>`)}w ||= window.open('','_blank');if(!w){showToast('Permita pop-ups para gerar a impressão.');return}w.document.write(`<html><head><title>Impressão PRELUX — ${c.paper.name}</title><style>@page{size:${c.w}mm ${c.h}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}.print-sheet{width:${c.w}mm;height:${c.h}mm;padding:${c.margin}mm;display:grid;grid-template-columns:repeat(${c.cols},${c.label.w}mm);grid-auto-rows:${c.label.h}mm;gap:${c.gap}mm;align-content:start;page-break-after:always;overflow:hidden}.print-sheet:last-child{page-break-after:auto}.print-sheet img{display:block;width:${c.label.w}mm;height:${c.label.h}mm;object-fit:fill}</style></head><body>${pages.join('')}</body></html>`);w.document.close();w.onload=()=>{w.focus();w.print()};closePrintModal()}catch(error){w?.close();showToast(error.message||'Não foi possível montar a impressão.');}finally{btn.disabled=false;btn.textContent=old;drawLabel()}}
    // Eventos da tela: salvar, pesquisar, exportar, imprimir e editar registros.
    $('pieceForm').addEventListener('submit',e=>{e.preventDefault();if(activeGenerated)return;if(!fields.id.value.trim()||!fields.client.value.trim()){showToast('Preencha o ID da peça e o cliente.');return}const baseId=normalizeBase(fields.id.value),rec={key:editingKey||`${baseId}|${fields.client.value.trim()}`,baseId,quantity:getQuantity(),client:fields.client.value.trim(),notes:fields.notes.value.trim().slice(0,500),updatedAt:new Date().toISOString()};let items=getRecords();const pos=items.findIndex(x=>recordKey(x)===editingKey||(`${recordBase(x)}|${x.client||''}`===`${rec.baseId}|${rec.client}`));if(pos>=0)items[pos]=rec;else items.unshift(rec);setRecords(items);editingKey=rec.key;$('saveBtn').textContent='Atualizar peça';renderRecords();updatePreview();updateNotesCounter();showToast(pos>=0?'Peça atualizada.':'Peça salva no histórico.');});
    $('saveBtn').addEventListener('click',()=>{if(!activeGenerated)$('pieceForm').requestSubmit();});
    $('downloadBtn').addEventListener('click',()=>exportPng(labelId(previewIndex),previewIndex,activeGenerated));
    $('downloadAllBtn').addEventListener('click',async()=>{const btn=$('downloadAllBtn'),old=btn.textContent;btn.disabled=true;btn.textContent='Gerando lote…';try{const zip=await buildZip();const a=document.createElement('a');a.download=`PRELUX_${normalizeBase(fields.id.value)||'ETIQUETAS'}_${getQuantity()}-PEÇAS.zip`;a.href=URL.createObjectURL(zip);a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);showToast(`${getQuantity()} PNGs gerados em um arquivo ZIP.`)}finally{btn.disabled=false;btn.textContent=old;drawLabel()}});
    $('printBtn').addEventListener('click',()=>openPrintModal());$('closePrintModal').addEventListener('click',closePrintModal);$('cancelPrint').addEventListener('click',closePrintModal);$('printModal').addEventListener('click',e=>{if(e.target.id==='printModal')closePrintModal()});$('confirmPrint').addEventListener('click',generatePrint);['labelSize','paperSize','paperOrientation','printMargin','printGap','customLabelW','customLabelH'].forEach(id=>$(id).addEventListener('input',updatePrintSummary));
    $('clearBtn').addEventListener('click',resetForm); $('sampleBtn').addEventListener('click',()=>{fields.id.value='PILAR';fields.quantity.value=3;fields.client.value='Obra Exemplo - PRELUX';fields.notes.value='Conferir armadura e acabamento antes do carregamento.';previewIndex=1;updateNotesCounter();updatePreview();});$('search').addEventListener('input',renderRecords);
    $('recordsBody').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;const k=decodeURIComponent(b.dataset.key);const r=findRecord(k);if(b.dataset.action==='load')loadRecord(k);if(b.dataset.action==='png'&&r){loadRecord(k);setTimeout(()=>exportPng(labelId(1),1),80)}if(b.dataset.action==='delete'){if(confirm(`Excluir o lote ${recordRange(r)}?`)){setRecords(getRecords().filter(x=>recordKey(x)!==k));renderRecords();showToast('Registro excluído.')}}});
    updateNotesCounter();renderRecords();
}
