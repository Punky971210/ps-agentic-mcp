// DSH 0.2.1 accepts a deliberately small JSON Schema subset. Bounds remain
// enforced by tool validators and are also described to the model here.
export function dshSchema(input){
 const schema={...input},limits=[];
 for(const key of ['minItems','maxItems'])if(schema[key]!==undefined){limits.push(key+'='+schema[key]);delete schema[key];}
 if(limits.length)schema.description=[schema.description,limits.join(', ')+'；工具执行时校验'].filter(Boolean).join('。');
 if(schema.properties)schema.properties=Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,dshSchema(v)]));
 if(schema.items)schema.items=dshSchema(schema.items);
 if(schema.oneOf)schema.oneOf=schema.oneOf.map(dshSchema);
 return schema;
}
