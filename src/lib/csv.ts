export function parseCsv(input:string){
  const rows:string[][]=[];let row:string[]=[];let field="";let quoted=false;
  for(let index=0;index<input.length;index++){const char=input[index];if(quoted){if(char==='"'&&input[index+1]==='"'){field+='"';index++}else if(char==='"')quoted=false;else field+=char;continue}if(char==='"'){quoted=true;continue}if(char===","){row.push(field);field="";continue}if(char==="\n"){row.push(field.replace(/\r$/,"").trim());if(row.some(Boolean))rows.push(row);row=[];field="";continue}field+=char}
  if(quoted)throw new Error("CSV contains an unterminated quoted field.");row.push(field.replace(/\r$/,"").trim());if(row.some(Boolean))rows.push(row);if(rows.length<2)throw new Error("CSV must contain a header and at least one peer row.");
  const headers=rows[0].map(value=>value.trim().toLowerCase().replace(/[ -]+/g,"_"));if(!headers.includes("name"))throw new Error("CSV must include a name column.");return rows.slice(1).map(values=>Object.fromEntries(headers.map((header,index)=>[header,values[index]?.trim()??""])));
}
export function csvLine(values:unknown[]){return values.map(value=>{const text=String(value??"");return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text}).join(",")}
