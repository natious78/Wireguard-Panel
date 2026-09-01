import { spawn } from "node:child_process";

let stopping=false;
const children=new Map();

function start(name,command,args){
  const child=spawn(command,args,{stdio:"inherit",env:process.env});
  children.set(name,child);
  child.once("exit",(code,signal)=>{
    children.delete(name);
    if(stopping)return;
    process.stderr.write(`${new Date().toISOString()} ERROR ${name} process exited unexpectedly code=${code??"null"} signal=${signal??"none"}\n`);
    shutdown(code&&code!==0?code:1);
  });
}

function shutdown(exitCode=0){
  if(stopping)return;stopping=true;
  for(const child of children.values())child.kill("SIGTERM");
  const deadline=setTimeout(()=>{for(const child of children.values())child.kill("SIGKILL")},8_000);
  Promise.allSettled([...children.values()].map(child=>new Promise(resolve=>child.once("exit",resolve)))).then(()=>{clearTimeout(deadline);process.exit(exitCode)});
}

for(const signal of ["SIGINT","SIGTERM"]){process.on(signal,()=>shutdown(0))}

start("web","node",["server.js"]);
start("worker","node",["dist/worker.cjs"]);
