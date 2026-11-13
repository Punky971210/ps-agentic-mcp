import {readFile,writeFile,mkdir,rename,open,unlink,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import * as v from './validate.js';
import {sampleFullReference,planLineart} from './lineart.js';
import {planColoring} from './coloring.js';
import {planFormColor,validateColorGuides} from './form-painter.js';
import {taskTier,newTaskBudget,taskBudgetSummary,finishTaskBudget} from './task-tier.js';

const defaults={rounds:3,threshold:36,threshold_step:4,min_length:10,min_length_step:1,line_size:1.2,line_color:'#29212B',line_opacity:65,
 color_enabled:true,color_style:'form_brush',palette_colors:48,color_detail:256,color_opacity:100,color_brush_budget:7000,color_brush_scale:1,color_rounds:2,batch_size:256,review_mode:'vision'};
export function paintSettings(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('settings 必须是对象');
 for(const k of Object.keys(input))if(!(k in defaults))throw new Error('未知设置：'+k);
 const s={...defaults,...input};
 for(const[k,min,max,integer]of [['rounds',1,6,true],['threshold',5,200,false],['threshold_step',-30,30,false],['min_length',2,100,false],['min_length_step',-10,10,false],
  ['line_size',1,10,false],['line_opacity',1,100,false],['palette_colors',4,64,true],['color_detail',32,384,true],['color_opacity',1,100,false],['color_brush_budget',100,16000,true],['color_brush_scale',.3,3,false],['color_rounds',1,4,true],['batch_size',1,512,true]])s[k]=v.number(s[k],k,min,max,undefined,integer);
 s.color_enabled=v.bool(s.color_enabled,'color_enabled');s.line_color=v.color(s.line_color);
 if(!['form_brush','soft_brush','flat_fill'].includes(s.color_style))throw new Error('color_style 仅支持 form_brush / soft_brush / flat_fill');
 if(!['vision','parameter_sweep'].includes(s.review_mode))throw new Error('review_mode 仅支持 vision / parameter_sweep');
 for(let i=0;i<s.rounds;i++){v.number(s.threshold+i*s.threshold_step,'本轮 threshold',5,200);v.number(s.min_length+i*s.min_length_step,'本轮 min_length',2,100);}
 return s;
}
const atomic=async(file,data)=>{const temp=file+'.tmp-'+Date.now();await writeFile(temp,JSON.stringify(data,null,2));await rename(temp,file);};
const readJson=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
export function jobSummary(j,job_path){return JSON.parse(JSON.stringify({job_path,status:j.status,document_id:j.document_id,output_dir:j.output_dir,settings:j.settings,current_round:j.current_round+1,
 tier:j.task_budget?.tier??'legacy',task_budget:taskBudgetSummary(j),tier_overrides:j.tier_overrides??[],
 execution_model:'synchronous_steps',polling_required:false,
 next_tool:j.status==='ready'?'ps_step_paint_job':j.status==='waiting_review'?'read_image':null,
 ...(j.status==='ready'?{next_arguments:{job_path}}:{}),
 selected_round:j.selected_round,colored_round:j.colored_round,current_color_round:j.current_color_round,accepted_color_round:j.accepted_color_round,color_versions:j.color_versions,stage:j.stage,review_kind:j.review_kind,color_guides:j.color_guides,lineart_source_job:j.lineart_source_job,color_preview_path:j.color_preview_path,color_review:j.color_review,reference_path:j.reference_path,rounds:j.rounds.map(({plan_path,...r})=>r),color:j.color_info,outputs:j.outputs,error:j.error,
 next_action:j.status==='waiting_review'?(j.review_kind==='color'?'使用 read_image 读取原图、outputs.lineart_png 和 color_preview_path 并查看局部；form_brush 可 continue 调整 color_guides/next_color_brush_budget/next_color_brush_scale 重画颜色候选层（保留旧层和线稿），最多 color_rounds 轮。accept 可指定 accept_color_round 回选已完成颜色版本并保存，接受保存不代表质量合格。':'使用 read_image 读取 reference_path 和本轮 preview_path，只评审线稿；continue 优化下一轮，accept 确定线稿后才开始上色。'):j.status==='complete'?'完成，交付 outputs 文件；不要继续查询状态或 step。回选其他轮次将显示该轮线稿，只有 colored_round 有上色。':j.status==='ready'?'直接调用 ps_step_paint_job 执行下一阶段；无需先查询 status，任务不会在后台自行推进。':'停止自动 step 和状态轮询。任务可能正在另一进程执行，或中断后有部分落笔；报告当前状态和错误，检查实际画布与执行记录后再决定恢复，禁止自动删除锁或重放批次。',
 note:'vision 模式需模型实际读图后评审；parameter_sweep 仅扫描参数。路径指标不代表视觉质量逐轮提升。'}));}
async function readJob(file){const j=await readJson(v.filePath(file,['.json']));if(j.kind!=='dsh-paint-job'||![2,3].includes(j.version)||!Array.isArray(j.rounds)||!j.rounds.length)throw new Error('无效或旧版绘图任务；请创建先线稿后上色的新任务，不能继续旧版任务');return j;}
export async function createPaintJob(bridge,sampler,args,signal){
 const preset=taskTier(args.tier),task_budget=newTaskBudget(preset.name);
 const reference=v.filePath(args.reference_path,['.png','.jpg','.jpeg','.bmp']);
 const fromFile=args.settings_path?await readJson(v.filePath(args.settings_path,['.json'])):{};
 for(const input of [fromFile,args.settings??{}])if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('settings 必须是对象');
 const overrides={...fromFile,...args.settings},tier_overrides=Object.keys(overrides);
 const settings=paintSettings({...preset.repaint,...overrides});
 const outputRoot=args.output_dir?v.filePath(args.output_dir):path.join(homedir(),'Desktop','PS作品');
 const job_path=await bridge.outputPath('paint-job','json'),jobId=path.basename(job_path,'.json');
 const dir=path.join(outputRoot,jobId);await mkdir(dir,{recursive:true});
 if(args.lineart_job_path){
  const previous=await readJob(args.lineart_job_path),accepted=previous.lineart_accepted?.round;
  if(previous.status!=='complete'||!accepted||!previous.outputs?.lineart_psd||previous.reference_path.toLowerCase()!==reference.toLowerCase())throw new Error('只能复用同一参考图、已完成且保存独立线稿的任务');
  if(settings.color_style!=='form_brush'||!settings.color_enabled)throw new Error('复用线稿仅用于 form_brush 上色任务');
  const old=previous.rounds[accepted-1],plan_path=path.join(dir,'accepted-lineart-plan.json'),source_psd=path.join(dir,'输入线稿.psd');
  await copyFile(old.plan_path,plan_path);await copyFile(previous.outputs.lineart_psd,source_psd);
  const color_guides=validateColorGuides(args.color_guides,previous.width,previous.height);
  const j={version:3,kind:'dsh-paint-job',workflow:'lineart-review-then-color',task_budget,tier_overrides,reference_path:reference,width:previous.width,height:previous.height,settings:{...settings,rounds:1},output_dir:dir,
   rounds:[{round:1,source_round:accepted,threshold:old.threshold,min_length:old.min_length,plan_path,line_count:old.line_count,line_offset:old.line_count,color_offset:0,status:'complete',metrics:old.metrics}],
   lineart_source_job:args.lineart_job_path,source_psd,source_group_name:old.source_group_name??`第 ${old.round} 轮 · 阈值 ${old.threshold}`,
   lineart_accepted:{round:1,source:'previous_accepted_lineart',recorded_at:new Date().toISOString()},color_guides,current_round:0,selected_round:1,stage:'open_lineart',status:'ready'};
  await atomic(job_path,j);return jobSummary(j,job_path);
 }
 const image=await sampleFullReference(reference,sampler,signal),rounds=[];
 const color_guides=validateColorGuides(args.color_guides,image.width,image.height);
 for(let i=0;i<settings.rounds;i++){
  signal?.throwIfAborted();const threshold=settings.threshold+i*settings.threshold_step,minLength=settings.min_length+i*settings.min_length_step;
  const r={round:i+1,threshold,min_length:minLength,line_offset:0,color_offset:0,status:'pending'};
  // Plan only candidates actually needed; do not spend a max task's initial
  // budget tracing six alternatives that may never be reviewed or rendered.
  if(i===0)await prepareLineRound(image,r,settings,dir);
  rounds.push(r);
 }
 let color_path,color_info;
 if(settings.color_enabled&&settings.color_style!=='form_brush'){
  const sample=await sampler(reference,settings.color_detail,signal,{preserveAlpha:true});
  const color=planColoring(sample,image.width,image.height,{paletteColors:settings.palette_colors,style:settings.color_style});
  color_path=path.join(dir,'color-plan.json');await writeFile(color_path,JSON.stringify(color));
  const {marks,...info}=color;color_info=info;
 }
 const j={version:3,kind:'dsh-paint-job',workflow:'lineart-review-then-color',task_budget,tier_overrides,reference_path:reference,width:image.width,height:image.height,settings,output_dir:dir,
  rounds,color_path,color_info,color_guides,current_round:0,stage:'create_document',status:'ready',selected_round:null};
 await atomic(job_path,j);return jobSummary(j,job_path);
}
export async function paintJobStatus(file){return jobSummary(await readJob(file),file);}

async function prepareLineRound(image,r,settings,dir){
 const plan=planLineart(image,{threshold:r.threshold,minLength:r.min_length,size:settings.line_size,color:settings.line_color,clean:true});
 if(!plan.strokes.length)throw new Error(`第 ${r.round} 轮没有可绘制线条，请降低阈值`);
 const plan_path=path.join(dir,`round-${r.round}-plan.json`);await writeFile(plan_path,JSON.stringify(plan));
 Object.assign(r,{plan_path,line_count:plan.stroke_count,metrics:{edge_pixels:plan.edge_pixels,joined_fragments:plan.joined_fragments,omitted_short_fragments:plan.omitted_short_fragments}});
}

export async function stepPaintJob(bridge,file,signal,sampler){
 file=v.filePath(file,['.json']);const lock=await open(file+'.lock','wx').catch(()=>{throw new Error('任务正在另一进程执行，或遗留锁需要检查；不能并发落笔');});
 let j;
 try{
  j=await readJob(file);
  if(j.status==='complete')return jobSummary(j,file);
  if(j.status!=='ready')throw new Error('任务处于 '+j.status+'，可能已部分落笔；请检查 PS 与任务记录，禁止盲目重试');
  signal?.throwIfAborted();j.status='running';await atomic(file,j);
  const s=j.settings,r=j.rounds[j.current_round];
  const run=(op,args)=>bridge.run(op,args,signal);
  if(j.stage==='open_lineart'){
   const doc=await run('open',{path:j.source_psd,duplicate:true});j.document_id=doc.document_id;
   if(doc.width!==j.width||doc.height!==j.height)throw new Error('复用线稿尺寸不匹配');
   const group=doc.layers.find(x=>x.type==='LayerSet'&&x.name===j.source_group_name&&x.visible);if(!group)throw new Error('已接受线稿图层组缺失或已重命名');
   const start=doc.layers.indexOf(group),children=[];for(let k=start+1;k<doc.layers.length&&doc.layers[k].depth>group.depth;k++)children.push(doc.layers[k]);
   const ink=children.find(x=>x.name==='02 线稿'),color=children.find(x=>x.name==='01 参考配色');
   if(!ink||!color)throw new Error('复用线稿的线稿层或空颜色层缺失');
   Object.assign(r,{group_id:group.id,line_layer_id:ink.id,color_layer_id:color.id,source_group_name:j.source_group_name});j.stage='save_lineart';
  }else if(j.stage==='create_document'){
   const doc=await run('create',{width:j.width,height:j.height,name:'DSH 多轮重绘与上色',background:'#FFFFFF',resolution:72});j.document_id=doc.document_id;j.stage='create_round';
  }else{
   const info=await run('info',{document_id:j.document_id});
   if(info.width!==j.width||info.height!==j.height)throw new Error('画布尺寸已改变');
   if(info.selection?.active)throw new Error('多轮整图任务需要清除现有选区');
   if(j.stage==='create_round'){
    if(!r.plan_path){
     if(!sampler)throw new Error('缺少下一轮原尺寸采样器');
     await prepareLineRound(await sampleFullReference(j.reference_path,sampler,signal),r,s,j.output_dir);
    }
    const result=await run('paint_round',{document_id:j.document_id,name:`第 ${r.round} 轮 · 阈值 ${r.threshold}`,line_opacity:r.line_opacity??s.line_opacity,color_opacity:r.color_opacity??s.color_opacity,
     previous_group_ids:j.rounds.filter(x=>x.group_id).map(x=>x.group_id)});
    Object.assign(r,result);r.status='drawing';j.stage='line';
   }else if(j.stage==='color'){
    if(!j.outputs?.lineart_png||j.selected_round!==r.round||!j.lineart_accepted)throw new Error('必须先接受并保存线稿才能上色');
    const p=await readJson(j.color_path),chunk=[];let cost=0;
    for(const mark of p.marks.slice(r.color_offset,r.color_offset+s.batch_size)){
     const amount=p.style==='form_brush'?mark.contours.reduce((n,c)=>n+c.points.length,0)+mark.strokes.reduce((n,s)=>n+s.points.length+100,0):1;
     if(chunk.length&&(cost+amount>24000||chunk.length>=128&&p.style==='form_brush'))break;chunk.push(mark);cost+=amount;
    }
    if(chunk.length){const result=await run(p.style==='form_brush'?'form_batch':'color_batch',{document_id:j.document_id,...(p.style==='form_brush'?{layer_ids:r.form_layer_ids}:{layer_id:r.color_layer_id,style:p.style}),marks:chunk});r.color_offset+=result.marks_drawn;r.color_strokes=(r.color_strokes??0)+(result.strokes_drawn??0);}
    if(r.color_offset>=p.mark_count){j.colored_round=r.round;j.stage='color_review';}
   }else if(j.stage==='line'){
    const p=await readJson(r.plan_path),chunk=[];let points=0;
    for(const stroke of p.strokes.slice(r.line_offset,r.line_offset+s.batch_size)){if(points+stroke.points.length>32768)break;chunk.push(stroke);points+=stroke.points.length;}
    const result=await run('lineart',{document_id:j.document_id,layer_id:r.line_layer_id,strokes:v.strokes(chunk)});r.line_offset+=result.strokes_drawn;
    if(r.line_offset>=r.line_count)j.stage='review';
   }else if(j.stage==='review'){
    r.preview_path=path.join(j.output_dir,`round-${r.round}-preview.png`);
    await run('preview',{document_id:j.document_id,path:r.preview_path,max_side:2048,overwrite:false});
    // Record actual output stats without pretending they establish visual quality.
    r.status='complete';j.selected_round=r.round;
    const prev=j.rounds[j.current_round-1];
    if(prev)r.comparison={path_count_change:r.line_count-prev.line_count,edge_pixels_change:r.metrics.edge_pixels-prev.metrics.edge_pixels,visual_quality_judged:false};
    if(s.review_mode==='vision'){j.status='waiting_review';j.stage='await_review';j.review_kind='lineart';}
    else if(j.current_round+1<j.rounds.length){j.current_round++;j.stage='create_round';}else {j.lineart_accepted={round:r.round,source:'parameter_sweep',recorded_at:new Date().toISOString()};j.stage='save_lineart';}
   }else if(j.stage==='save_lineart'){
    await run('paint_round_select',{document_id:j.document_id,group_ids:j.rounds.filter(x=>x.group_id).map(x=>x.group_id),selected_group_id:r.group_id});
    const lineart_png=path.join(j.output_dir,'已接受线稿.png'),lineart_psd=path.join(j.output_dir,'已接受线稿.psd');
    await run('save',{document_id:j.document_id,path:lineart_png,overwrite:false});await run('save',{document_id:j.document_id,path:lineart_psd,overwrite:false});
    j.outputs={lineart_png,lineart_psd};j.stage=s.color_enabled?(s.color_style==='form_brush'?'plan_color':'color'):'export';
   }else if(j.stage==='plan_color'){
    if(!sampler)throw new Error('缺少原尺寸采样器');
    const image=await sampleFullReference(j.reference_path,sampler,signal),lineart=await readJson(r.plan_path);
    const p=planFormColor(image,lineart,{brushBudget:s.color_brush_budget,brushScale:s.color_brush_scale,guides:j.color_guides});
    j.current_color_round??=1;j.color_path=path.join(j.output_dir,`form-color-${j.current_color_round}-plan.json`);await writeFile(j.color_path,JSON.stringify(p));const {marks,...info}=p;j.color_info=info;
    const layers=await run('form_layers',{document_id:j.document_id,line_layer_id:r.line_layer_id,color_layer_id:r.color_layer_id,opacity:r.color_opacity??s.color_opacity,previous_layer_ids:j.current_color_round>1?Object.values(r.form_layer_ids):[],color_round:j.current_color_round});r.form_layer_ids=layers.layer_ids;r.color_layer_id=layers.layer_ids.base;j.stage='color';
   }else if(j.stage==='color_review'){
    j.color_preview_path=path.join(j.output_dir,j.current_color_round?`上色第${j.current_color_round}轮预览.png`:'上色预览.png');
    await run('preview',{document_id:j.document_id,path:j.color_preview_path,max_side:2048,overwrite:false});
    if(s.color_style==='form_brush'){j.color_versions??=[];j.color_versions.push({round:j.current_color_round,layer_ids:r.form_layer_ids,preview_path:j.color_preview_path,plan_path:j.color_path,stroke_count:j.color_info.stroke_count,brush_scale:s.color_brush_scale,brush_budget:s.color_brush_budget,guides:j.color_guides});}
    if(s.review_mode==='vision'){j.status='waiting_review';j.stage='await_color_review';j.review_kind='color';}else j.stage='export';
   }else if(j.stage==='select_color'){
    const chosen=j.color_versions.find(c=>c.round===j.accepted_color_round);
    for(const candidate of j.color_versions)for(const id of Object.values(candidate.layer_ids))await run('layer',{document_id:j.document_id,action:'update',layer_id:id,visible:candidate===chosen});
    const p=await readJson(chosen.plan_path),{marks,...info}=p;j.color_info=info;j.color_path=chosen.plan_path;j.color_guides=chosen.guides;
    r.form_layer_ids=chosen.layer_ids;r.color_layer_id=chosen.layer_ids.base;r.color_offset=p.mark_count;r.color_strokes=p.stroke_count;j.color_preview_path=chosen.preview_path;j.stage='export';
   }else if(j.stage==='export'){
    const psd=path.join(j.output_dir,'多轮重绘.psd'),png=path.join(j.output_dir,s.color_enabled?'上色结果.png':'线稿结果.png');
    await run('save',{document_id:j.document_id,path:psd,overwrite:false});await run('save',{document_id:j.document_id,path:png,overwrite:false});
    j.outputs={...j.outputs,psd,png};j.status='complete';j.stage='done';finishTaskBudget(j);
   }else throw new Error('未知任务阶段');
  }
  if(j.status==='running')j.status='ready';await atomic(file,j);return jobSummary(j,file);
 }catch(error){if(j?.status==='running'){j.status='needs_review';j.error=String(error.message);await atomic(file,j);}throw error;}
 finally{await lock.close();await unlink(file+'.lock');}
}

export async function reviewPaintJob(sampler,file,args,signal){
 file=v.filePath(file,['.json']);const lock=await open(file+'.lock','wx').catch(()=>{throw new Error('任务正在执行');});
 try{
  const j=await readJob(file);if(j.status!=='waiting_review')throw new Error('任务未等待视觉评审');
  if(typeof args.observations!=='string'||!args.observations.trim()||args.observations.length>4000)throw new Error('observations 需要实际读图后的 1–4000 字反馈');
  if(!['continue','accept'].includes(args.decision))throw new Error('decision 必须为 continue 或 accept');
  const current=j.rounds[j.current_round];
  const feedback={observations:args.observations,decision:args.decision,source:'model_visual_review',recorded_at:new Date().toISOString()};
  if(j.review_kind==='color'){
   if(['next_threshold','next_min_length','next_line_opacity','next_color_opacity','accept_round'].some(k=>args[k]!==undefined))throw new Error('上色评审不接受下一轮线稿参数');
   if(args.decision==='continue'){
    if(j.settings.color_style!=='form_brush')throw new Error('线稿已完成；旧上色模式不支持继续，请创建 form_brush 任务');
    if(j.current_color_round>=j.settings.color_rounds)throw new Error('达到 color_rounds 上限，请接受某个已完成颜色版本或新建上色任务');
    if(args.accept_color_round!==undefined)throw new Error('continue 不接受 accept_color_round');
    const guides=validateColorGuides(args.color_guides??j.color_guides,j.width,j.height);
    const budget=v.number(args.next_color_brush_budget,'next_color_brush_budget',100,16000,j.settings.color_brush_budget,true),scale=v.number(args.next_color_brush_scale,'next_color_brush_scale',.3,3,j.settings.color_brush_scale);
    const effectiveGuides=items=>JSON.stringify(items.map(g=>[g.bounds.x,g.bounds.y,g.bounds.width,g.bounds.height,g.angle,g.brush_scale??1]));
    if(budget===j.settings.color_brush_budget&&scale===j.settings.color_brush_scale&&effectiveGuides(guides)===effectiveGuides(j.color_guides??[]))throw new Error('继续上色必须实际调整方向、引导范围、笔触尺寸或预算；仅修改评语或名称会重复同一计划');
    feedback.previous_parameters={brush_budget:j.settings.color_brush_budget,brush_scale:j.settings.color_brush_scale,guides:j.color_guides};
    feedback.next_parameters={brush_budget:budget,brush_scale:scale,guides};
    j.color_guides=guides;j.settings.color_brush_budget=budget;j.settings.color_brush_scale=scale;
    j.color_versions.at(-1).visual_review=feedback;j.current_color_round++;current.color_offset=0;current.color_strokes=0;j.stage='plan_color';
   }else{
    if(['color_guides','next_color_brush_budget','next_color_brush_scale'].some(k=>args[k]!==undefined))throw new Error('accept 不应用新绘画参数；调整参数需要 continue');
    if(j.color_versions?.length){const selected=v.number(args.accept_color_round,'accept_color_round',1,j.color_versions.length,j.current_color_round,true);j.accepted_color_round=selected;j.color_versions.at(-1).visual_review=feedback;j.stage='select_color';}
    else {if(args.accept_color_round!==undefined)throw new Error('旧模式没有多轮颜色版本');j.stage='export';}
   }
   j.color_review=feedback;j.status='ready';await atomic(file,j);return jobSummary(j,file);
  }
  const next=j.rounds[j.current_round+1];
  if(['accept_color_round','next_color_brush_budget','next_color_brush_scale'].some(k=>args[k]!==undefined))throw new Error('线稿评审不接受颜色返修参数');
  const guides=args.color_guides===undefined?j.color_guides:validateColorGuides(args.color_guides,j.width,j.height);
  if(args.decision==='continue'&&!next)throw new Error('已到配置的最后一轮；请 accept 接受线稿，或新建任务继续优化');
  if(args.decision==='continue'&&args.accept_round!==undefined)throw new Error('accept_round 仅用于接受线稿');
  if(args.decision==='continue'&&next){
   const threshold=v.number(args.next_threshold,'next_threshold',5,200,next.threshold),minLength=v.number(args.next_min_length,'next_min_length',2,100,next.min_length);
   const lineOpacity=v.number(args.next_line_opacity,'next_line_opacity',1,100,j.settings.line_opacity),colorOpacity=v.number(args.next_color_opacity,'next_color_opacity',1,100,j.settings.color_opacity);
   if(!next.plan_path||threshold!==next.threshold||minLength!==next.min_length){
    next.threshold=threshold;next.min_length=minLength;
    await prepareLineRound(await sampleFullReference(j.reference_path,sampler,signal),next,j.settings,j.output_dir);
   }
   next.line_opacity=lineOpacity;next.color_opacity=colorOpacity;feedback.next_parameters={threshold,min_length:minLength,line_opacity:lineOpacity,color_opacity:colorOpacity};
   j.current_round++;j.stage='create_round';
  }else{
   const accepted=v.number(args.accept_round,'accept_round',1,j.rounds.length,current.round,true);
   if(j.rounds[accepted-1].status!=='complete')throw new Error('只能接受已完成线稿轮次');
   for(const r of j.rounds.slice(j.current_round+1))r.status='skipped';
   j.selected_round=accepted;j.current_round=accepted-1;j.lineart_accepted={round:accepted,source:'model_visual_review',recorded_at:feedback.recorded_at};j.stage='save_lineart';
  }
  j.color_guides=guides;current.visual_review=feedback;j.status='ready';await atomic(file,j);return jobSummary(j,file);
 }finally{await lock.close();await unlink(file+'.lock');}
}

export async function selectPaintRound(bridge,file,number,signal){
 file=v.filePath(file,['.json']);const lock=await open(file+'.lock','wx').catch(()=>{throw new Error('任务正在执行');});
 try{
  const j=await readJob(file),n=v.number(number,'round',1,j.rounds.length,undefined,true),r=j.rounds[n-1];
  if(j.status!=='complete'||r.status!=='complete')throw new Error('请在任务完成后选择已完成的轮次');
  await bridge.run('paint_round_select',{document_id:j.document_id,group_ids:j.rounds.filter(x=>x.group_id).map(x=>x.group_id),selected_group_id:r.group_id},signal);
  j.selected_round=n;
  const tag=Date.now(),png=path.join(j.output_dir,`选择第${n}轮-${tag}.png`),psd=path.join(j.output_dir,`选择第${n}轮-${tag}.psd`);
  await bridge.run('save',{document_id:j.document_id,path:png,overwrite:false},signal);await bridge.run('save',{document_id:j.document_id,path:psd,overwrite:false},signal);
  j.outputs={...j.outputs,png,psd};await atomic(file,j);return jobSummary(j,file);
 }finally{await lock.close();await unlink(file+'.lock');}
}
