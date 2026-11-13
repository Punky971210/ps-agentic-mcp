import { linePaths, thin } from './anime.js';

// Read native-size tiles and assemble before filtering/tracing, avoiding tile seams.
export async function sampleFullReference(reference, sampler, signal) {
  const meta = await sampler(reference, 8, signal);
  const width = meta.source_width, height = meta.source_height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 16000000) throw new Error('整图线稿支持最多 1600 万像素的参考图');
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 512) for (let x = 0; x < width; x += 512) {
    signal?.throwIfAborted();
    const crop = {x,y,width:Math.min(512,width-x),height:Math.min(512,height-y)};
    const tile = await sampler(reference,512,signal,{crop});
    if(tile.width!==crop.width || tile.height!==crop.height) throw new Error('原尺寸采样发生意外缩放');
    for(let row=0;row<tile.height;row++) tile.rgb.copy(rgb,((y+row)*width+x)*3,row*tile.width*3,(row+1)*tile.width*3);
  }
  return {width,height,rgb};
}

export function detectEdges(image, {threshold=30,clean=false}={}) {
  const {width:w,height:h,rgb}=image, n=w*h;
  const gray=new Float32Array(n),temp=new Float32Array(n),blur=new Float32Array(n);
  for(let i=0;i<n;i++) gray[i]=rgb[i*3]*0.299+rgb[i*3+1]*0.587+rgb[i*3+2]*0.114;
  const kernel=[1,4,6,4,1];
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) for(let k=-2;k<=2;k++) temp[y*w+x]+=gray[y*w+Math.max(0,Math.min(w-1,x+k))]*kernel[k+2]/16;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) for(let k=-2;k<=2;k++) blur[y*w+x]+=temp[Math.max(0,Math.min(h-1,y+k))*w+x]*kernel[k+2]/16;
  const magnitude=new Float32Array(n),direction=new Uint8Array(n);
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) {
    const i=y*w+x,dx=-blur[i-w-1]+blur[i-w+1]-2*blur[i-1]+2*blur[i+1]-blur[i+w-1]+blur[i+w+1];
    const dy=-blur[i-w-1]-2*blur[i-w]-blur[i-w+1]+blur[i+w-1]+2*blur[i+w]+blur[i+w+1];
    magnitude[i]=Math.hypot(dx,dy);
    direction[i]=Math.round((Math.atan2(dy,dx)*180/Math.PI+180)/45)%4;
  }
  const weak=new Uint8Array(n),mask=new Uint8Array(n),queue=[];
  const offsets=[1,w+1,w,w-1];
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) {
    const i=y*w+x,m=magnitude[i],d=offsets[direction[i]];
    if(m<threshold*0.4 || m<magnitude[i-d] || m<=magnitude[i+d]) continue;
    weak[i]=1; if(m>=threshold){mask[i]=1;queue.push(i);}
  }
  for(let q=0;q<queue.length;q++) {
    const i=queue[q];
    for(const d of [-w-1,-w,-w+1,-1,1,w-1,w,w+1]) if(weak[i+d] && !mask[i+d]){mask[i+d]=1;queue.push(i+d);}
  }
  if(clean) {
    // Collapse the two edges of a narrow dark ink stroke onto its center.
    // Require a dark valley on both sides; never merge arbitrary close contours.
    const merged=Uint8Array.from(mask),used=new Uint8Array(n);
    for(let y=7;y<h-7;y++)for(let x=7;x<w-7;x++){
      const i=y*w+x;if(!mask[i]||used[i])continue;
      const d=offsets[direction[i]];
      for(let gap=2;gap<=5;gap++){
        const j=i+d*gap;if(!mask[j]||used[j]||direction[i]!==direction[j])continue;
        const middle=i+d*Math.round(gap/2),outside=Math.min(blur[i-d*2],blur[j+d*2]);
        if(blur[middle]>outside-12)continue;
        // Fill the narrow valley before skeletonization. Moving edge pixels
        // independently tears diagonal lines and creates extra fragments.
        for(let step=0;step<=gap;step++)merged[i+d*step]=1;
        used[i]=used[j]=1;break;
      }
    }
    return thin(merged,w,h);
  }
  return mask;
}

export function joinFragments(paths,maxGap=3) {
  const result=paths.map(s=>({...s,points:s.points.slice()})),grid=new Map();
  const key=p=>`${Math.floor(p.x/maxGap)},${Math.floor(p.y/maxGap)}`;
  result.forEach((s,i)=>{if(s.points.length<2)return;for(const end of [0,1]){const p=s.points[end?s.points.length-1:0],k=key(p);if(!grid.has(k))grid.set(k,[]);grid.get(k).push({i,end,p});}});
  let joined=0;
  for(let i=0;i<result.length;i++){
    if(!result[i])continue;
    for(const end of [0,1]){
      const a=result[i].points;if(a.length<2)continue;
      const tip=a[end?a.length-1:0],inner=a[end?Math.max(0,a.length-3):Math.min(2,a.length-1)];
      const ux=tip.x-inner.x,uy=tip.y-inner.y,un=Math.hypot(ux,uy);if(!un)continue;
      const gx=Math.floor(tip.x/maxGap),gy=Math.floor(tip.y/maxGap);let best;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(const e of grid.get(`${gx+dx},${gy+dy}`)||[]){
        if(e.i===i||!result[e.i])continue;const b=result[e.i].points,btip=b[e.end?b.length-1:0];
        if(btip!==e.p)continue;
        const vx=e.p.x-tip.x,vy=e.p.y-tip.y,dist=Math.hypot(vx,vy);if(dist<0.1||dist>maxGap)continue;
        const bin=b[e.end?Math.max(0,b.length-3):Math.min(2,b.length-1)],wx=bin.x-e.p.x,wy=bin.y-e.p.y,wn=Math.hypot(wx,wy);
        if(!wn||(ux*vx+uy*vy)/(un*dist)<0.85||(wx*vx+wy*vy)/(wn*dist)<0.85)continue;
        if(!best||dist<best.dist)best={...e,dist};
      }
      if(best){const b=result[best.i].points;result[i].points=end?a.concat(best.end?b.slice().reverse():b):(best.end?b:b.slice().reverse()).concat(a);result[best.i]=null;joined++;}
    }
  }
  return {paths:result.filter(Boolean),joined};
}

export function planLineart(image,{threshold=30,minLength=8,size=1.2,color='#25202A',clean=true}={}) {
  // Pair collapse failed the detailed-art visual benchmark. Keep original edge
  // locations; improve path continuity without moving or deleting those edges.
  const mask=detectEdges(image,{threshold,clean:false});
  const traced=linePaths(mask,image,Infinity,{connectJunctions:clean}),joined=clean?joinFragments(traced):{paths:traced,joined:0};
  const paths=joined.paths, strokes=[];
  let omitted=0;
  for(const stroke of paths){
    const p=stroke.points;let length=0;
    for(let i=1;i<p.length;i++) length+=Math.hypot(p[i].x-p[i-1].x,p[i].y-p[i-1].y);
    if(length<minLength){omitted++;continue;}
    for(let start=0;start<p.length-1;start+=799) strokes.push({...stroke,points:p.slice(start,start+800),color,size});
  }
  if(strokes.length>50000) throw new Error('线条超过 50000 段，请提高 threshold 或 min_length');
  return {version:2,kind:'native-brush-lineart',width:image.width,height:image.height,threshold,min_length:minLength,clean,joined_fragments:joined.joined,
    strokes,stroke_count:strokes.length,omitted_short_fragments:omitted,edge_pixels:mask.reduce((a,b)=>a+b,0),
    note:'全图原尺寸边缘追踪线稿；不是语义线稿模型，可能包含光影边缘、双线及碎线，需要视觉检查。'};
}
