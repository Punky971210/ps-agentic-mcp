import {asError} from './process.js';

// Per plugin instance. A failed global query and failed document query share a
// cooldown, so alternating their arguments cannot repeatedly enter Photoshop.
export function createStatusReader(bridge,{now=Date.now,cacheMs=15000,cooldownMs=60000}={}){
 const cache=new Map();let failure;
 const unavailable=(cached)=>({ok:false,status:'unavailable',error:failure.message,cached,
  observed_at:new Date(failure.at).toISOString(),retry_after_ms:Math.max(0,failure.at+cooldownMs-now()),
  automatic_retry:false,next_action:'停止自动调用 ps_status。向用户说明本次查询错误，等待用户处理 Photoshop 忙碌、弹窗或连接问题后再检查。不要据此声称文档存在或开始落笔；可继续不调用 Photoshop 的参考图分析与规划。'});
 return {
  invalidate(){cache.clear();},
  async read(documentId,signal,{refresh=false}={}){
   if(signal?.aborted)throw asError(signal.reason,'操作已取消');
   if(failure&&now()-failure.at<cooldownMs)return unavailable(true);
   const key=documentId??'documents',previous=cache.get(key);
   if(!refresh&&previous&&now()-previous.at<cacheMs)return {...previous.value,cached:true,
    next_action:'已取得同一文档状态，短时间重复查询返回缓存；不要继续轮询。根据已有文档信息执行下一步绘图工具；已有多轮任务使用 ps_step_paint_job。缓存不是新的 Photoshop 检查。'};
   try{
    const result=await bridge.run(documentId===undefined?'status':'info',documentId===undefined?{}:{document_id:documentId},signal);
    const value={...result,ok:true,cached:false,observed_at:new Date(now()).toISOString(),
     next_action:'状态查询已完成，不会启动绘图。根据用户要求执行下一步：创建/打开文档或规划绘图；已有任务且 ready 时调用 ps_step_paint_job，不要重复 ps_status。'};
    failure=undefined;if(cache.size>=32)cache.clear();cache.set(key,{at:now(),value});return value;
   }catch(reason){
    const error=asError(reason);cache.clear();failure={at:now(),message:error.message};
    if(signal?.aborted)throw error;
    return unavailable(false);
   }
  }
 };
}
