const $=id=>document.getElementById(id);
async function api(path,options={}){
 const r=await fetch(path,{credentials:"include",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
 if(!r.ok)throw new Error(await r.text()); return r.json();
}
function showUser(u){$("app").classList.remove("hidden");$("username").textContent=u.username||"Discord User";$("userid").textContent=u.id||"";if(u.avatar)$("avatar").src=u.avatar;}
async function loadTickets(){
 const box=$("tickets"); if(!box)return;
 try{const ts=await api("/api/tickets");box.innerHTML=ts.length?ts.map(t=>'<button class="ticket" data-id="'+t.id+'"><b>'+t.name+'</b><span>'+t.status+'</span></button>').join(""):"No tickets yet.";
 [...box.querySelectorAll(".ticket")].forEach(b=>b.onclick=()=>openTicket(b.dataset.id));
 }catch(e){box.textContent=e.message;}
}
async function openTicket(id){
 $("chat").classList.remove("hidden"); $("chatTitle").textContent="Loading...";
 const t=(await api("/api/tickets")).find(x=>x.id===id); if(t)$("chatTitle").textContent=t.name+" • "+t.status;
 $("chat").dataset.id=id; await loadMessages(id);
}
async function loadMessages(id){
 const ms=await api("/api/tickets/"+id+"/messages");
 $("messages").innerHTML=ms.map(m=>'<div class="msg"><b>'+escapeHtml(m.author)+'</b><span>'+escapeHtml(m.content)+'</span></div>').join("");
 $("messages").scrollTop=$("messages").scrollHeight;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
$("loginBtn").onclick=()=>location.href="/auth/discord";
$("openBtn").onclick=async()=>{try{showUser(await api("/api/me"));$("app").scrollIntoView({behavior:"smooth"});await loadTickets();}catch{location.href="/auth/discord";}};
$("logoutBtn").onclick=()=>location.href="/auth/logout";
$("submitBtn").onclick=async()=>{
 const s=$("status");s.textContent="Creating ticket...";
 try{const r=await api("/api/tickets",{method:"POST",body:JSON.stringify({category:$("category").value,topic:$("topic").value,message:$("message").value,robloxUsername:$("roblox").value})});s.textContent="Ticket created: "+r.ticketId;$("message").value="";await loadTickets();await openTicket(r.channelId);}
 catch(e){s.textContent="Error: "+e.message;}
};
$("sendBtn").onclick=async()=>{try{const id=$("chat").dataset.id;const v=$("chatInput").value.trim();if(!v)return;await api("/api/tickets/"+id+"/messages",{method:"POST",body:JSON.stringify({message:v})});$("chatInput").value="";await loadMessages(id);}catch(e){alert(e.message);}};
(async()=>{try{const u=await api("/api/me");showUser(u);await loadTickets();}catch{}})();
