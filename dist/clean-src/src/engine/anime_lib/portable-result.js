// Normalize only path-valued fields. Never rewrite prose or drawing data.
const pathKey=k=>/(?:^path$|_path$|_dir$|^output_dir$|^png$|^psd$|^lineart_png$|^lineart_psd$)/.test(k);
export function portableResult(value,key=''){
 if(typeof value==='string'&&pathKey(key)&&/^(?:[a-z]:\\|\\\\)/i.test(value))return value.replaceAll('\\','/');
 if(Array.isArray(value))return value.map(x=>portableResult(x,key));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,portableResult(v,k)]));
 return value;
}
