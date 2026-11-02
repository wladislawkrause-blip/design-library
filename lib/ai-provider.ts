import type {Provider} from './analysis-server';
type Config={apiKey?:string;model:string;provider:Provider};
type AnthropicMode='tool'|'json_schema';

async function providerError(response:Response){
 let detail='';
 try{const t=await response.text();try{const j=JSON.parse(t);detail=String(j?.error?.message||j?.message||'');}catch{detail=t;}}catch{/* no body */}
 return detail.replace(/\s+/g,' ').trim().slice(0,300);
}
function errorMessage(status:number,detail:string){
 const base=status===401||status===403?'API-Schlüssel oder Berechtigungen sind ungültig. Bitte Einstellungen prüfen.':status===429?'Das API-Nutzungs- oder Guthabenlimit ist erreicht.':status===404?'Dieses Modell ist für dein API-Konto nicht verfügbar.':'Der KI-Anbieter konnte die Analyse nicht abschließen. Prüfe, ob dein Modell Bilder und strukturierte Antworten unterstützt.';
 const known=[401,403,404,429].includes(status);
 return detail&&!known?base+' (Anbieter-Meldung, HTTP '+status+': '+detail+')':base;
}
// Newer Claude models reject a forced tool_choice; they support JSON-schema output via output_config instead.
const forcedToolRejected=(status:number,detail:string)=>status===400&&/tool_choice/i.test(detail);

function anthropicBody(config:Config,instruction:string,images:string[],schema:Record<string,unknown>,name:string,mode:AnthropicMode){
 const messages=[{role:'user',content:[{type:'text',text:'Analysiere diese Referenzbilder.'},...images.map(s=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data:s.split(',')[1]}}))]}];
 const common={model:config.model,max_tokens:8000,system:instruction,messages};
 return mode==='tool'
  ?{...common,tools:[{name,description:'Gib die vollständige strukturierte Designanalyse aus.',input_schema:schema}],tool_choice:{type:'tool',name}}
  :{...common,output_config:{format:{type:'json_schema',schema}}};
}
function anthropicResult(body:{stop_reason?:string;content?:{type:string;name?:string;input?:unknown;text?:string}[]},name:string,mode:AnthropicMode){
 if(mode==='tool'){
  if(body.stop_reason!=='tool_use')throw Error('Unvollständige KI-Antwort.');
  const block=body.content?.find(c=>c.type==='tool_use'&&c.name===name);if(!block)throw Error('Keine strukturierte Analyse erhalten.');return block.input;
 }
 if(body.stop_reason!=='end_turn')throw Error('Unvollständige KI-Antwort.');
 const text=(body.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('');if(!text)throw Error('Keine strukturierte Analyse erhalten.');
 return JSON.parse(text);
}

export async function analyzeJson(config:Config,instruction:string,images:string[],schema:Record<string,unknown>,name:string){
 if(!config.apiKey)throw Error('Bitte zuerst einen API-Schlüssel speichern.');
 if(config.provider==='anthropic'){
  const send=(mode:AnthropicMode)=>fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':config.apiKey!,'anthropic-version':'2023-06-01','Content-Type':'application/json'},signal:AbortSignal.timeout(120000),cache:'no-store',body:JSON.stringify(anthropicBody(config,instruction,images,schema,name,mode))});
  let mode:AnthropicMode='tool';let response=await send(mode);
  if(!response.ok){
   let detail=await providerError(response);
   if(forcedToolRejected(response.status,detail)){mode='json_schema';response=await send(mode);if(!response.ok)detail=await providerError(response);}
   if(!response.ok){console.error('AI provider error',response.status,detail);throw Error(errorMessage(response.status,detail));}
  }
  return anthropicResult(await response.json(),name,mode);
 }
 const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+config.apiKey,'Content-Type':'application/json'},signal:AbortSignal.timeout(120000),cache:'no-store',
  body:JSON.stringify({model:config.model,store:false,max_output_tokens:8000,instructions:instruction,input:[{role:'user',content:[{type:'input_text',text:'Analysiere diese Referenzbilder.'},...images.map(image_url=>({type:'input_image',image_url,detail:'high'}))]}],text:{format:{type:'json_schema',name,strict:true,schema}}})});
 if(!response.ok){const detail=await providerError(response);console.error('AI provider error',response.status,detail);throw Error(errorMessage(response.status,detail));}
 const body=await response.json();
 if(body.status!=='completed')throw Error('Unvollständige KI-Antwort.');return JSON.parse((body.output||[]).flatMap((o:{content?:{type:string;text?:string}[]})=>o.content||[]).filter((c:{type:string})=>c.type==='output_text').map((c:{text:string})=>c.text).join(''));
}
export async function providerModels(provider:Provider,key:string){const r=await fetch(provider==='anthropic'?'https://api.anthropic.com/v1/models?limit=100':'https://api.openai.com/v1/models',{headers:provider==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000),cache:'no-store'});if(!r.ok)throw Error('Schlüssel oder Modellzugriff konnten nicht geprüft werden.');const d=await r.json();return (d.data||[]).map((m:{id:string;display_name?:string})=>({id:m.id,name:m.display_name||m.id})).sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));}
