const API_BASE = window.location.hostname.endsWith("github.io") ? "https://socce7ball-support.onrender.com" : "";
const $=id=>document.getElementById(id);
let currentUser=null;

async function api(path,options={}){
 const r=await fetch(API_BASE+path,{credentials:"include",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
 if(!r.ok)throw new Error(await r.text()); return r.json();
}
function showUser(u){
 currentUser=u;
 $("app").classList.remove("hidden");
 $("loginBtn").textContent=u.username||"Discord User";
 $("loginBtn").classList.add("logged-in");
 $("username").textContent=u.username||"Discord User";
 $("userid").textContent=u.id||"";
 const img=$("avatar");
 if(u.avatar){img.src=u.avatar;img.classList.remove("hidden");}
 else img.classList.add("hidden");
 if(u.isStaff){$("staffTab").classList.remove("hidden");}
 else {$("staffTab").classList.add("hidden");$("staffView").classList.add("hidden");}
}
function setView(view){
 ["ticketListView","newTicketView","staffView","chat"].forEach(id=>$(id).classList.add("hidden"));
 ["ticketsTab","newTicketTab","staffTab"].forEach(id=>$(id).classList.remove("active"));
 if(view==="tickets"){$("ticketListView").classList.remove("hidden");$("ticketsTab").classList.add("active");loadTickets();}
 if(view==="new"){$("newTicketView").classList.remove("hidden");$("newTicketTab").classList.add("active");$("chat").classList.add("hidden");}
 if(view==="staff"){$("staffView").classList.remove("hidden");$("staffTab").classList.add("active");loadStaffTickets();}
 if(view==="chat")$("chat").classList.remove("hidden");
}
function ticketHtml(t){return '<button class="ticket" data-id="'+escapeHtml(t.id)+'"><b>'+escapeHtml(t.name)+'</b><span>'+escapeHtml(t.category||"Other")+' • '+escapeHtml(t.status)+'</span></button>';}
async function loadTickets(){
 const box=$("tickets"); if(!box)return;
 try{const ts=await api("/api/tickets");box.innerHTML=ts.length?ts.map(ticketHtml).join(""):"No tickets yet.";
 [...box.querySelectorAll(".ticket")].forEach(b=>b.onclick=()=>openTicket(b.dataset.id));
 }catch(e){box.textContent="Could not load tickets: "+e.message;}
}
async function loadStaffTickets(){
 const box=$("staffTickets"); if(!box)return;
 try{const ts=await api("/api/tickets");box.innerHTML=ts.length?ts.map(ticketHtml).join(""):"No tickets found.";
 [...box.querySelectorAll(".ticket")].forEach(b=>b.onclick=()=>openTicket(b.dataset.id));
 }catch(e){box.textContent="Could not load staff tickets: "+e.message;}
}
async function openTicket(id){
 setView("chat");
 $("chatTitle").textContent="Loading...";
 try{
  const t=(await api("/api/tickets")).find(x=>x.id===id);
  if(t)$("chatTitle").textContent=t.name+" • "+t.status;
  $("chat").dataset.id=id;
  await loadMessages(id);
 }catch(e){$("chatTitle").textContent="Ticket";$("messages").textContent=e.message;}
}
async function loadMessages(id){
 const ms=await api("/api/tickets/"+id+"/messages");
 $("messages").innerHTML=ms.map(m=>'<div class="msg"><b>'+escapeHtml(m.author)+'</b><span>'+escapeHtml(m.content)+'</span></div>').join("");
 $("messages").scrollTop=$("messages").scrollHeight;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}

$("loginBtn").onclick=()=>{ if(currentUser) return; location.href=API_BASE+"/auth/discord"; };
$("openBtn").onclick=async()=>{try{showUser(currentUser||await api("/api/me"));$("home").classList.add("hidden");setView("new");$("app").scrollIntoView({behavior:"smooth"});await loadTickets();}catch{location.href="/auth/discord";}};
$("ticketsTab").onclick=()=>setView("tickets");
$("newTicketTab").onclick=()=>setView("new");
$("staffTab").onclick=()=>{if(currentUser?.isStaff)setView("staff");};
$("logoutBtn").onclick=()=>location.href=API_BASE+"/auth/logout";
$("submitBtn").onclick=async()=>{
 const s=$("status");s.textContent="Creating ticket...";
 try{const r=await api("/api/tickets",{method:"POST",body:JSON.stringify({category:$("category").value,topic:$("topic").value,message:$("message").value})});s.textContent="Ticket created: "+r.ticketId;$("message").value="";$("topic").value="";await loadTickets();await openTicket(r.ticketId);}
 catch(e){s.textContent="Error: "+e.message;}
};
$("sendBtn").onclick=async()=>{try{const id=$("chat").dataset.id;const v=$("chatInput").value.trim();if(!v)return;await api("/api/tickets/"+id+"/messages",{method:"POST",body:JSON.stringify({message:v})});$("chatInput").value="";await loadMessages(id);}catch(e){alert(e.message);}};
(async()=>{try{const u=await api("/api/me");showUser(u);setView("tickets");}catch{}})();
