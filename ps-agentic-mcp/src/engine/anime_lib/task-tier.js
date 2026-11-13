// Task presets, independent of the provider/model selected in DSH.
const presets={
 flash:{target_seconds:180,
  repaint:{rounds:1,threshold:44,threshold_step:4,min_length:14,min_length_step:1,color_rounds:1,color_brush_budget:1600,color_brush_scale:1.5,batch_size:512},
  focus:'优先完整构图、主要轮廓和大色块；减少装饰与微小纹理。评审重点是整体可读性、五官和线色边界。'},
 pro:{target_seconds:600,
  repaint:{rounds:3,threshold:36,threshold_step:4,min_length:10,min_length_step:1,color_rounds:2,color_brush_budget:7000,color_brush_scale:1,batch_size:256},
  focus:'兼顾整体与关键局部；优先修正脸部、手部、发束与衣褶，完成一轮有依据的颜色改善。'},
 max:{target_seconds:null,
  repaint:{rounds:6,threshold:30,threshold_step:2,min_length:6,min_length_step:0,color_rounds:4,color_brush_budget:14000,color_brush_scale:.7,batch_size:128},
  focus:'没有时间截止。逐处检查结构、线条连接、五官、发丝、衣褶与明暗；依据实际缺陷返修，达到要求后结束，禁止无变化地无限循环。'}
};
export const TIER_SCHEMA={type:'string',enum:['flash','pro','max'],description:'任务档位，默认 pro。flash 约3分钟整体出图；pro 约10分钟兼顾质量；max 不设时间截止精修。是软时间目标，不切换 DS 模型。'};
export function taskTier(value='pro'){
 if(typeof value!=='string'||!Object.hasOwn(presets,value))throw new Error('tier 必须为 flash / pro / max');
 return {name:value,...structuredClone(presets[value])};
}
export function newTaskBudget(tier,now=Date.now()){
 const p=taskTier(tier);
 return{policy_version:1,tier:p.name,target_seconds:p.target_seconds,started_at:new Date(now).toISOString()};
}
export function finishTaskBudget(j,now=Date.now()){if(j.task_budget)j.task_budget.finished_at=new Date(now).toISOString();}
export function resumeTaskBudget(j){if(j.task_budget)delete j.task_budget.finished_at;}
export function taskBudgetSummary(j,now=Date.now()){
 const b=j.task_budget;
 if(!b)return{tier:'legacy',target_seconds:null,elapsed_seconds:null,remaining_seconds:null,phase:'untracked',action:'旧任务保留原参数；未记录起点，不追溯计算时间。'};
 const p=taskTier(b.tier),end=b.finished_at?Date.parse(b.finished_at):now,start=Date.parse(b.started_at);
 const elapsed=Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.floor((end-start)/1000)):null;
 const remaining=b.target_seconds===null||elapsed===null?null:Math.max(0,b.target_seconds-elapsed);
 const phase=j.status==='complete'?'complete':remaining===null?'refine':remaining===0?'over_budget':remaining<=b.target_seconds*.2?'converge':'work';
 return{tier:p.name,target_seconds:b.target_seconds,elapsed_seconds:elapsed,remaining_seconds:remaining,
  over_budget:b.target_seconds!==null&&elapsed!==null&&elapsed>b.target_seconds,phase,soft_deadline:true,
  started_at:b.started_at,finished_at:b.finished_at??null,focus:p.focus,
  action:phase==='complete'?'已完成并冻结耗时；交付实际输出。':['over_budget','converge'].includes(phase)?'收敛可选细节，优先完成当前笔画、必要评审及保存。只有实际质量可接受才接受；否则修复关键问题并如实报告超时，禁止为赶时限自动通过评审。':p.focus,
  timing_note:'从创建工具开始计算墙钟时间，含规划、模型交互、PS执行与等待；未含调用创建工具前的聊天时间。3/10分钟未经实机速度校准，不保证准时。'};
}
