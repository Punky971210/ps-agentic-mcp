// Planning estimate only: Photoshop brush tips, antialiasing and stroke opacity
// are not reproduced exactly. Never use these values as visual acceptance.
const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));

export function accumulateFormStroke(canvas, geometry, regionId, stroke) {
 const {width:w,height:h,labels}=geometry, color=rgb(stroke.color), radius=stroke.size/2;
 const hardness=stroke.hardness/100;
 for(let k=1;k<stroke.points.length;k++){
  const a=stroke.points[k-1],b=stroke.points[k],steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/(radius*.6)));
  for(let t=0;t<=steps;t++){
   const px=a.x+(b.x-a.x)*t/steps,py=a.y+(b.y-a.y)*t/steps;
   for(let y=Math.max(0,Math.floor(py-radius));y<=Math.min(h-1,Math.ceil(py+radius));y++)for(let x=Math.max(0,Math.floor(px-radius));x<=Math.min(w-1,Math.ceil(px+radius));x++){
    const at=y*w+x;if(labels[at]!==regionId)continue;
    const d=Math.hypot(x-px,y-py)/radius;if(d>1)continue;
    const coverage=d<=hardness?1:(1-d)/Math.max(.001,1-hardness);
    const alpha=stroke.opacity/100*stroke.flow/100*coverage;
    for(let c=0;c<3;c++)canvas[at*3+c]+=alpha*(color[c]-canvas[at*3+c]);
   }
  }
 }
}

export function replayFormMarks(canvas, geometry, marks) {
 const {labels,regions}=geometry,colors=new Map(regions.map(r=>[r.id,r.color]));
 for(let i=0;i<labels.length;i++)canvas.set(colors.get(labels[i]),i*3);
 // Photoshop stacks detail above light above shadow. Replay all completed
 // passes in that order, including earlier marks affected by later low layers.
 for(const role of ['shadow','light','detail'])for(const mark of marks){
  if(mark.role!==role)continue;
  const batches=new Map();
  for(const s of mark.strokes){const key=[s.color,s.size,s.opacity,s.flow,s.hardness].join('/');if(!batches.has(key))batches.set(key,[]);batches.get(key).push(s);}
  for(const batch of batches.values())for(const stroke of batch)accumulateFormStroke(canvas,geometry,mark.region_id,stroke);
 }
 return canvas;
}

export function meanRgbError(canvas, reference) {
 let sum=0;for(let i=0;i<canvas.length;i++)sum+=Math.abs(canvas[i]-reference[i]);
 return Math.round(sum/canvas.length*100)/100;
}
