import {traceContours,simplify,quantize} from './anime.js';
import * as v from './validate.js';
import {accumulateFormStroke,replayFormMarks,meanRgbError} from './form-simulation.js';

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const hex=p=>'#'+p.map(x=>clamp(Math.round(x),0,255).toString(16).padStart(2,'0')).join('').toUpperCase();
const lum=p=>p[0]*.299+p[1]*.587+p[2]*.114;
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const unhex=s=>[1,3,5].map(i=>parseInt(s.slice(i,i+2),16));
function sharedPalette(colors,count){
 const width=colors.length<=512?colors.length:Math.min(512,Math.ceil(Math.sqrt(colors.length))),height=Math.ceil(colors.length/width),rgb=Buffer.alloc(width*height*3);
 if(height>512)throw new Error('上色区域过多，请减少线稿碎线');
 for(let i=0;i<width*height;i++)rgb.set(colors[Math.min(i,colors.length-1)],i*3);
 const q=quantize({width,height,rgb},Math.min(count,colors.length));
 return {mapped:colors.map((_,i)=>q.palette[q.labels[i]]),palette:q.palette};
}
function contourArea(c){return Math.abs(c.points.reduce((n,p,i)=>{const q=c.points[(i+1)%c.points.length];return n+p.x*q.y-q.x*p.y;},0));}
export function validateColorGuides(input=[],width,height){
 if(!Array.isArray(input)||input.length>32)throw new Error('color_guides 最多 32 个形体方向区域');
 return input.map(g=>{
  if(!g||Object.keys(g).some(k=>!['name','bounds','angle','brush_scale'].includes(k)))throw new Error('无效形体引导字段');
  if(typeof g.name!=='string'||!g.name.trim()||g.name.length>80)throw new Error('引导区域需要名称');
  const b=v.region(g.bounds);if(!b||b.x+b.width>width||b.y+b.height>height)throw new Error('引导区域超出画布');
  return{name:g.name,bounds:b,angle:v.number(g.angle,'angle',-180,180),brush_scale:v.number(g.brush_scale,'brush_scale',.25,3,1)};
 });
}

// The accepted ink paths are rasterized at the native canvas resolution to form
// barriers. Connected interiors are extended only to the centre of these barriers.
// A color sample grid is never used as painting geometry.
export function lineartRegions(image,lineart,{minArea=18,mergeSimilar=false}={}){
 const {width:w,height:h}=image,n=w*h;
 if(!Number.isInteger(w)||!Number.isInteger(h)||w<2||h<2||n>16000000||image.rgb.length!==n*3)throw new Error('无效的原尺寸参考图');
 if(!lineart?.strokes?.length)throw new Error('形体上色需要已接受的线稿路径');
 const barrier=new Uint8Array(n);
 for(const s of lineart.strokes){
  for(let k=1;k<s.points.length;k++){
   const a=s.points[k-1],b=s.points[k],steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*1.5));
   for(let t=0;t<=steps;t++){
    const x=Math.round(a.x+(b.x-a.x)*t/steps),y=Math.round(a.y+(b.y-a.y)*t/steps);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h)barrier[(y+dy)*w+x+dx]=1;
   }
  }
 }
 const labels=new Int32Array(n);labels.fill(-1);const queue=new Int32Array(n),raw=[];
 for(let start=0;start<n;start++)if(!barrier[start]&&labels[start]===-1){
  const id=raw.length;let head=0,tail=1;queue[0]=start;labels[start]=id;
  while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);
   for(const next of [x?i-1:-1,x+1<w?i+1:-1,y?i-w:-1,y+1<h?i+w:-1])if(next>=0&&!barrier[next]&&labels[next]===-1){labels[next]=id;queue[tail++]=next;}
  }
  raw.push(tail);
 }
 let head=0,tail=0;for(let i=0;i<n;i++){if(labels[i]>=0&&raw[labels[i]]>=minArea)queue[tail++]=i;else labels[i]=-1;}
 if(!tail)throw new Error('线稿没有有效上色区域，请检查线稿密度');
 while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);
  for(const next of [x?i-1:-1,x+1<w?i+1:-1,y?i-w:-1,y+1<h?i+w:-1])if(next>=0&&labels[next]===-1){labels[next]=labels[i];queue[tail++]=next;}
 }
 function collect(){const byId=new Map();
 for(let i=0;i<n;i++){
  const id=labels[i],x=i%w,y=Math.floor(i/w);let r=byId.get(id);
  if(!r){r={id,pixels:0,x0:w,y0:h,x1:0,y1:0,sum:[0,0,0]};byId.set(id,r);}
  r.pixels++;r.x0=Math.min(r.x0,x);r.x1=Math.max(r.x1,x);r.y0=Math.min(r.y0,y);r.y1=Math.max(r.y1,y);
  for(let c=0;c<3;c++)r.sum[c]+=image.rgb[i*3+c];
 }
 return byId;}
 let byId=collect(),merged=0;
 if(mergeSimilar){
  const parents=new Int32Array(raw.length);for(let i=0;i<parents.length;i++)parents[i]=i;
  const root=a=>{while(parents[a]!==a){parents[a]=parents[parents[a]];a=parents[a];}return a;};
  const neighbors=new Set(),edges=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const a=labels[y*w+x];for(const b of [x+1<w?labels[y*w+x+1]:a,y+1<h?labels[(y+1)*w+x]:a])if(a!==b){const key=Math.min(a,b)*raw.length+Math.max(a,b);if(!neighbors.has(key)){neighbors.add(key);const ra=byId.get(a),rb=byId.get(b);edges.push({a,b,d:dist(ra.sum.map(c=>c/ra.pixels),rb.sum.map(c=>c/rb.pixels))});}}
  }
  edges.sort((a,b)=>a.d-b.d);
  for(const edge of edges){if(edge.d>22)break;const a=root(edge.a),b=root(edge.b);if(a===b)continue;
   const ra=byId.get(a),rb=byId.get(b),difference=dist(ra.sum.map(c=>c/ra.pixels),rb.sum.map(c=>c/rb.pixels));
   if(difference>22||(Math.min(ra.pixels,rb.pixels)>2200&&difference>9))continue;
   const large=ra.pixels>=rb.pixels?a:b,small=large===a?b:a,A=byId.get(large),B=byId.get(small);
   parents[small]=large;A.pixels+=B.pixels;for(let c=0;c<3;c++)A.sum[c]+=B.sum[c];merged++;
  }
  for(let i=0;i<n;i++)labels[i]=root(labels[i]);byId=collect();
 }
 const regions=[...byId.values()];
 for(const r of regions){
  const cw=r.x1-r.x0+1,ch=r.y1-r.y0+1,crop=new Int32Array(cw*ch);
  for(let y=0;y<ch;y++)crop.set(labels.subarray((r.y0+y)*w+r.x0,(r.y0+y)*w+r.x0+cw),y*cw);
  r.contours=traceContours(crop,cw,ch,r.id,.55).map(c=>({hole:c.hole,points:c.points.map(p=>({x:p.x+r.x0,y:p.y+r.y0}))}));
  r.color=r.sum.map(c=>Math.round(c/r.pixels));delete r.sum;
 }
 return{labels,regions,barrier,merged};
}

function flowField(image){
 const {width:w,height:h,rgb}=image,n=w*h,gray=new Float32Array(n),temp=new Float32Array(n),blur=new Float32Array(n);
 for(let i=0;i<n;i++)gray[i]=rgb[i*3]*.299+rgb[i*3+1]*.587+rgb[i*3+2]*.114;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let a=0;for(let k=-2;k<=2;k++)a+=gray[y*w+clamp(x+k,0,w-1)];temp[y*w+x]=a/5;}
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let a=0;for(let k=-2;k<=2;k++)a+=temp[clamp(y+k,0,h-1)*w+x];blur[y*w+x]=a/5;}
 const ix=new Float64Array((w+1)*(h+1)),iy=new Float64Array(ix.length),iz=new Float64Array(ix.length),stride=w+1;
 for(let y=0;y<h;y++){let xx=0,yy=0,xy=0;for(let x=0;x<w;x++){
  const gx=blur[y*w+clamp(x+1,0,w-1)]-blur[y*w+clamp(x-1,0,w-1)],gy=blur[clamp(y+1,0,h-1)*w+x]-blur[clamp(y-1,0,h-1)*w+x];
  xx+=gx*gx;yy+=gy*gy;xy+=gx*gy;const i=(y+1)*stride+x+1;ix[i]=ix[i-stride]+xx;iy[i]=iy[i-stride]+yy;iz[i]=iz[i-stride]+xy;
 }}
 return(x,y)=>{const a=clamp(Math.round(x)-7,0,w),b=clamp(Math.round(y)-7,0,h),c=clamp(Math.round(x)+8,0,w),d=clamp(Math.round(y)+8,0,h);
  const sum=p=>p[d*stride+c]-p[b*stride+c]-p[d*stride+a]+p[b*stride+a];
  return .5*Math.atan2(2*sum(iz),sum(ix)-sum(iy))+Math.PI/2;
 };
}

export function planFormColor(image,lineart,{brushBudget=7000,brushScale=1,guides=[]}={}){
 const {width:w,height:h,rgb}=image,n=w*h;guides=validateColorGuides(guides,w,h);
 const {labels,regions,barrier,merged}=lineartRegions(image,lineart,{mergeSimilar:true}),byId=new Map(regions.map(r=>[r.id,r]));
 const flow=flowField(image),canvas=new Float32Array(n*3),marks=[],lengths=[];
 const basePalette=sharedPalette(regions.map(r=>r.color),64);regions.forEach((r,i)=>{r.color=basePalette.mapped[i];});
 for(let i=0;i<n;i++)canvas.set(byId.get(labels[i]).color,i*3);
 const baseGroups=new Map();
 for(const r of regions)if(r.contours.length){const color=hex(r.color);if(!baseGroups.has(color))baseGroups.set(color,[]);baseGroups.get(color).push(r);}
 for(const [color,group] of baseGroups){let contours=[],ids=[],points=0;
  const flush=()=>{if(!contours.length)return;marks.push({role:'base',region_ids:ids,contours:contours.sort((a,b)=>contourArea(b)-contourArea(a)),fill_color:color,strokes:[]});contours=[];ids=[];points=0;};
  for(const r of group){const size=r.contours.reduce((n,c)=>n+c.points.length,0);if(points+size>12000)flush();contours.push(...r.contours);ids.push(r.id);points+=size;}flush();
 }
 const pixel=(x,y)=>{const i=(clamp(Math.round(y),0,h-1)*w+clamp(Math.round(x),0,w-1))*3;return[rgb[i],rgb[i+1],rgb[i+2]];};
 const guideAt=(x,y)=>guides.findLast(g=>x>=g.bounds.x&&x<g.bounds.x+g.bounds.width&&y>=g.bounds.y&&y<g.bounds.y+g.bounds.height);
 const direction=(x,y,previous,guide)=>{
  let angle=flow(x,y),dx=Math.cos(angle),dy=Math.sin(angle);
  if(guide){const a=guide.angle*Math.PI/180,gx=Math.cos(a),gy=Math.sin(a);if(dx*gx+dy*gy<0){dx=-dx;dy=-dy;}dx=dx*.35+gx*.65;dy=dy*.35+gy*.65;}
  if(previous&&dx*previous[0]+dy*previous[1]<0){dx=-dx;dy=-dy;}
  const len=Math.hypot(dx,dy);return[dx/len,dy/len];
 };
 const errorAt=i=>Math.hypot(rgb[i*3]-canvas[i*3],rgb[i*3+1]-canvas[i*3+1],rgb[i*3+2]-canvas[i*3+2]);
 const geometry={width:w,height:h,labels,regions},planningPasses=[];
 let count=0;
 const scale=Math.max(.5,Math.min(w,h)/1080)*brushScale;
 for(let pass=0;pass<3;pass++){
  const errorBefore=meanRgbError(canvas,rgb);
  const diameter=[40,18,7][pass]*scale,cell=Math.max(3,Math.round(diameter*.65)),candidates=[];
  for(let y=0;y<h;y+=cell)for(let x=0;x<w;x+=cell){
   let best=-1,score=12;for(let cy=y+1;cy<Math.min(h,y+cell);cy+=Math.max(1,Math.floor(cell/4)))for(let cx=x+1;cx<Math.min(w,x+cell);cx+=Math.max(1,Math.floor(cell/4))){
    const i=cy*w+cx;if(barrier[i])continue;const e=errorAt(i);if(e>score){score=e;best=i;}
   }
   if(best>=0)candidates.push({i:best,score});
  }
  candidates.sort((a,b)=>b.score-a.score||a.i-b.i);
  const budget=Math.min(brushBudget-count,Math.round(brushBudget*[.22,.34,.44][pass])),groups=new Map();let used=0;
  for(const candidate of candidates){
   if(used>=budget)break;const i=candidate.i;if(errorAt(i)<14)continue;
   const x=i%w,y=Math.floor(i/w),id=labels[i],region=byId.get(id),guide=guideAt(x,y),size=Math.max(2,diameter*(guide?.brush_scale??1)),color=pixel(x,y);
   const start=direction(x,y,null,guide),step=Math.max(1.5,size*.28),halves=[];
   for(const sign of [-1,1]){
    let px=x,py=y,prev=[start[0]*sign,start[1]*sign];const half=[];
    for(let k=0;k<9;k++){
     const dir=direction(px,py,prev,guide),nx=px+dir[0]*step,ny=py+dir[1]*step;
     if(nx<0||nx>=w||ny<0||ny>=h||labels[Math.floor(ny)*w+Math.floor(nx)]!==id||dist(pixel(nx,ny),color)>48)break;
     half.push({x:nx,y:ny});px=nx;py=ny;prev=dir;
    }halves.push(half);
   }
   const points=simplify([...halves[0].reverse(),{x,y},...halves[1]],.35);
   let length=0;for(let k=1;k<points.length;k++)length+=Math.hypot(points[k].x-points[k-1].x,points[k].y-points[k-1].y);
   if(points.length<2||length<size*.85)continue;
   const role=pass===2?'detail':lum(color)<lum(region.color)?'shadow':'light';
   const stroke={points,color:hex(color.map(c=>Math.min(255,Math.round(c/8)*8))),size:Math.round(size*10)/10,opacity:pass===2?92:85,flow:100,hardness:pass===2?65:35,closed:false,simulate_pressure:false};
   const key=id+'/'+role;let group=groups.get(key);if(!group){group={role,region_id:id,contours:region.contours,strokes:[]};groups.set(key,group);}group.strokes.push(stroke);
   lengths.push(length);used++;count++;
   // Provisional selection within this pass; replay the finalized palette and
   // layer order below before choosing any finer-pass strokes.
   accumulateFormStroke(canvas,geometry,id,stroke);
  }
  for(const group of groups.values()){
   // Choose a few region-level tonal mixtures, then apply them with directional
   // brushwork. Color changes are not scheduled at every reference sample.
   const palette=sharedPalette(group.strokes.map(s=>unhex(s.color)),group.strokes.length<=5?1:group.strokes.length<=20?2:3);
   group.strokes.forEach((s,i)=>{s.color=hex(palette.mapped[i]);});
   for(let offset=0;offset<group.strokes.length;offset+=48)marks.push({...group,strokes:group.strokes.slice(offset,offset+48)});
  }
  replayFormMarks(canvas,geometry,marks);
  planningPasses.push({pass:pass+1,stroke_count:used,approximate_rgb_error_before:errorBefore,approximate_rgb_error_after:meanRgbError(canvas,rgb)});
 }
 const points=marks.reduce((n,m)=>n+m.contours.reduce((k,c)=>k+c.points.length,0)+m.strokes.reduce((k,s)=>k+s.points.length,0),0);
 if(points>1500000)throw new Error('形体计划过于复杂，请减少线稿碎线或笔触预算');
 return{kind:'lineart-constrained-form-color',style:'form_brush',width:w,height:h,marks,mark_count:marks.length,region_count:regions.length,merged_similar_regions:merged,stroke_count:count,base_palette:basePalette.palette.map(hex),tonal_colors_per_region_pass:3,
  average_stroke_length:lengths.length?Math.round(lengths.reduce((a,b)=>a+b,0)/lengths.length):0,point_count:points,guides,
  source_resolution:{width:w,height:h},geometry_source:'accepted_lineart_paths',roles:['base','shadow','light','detail'],planning_passes:planningPasses,
  residual_estimate:'final_palette_layer_order_approximation_not_photoshop_render',
  note:'线稿分区底色 + 受选区约束的连续方向笔触。方向可由模型看图指定；自动区域不是语义识别，开口线稿仍可能串区。'};
}
