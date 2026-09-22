const API_BASE=window.location.hostname.endsWith("github.io")?"https://socce7ball-support.onrender.com":"";
const $=id=>document.getElementById(id); let currentUser=null; let accessToken=localStorage.getItem("socce7ball_access_token")||""; let staffCache=[]; let ticketCache=[]; let currentTicket=null; let sending=false; let refreshingMessages=false;
async function api(path,options={}){
  const headers={...(options.body?{"Content-Type":"application/json"}:{}),...(accessToken?{"Authorization":"Bearer "+accessToken}:{}),...(options.headers||{})};
  const r=await fetch(API_BASE+path,{credentials:"include",...options,headers});
  if(!r.ok)throw new Error(await r.text());
  return r.json();
}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
function showUser(u){currentUser=u;$("app").classList.remove("hidden");$("loginBtn").textContent=u.username||"Discord User";$("loginBtn").classList.add("logged-in");$("username").textContent=u.username||"Discord User";$("userid").textContent=u.id||"";if(u.avatar){$("avatar").src=u.avatar;$("avatar").classList.remove("hidden")}else $("avatar").classList.add("hidden");$("staffTab").classList.toggle("hidden",!u.isStaff);$("deleteAllBtn").classList.toggle("hidden",!(u.isFounder||u.isAdmin));}
function setView(v){["ticketListView","newTicketView","staffView","chat"].forEach(x=>$(x).classList.add("hidden"));["ticketsTab","newTicketTab","staffTab"].forEach(x=>$(x).classList.remove("active"));$("blacklistView").classList.add("hidden");if(v==="tickets"){$("ticketListView").classList.remove("hidden");$("ticketsTab").classList.add("active");loadTickets()}if(v==="new"){$("newTicketView").classList.remove("hidden");$("newTicketTab").classList.add("active")}if(v==="staff"){$("staffView").classList.remove("hidden");$("staffTab").classList.add("active");loadStaffTickets()}if(v==="chat")$("chat").classList.remove("hidden");}
function ticketHtml(t,staff=false){const owner=t.owner||{};return '<div class="ticketCard"><button class="ticketMain" data-id="'+escapeHtml(t.id)+'"><img src="'+escapeHtml(owner.avatar||"")+'" onerror="this.style.display=\'none\'"><div class="ticketInfo"><b>'+escapeHtml(t.name)+'</b><span>'+escapeHtml(t.category||"Other")+' · '+escapeHtml(t.status)+'</span><small>'+escapeHtml(owner.username||"")+(owner.id?" · "+escapeHtml(owner.id):"")+'</small></div><span class="status '+escapeHtml(t.status)+'">'+escapeHtml(t.status)+'</span></button>'+ (staff?'<button class="miniDelete" data-delete="'+escapeHtml(t.id)+'">Delete</button>':"")+'</div>';}
async function loadTickets(){try{const ts=await api("/api/tickets");ticketCache=ts;$("tickets").innerHTML=ts.length?ts.map(t=>ticketHtml(t)).join(""):"No tickets yet.";bindTicketButtons($("tickets"));}catch(e){$("tickets").textContent="Could not load tickets: "+e.message;}}
function bindTicketButtons(box){box.querySelectorAll("[data-id]").forEach(b=>b.onclick=()=>openTicket(b.dataset.id));box.querySelectorAll("[data-delete]").forEach(b=>b.onclick=()=>deleteTicket(b.dataset.delete));}
async function loadStaffTickets(){try{staffCache=await api("/api/staff/tickets");renderStaff();}catch(e){$("staffTickets").textContent="Could not load staff tickets: "+e.message;}}
function renderStaff(){const q=$("staffSearch").value.trim().toLowerCase(),cat=$("staffCategory").value,status=$("staffStatus").value;const list=staffCache.filter(t=>(!cat||t.category===cat)&&(!status||t.status===status)&&(!q||[t.name,t.category,t.status,t.topic,t.owner?.username,t.owner?.id].some(x=>String(x||"").toLowerCase().includes(q))));$("staffTickets").innerHTML=list.length?list.map(t=>ticketHtml(t,true)).join(""):"No matching tickets.";bindTicketButtons($("staffTickets"));}
async function openTicket(id){
  currentTicket=id;setView("chat");$("chatTitle").textContent="Loading...";$("chatActions").innerHTML="";
  try{
    const t=ticketCache.find(x=>x.id===id)||staffCache.find(x=>x.id===id);
    if(t){$("chatTitle").textContent=t.name;$("chatMeta").textContent=(t.category||"Other")+" · "+t.status;renderActions(t);}
    await loadMessages(id);
  }catch(e){$("chatTitle").textContent="Ticket";$("messages").textContent=e.message;}
}
function renderActions(t){if(!currentUser?.isStaff)return;const actions=[["accept","Accept"],["decline","Decline"],["close","Close"],["reopen","Reopen"],["blacklist","Blacklist"],["delete","Delete"]];$("chatActions").innerHTML=actions.map(a=>'<button class="'+(a[0]==="delete"?"danger":"tab")+'" data-action="'+a[0]+'">'+a[1]+'</button>').join("");$("chatActions").querySelectorAll("[data-action]").forEach(b=>b.onclick=()=>ticketAction(b.dataset.action));}
function renderMessages(ms,stick=true){$("messages").innerHTML=ms.map(m=>'<div class="msgRow '+(m.discordId===currentUser?.id?"mine":"")+'"><img src="'+escapeHtml(m.avatar||"")+'" onerror="this.style.display=\'none\'"><div class="msgBody"><div class="msgHeader"><b>'+escapeHtml(m.author)+'</b><small>'+new Date(m.createdAt).toLocaleString()+'</small></div><div class="msgText">'+escapeHtml(m.content)+'</div>'+(m.attachment?'<a class="attachment" target="_blank" href="'+escapeHtml(m.attachment.data)+'" download="'+escapeHtml(m.attachment.name)+'">'+escapeHtml(m.attachment.name)+'</a>':"")+'</div></div>').join("")||'<div class="emptyChat">No messages yet.</div>';$("messages").scrollTop=$("messages").scrollHeight;}
async function ticketAction(action){if(!currentTicket)return;if(action==="delete"&&!confirm("Delete this ticket permanently?"))return;try{await api("/api/tickets/"+currentTicket+"/"+action,{method:"POST",body:JSON.stringify({})});if(action==="delete"){currentTicket=null;setView(currentUser?.isStaff?"staff":"tickets");return;}await openTicket(currentTicket);if(currentUser?.isStaff)loadStaffTickets();}catch(e){alert(e.message)}}
async function deleteTicket(id){if(!confirm("Delete this ticket permanently?"))return;try{await api("/api/tickets/"+id+"/delete",{method:"POST",body:"{}"});await loadStaffTickets()}catch(e){alert(e.message)}}
async function loadBlacklist(){try{const xs=await api("/api/blacklist");$("blacklistItems").innerHTML=xs.length?xs.map(x=>'<div class="blackRow"><div><b>'+escapeHtml(x.username||x.discord_user_id)+'</b><small>'+escapeHtml(x.discord_user_id)+' · '+escapeHtml(x.reason||"No reason")+'</small></div><button class="tab" data-unblack="'+escapeHtml(x.discord_user_id)+'">Remove</button></div>').join(""):"No blacklisted users.";$("blacklistItems").querySelectorAll("[data-unblack]").forEach(b=>b.onclick=async()=>{try{await api("/api/blacklist/"+b.dataset.unblack,{method:"DELETE"});loadBlacklist()}catch(e){alert(e.message)}})}catch(e){$("blacklistItems").textContent=e.message}}
$("loginBtn").onclick=()=>{if(!currentUser)location.href=API_BASE+"/auth/discord"};$("openBtn").onclick=async()=>{try{if(!currentUser)showUser(await api("/api/me"));$("home").classList.add("hidden");setView("new");$("app").scrollIntoView({behavior:"smooth"})}catch{location.href=API_BASE+"/auth/discord"}};$("ticketsTab").onclick=()=>setView("tickets");$("newTicketTab").onclick=()=>setView("new");$("staffTab").onclick=()=>{if(currentUser?.isStaff)setView("staff")};$("backBtn").onclick=()=>setView(currentUser?.isStaff?"staff":"tickets");$("logoutBtn").onclick=()=>{localStorage.removeItem("socce7ball_access_token");accessToken="";location.href=API_BASE+"/auth/logout"};
$("submitBtn").onclick=async()=>{const s=$("status");if(sending)return;sending=true;$("submitBtn").disabled=true;s.textContent="Creating ticket...";try{const r=await api("/api/tickets",{method:"POST",body:JSON.stringify({category:$("category").value,topic:$("topic").value,message:$("message").value})});s.textContent="Ticket created";$("message").value="";$("topic").value="";await loadTickets();await openTicket(r.ticketId)}catch(e){s.textContent="Error: "+e.message}finally{sending=false;$("submitBtn").disabled=false}};
$("sendBtn").onclick=async()=>{
  if(sending)return;
  const id=currentTicket,v=$("chatInput").value.trim(),file=$("fileInput").files[0];
  if(!id||(!v&&!file))return;
  sending=true;$("sendBtn").disabled=true;
  try{
    let attachment=null;
    if(file){
      if(file.size>2*1024*1024)throw Error("File must be 2 MB or smaller.");
      attachment={name:file.name,type:file.type||"application/octet-stream",data:await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)})};
    }
    const optimistic={discordId:currentUser?.id,author:currentUser?.username||"You",avatar:currentUser?.avatar||"",content:v,createdAt:new Date().toISOString(),attachment};
    const existing=[...$("messages").querySelectorAll(".msgRow")];
    if(existing.length&&existing[0].querySelector(".emptyChat"))$("messages").innerHTML="";
    const row=document.createElement("div");row.className="msgRow mine";
    row.innerHTML='<img src="'+escapeHtml(optimistic.avatar)+'"><div class="msgBody"><div class="msgHeader"><b>'+escapeHtml(optimistic.author)+'</b><small>Sending…</small></div><div class="msgText">'+escapeHtml(optimistic.content)+'</div>'+(attachment?'<span class="attachment">'+escapeHtml(attachment.name)+'</span>':"")+'</div>';
    $("messages").appendChild(row);$("messages").scrollTop=$("messages").scrollHeight;
    $("chatInput").value="";$("fileInput").value="";$("fileName").textContent="";
    await api("/api/tickets/"+id+"/messages",{method:"POST",body:JSON.stringify({message:v,attachment})});
    await loadMessages(id,true);
  }catch(e){await loadMessages(id,true).catch(()=>{});alert(e.message)}
  finally{sending=false;$("sendBtn").disabled=false}
};
$("attachBtn").onclick=()=>$("fileInput").click();$("fileInput").onchange=()=>{$("fileName").textContent=$("fileInput").files[0]?.name||""};["staffSearch","staffCategory","staffStatus"].forEach(id=>$(id).oninput=renderStaff);$("blacklistTab").onclick=()=>{$("staffTickets").classList.add("hidden");$("blacklistView").classList.remove("hidden");loadBlacklist()};$("deleteAllBtn").onclick=async()=>{if(!confirm("Delete ALL tickets permanently?"))return;try{await api("/api/tickets/delete-all",{method:"POST",body:"{}"});await loadStaffTickets()}catch(e){alert(e.message)}};
(async()=>{try{const p=new URLSearchParams(location.search),handoff=p.get("auth");if(handoff){const r=await api("/auth/exchange",{method:"POST",body:JSON.stringify({token:handoff})});accessToken=r.token;localStorage.setItem("socce7ball_access_token",accessToken);history.replaceState({},document.title,location.pathname);showUser(r.user);setView("tickets");return}showUser(await api("/api/me"));setView("tickets")}catch{}})();
setInterval(()=>{if(currentTicket&&!$("chat").classList.contains("hidden"))loadMessages(currentTicket,false).catch(()=>{});},2500);
