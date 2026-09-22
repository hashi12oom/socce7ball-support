const API_BASE="https://socce7ball-support.onrender.com";
const $=id=>document.getElementById(id);
async function api(path,options={}){
  const r=await fetch(API_BASE+path,{credentials:"include",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}
function showUser(u){
  $("app").classList.remove("hidden");
  $("username").textContent=u.username||"Discord User";
  $("userid").textContent=u.id||"";
  if(u.avatar) $("avatar").src=u.avatar;
}
$("loginBtn").onclick=()=>location.href=API_BASE+"/auth/discord";
$("openBtn").onclick=async()=>{
  try{showUser(await api("/api/me"));$("app").scrollIntoView({behavior:"smooth"});}
  catch{location.href=API_BASE+"/auth/discord";}
};
$("logoutBtn").onclick=()=>location.href=API_BASE+"/auth/logout";
$("submitBtn").onclick=async()=>{
  const s=$("status"); s.textContent="Creating ticket...";
  try{
    const r=await api("/api/tickets",{method:"POST",body:JSON.stringify({
      category:$("category").value,topic:$("topic").value,message:$("message").value,robloxUsername:$("roblox").value
    })});
    s.textContent="Ticket created: "+r.ticketId;
    $("message").value="";
  }catch(e){s.textContent="Error: "+e.message;}
};
(async()=>{try{showUser(await api("/api/me"));}catch{}})();