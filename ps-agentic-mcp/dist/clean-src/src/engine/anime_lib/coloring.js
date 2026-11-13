import {quantize} from './anime.js';
const hex=rgb=>'#'+rgb.map(n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();

// Quantized scanline runs are painted as native brush paths or filled rectangles.
// No raster from the reference is inserted into the Photoshop document.
export function planColoring(image,width,height,{paletteColors=48,style='soft_brush'}={}){
 const q=quantize(image,paletteColors),sx=width/image.width,sy=height/image.height,marks=[];
 for(let y=0;y<image.height;y++)for(let x=0;x<image.width;){
  const label=q.labels[y*image.width+x];let end=x+1;
  while(end<image.width&&q.labels[y*image.width+end]===label)end++;
  if(label>=0){
   const left=x*sx,right=end*sx,top=y*sy,bottom=(y+1)*sy;
   const inset=Math.min((right-left)/2,sy*0.35);
   marks.push({color:hex(q.palette[label]),bounds:{x:left,y:top,width:right-left,height:bottom-top},
    points:[{x:left+inset,y:(top+bottom)/2},{x:right-inset+0.001,y:(top+bottom)/2}],
    size:Math.min(5000,Math.max(1,sy*1.35)),hardness:25,opacity:100,flow:100,closed:false,simulate_pressure:false});
  }
  x=end;
 }
 marks.sort((a,b)=>a.color.localeCompare(b.color));
 if(marks.length>100000)throw new Error('上色笔画超过 100000，请降低 color_detail');
 return{kind:'native-reference-color',width,height,style,marks,mark_count:marks.length,palette_colors:q.palette.length,
  sampled_width:image.width,sampled_height:image.height,quantization_rmse:q.quantization_rmse,
  note:'根据参考图采样上色；保留大体配色，细节受采样和调色板限制。不是语义自动配色。'};
}
