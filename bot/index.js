require("dotenv").config();
const express=require("express"),session=require("express-session"),path=require("path");
const {Client,GatewayIntentBits,ChannelType,PermissionFlagsBits}=require("discord.js");
const app=express();
app.use(express.json());
app.use(session({secret:process.env.SESSION_SECRET||"change-this",resave:false,saveUninitialized:false,cookie:{secure:true,sameSite:"lax",httpOnly:true}}));
app.use(express.static(path.join(__dirname,"..")));

const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
const guild=()=>client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
const STAFF_ROLE_IDS=(process.env.STAFF_ROLE_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);

function requireLogin(req,res,next){if(!req.session.user)return res.status(401).json({error:"Login required"});next();}
function isStaff(req){return !!req.session.user?.isStaff;}
async function getTicket(channelId){
  const g=guild(); if(!g)return null;
  const ch=await g.channels.fetch(channelId).catch(()=>null);
  if(!ch||ch.type!==ChannelType.GuildText||!ch.name.startsWith("ticket-"))return null;
  return ch;
}
function owns(ch,userId){return !!ch.permissionOverwrites.cache.get(userId);}
function ticketData(ch){
  const owner=ch.permissionOverwrites.cache.find(o=>o.type===0 && o.id!==guild().roles.everyone.id && !STAFF_ROLE_IDS.includes(o.id));
  return {id:ch.id,name:ch.name,status:ch.permissionOverwrites.cache.get(owner?.id||"")?.deny.has(PermissionFlagsBits.ViewChannel)?"closed":"open",ownerId:owner?.id||null,topic:ch.topic||""};
}

app.get("/health",(req,res)=>res.json({ok:true,bot:client.user?.tag||null}));
app.get("/auth/discord",(req,res)=>{
  const p=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,response_type:"code",redirect_uri:process.env.DISCORD_REDIRECT_URI,scope:"identify"});
  res.redirect("https://discord.com/oauth2/authorize?"+p.toString());
});
app.get("/auth/callback",async(req,res)=>{
  try{
    const p=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:"authorization_code",code:req.query.code,redirect_uri:process.env.DISCORD_REDIRECT_URI});
    const tr=await fetch("https://discord.com/api/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:p});
    const token=await tr.json(); if(!token.access_token)throw Error("OAuth failed");
    const ur=await fetch("https://discord.com/api/users/@me",{headers:{Authorization:"Bearer "+token.access_token}});
    const u=await ur.json(); const g=guild(); if(!g)throw Error("Discord server unavailable");
    const member=await g.members.fetch(u.id).catch(()=>null);
    if(!member)throw Error("You must be a member of the Socce7Ball server");
    const roleIds=member.roles.cache.map(r=>r.id);
    req.session.user={id:u.id,username:u.global_name||u.username,avatar:u.avatar?("https://cdn.discordapp.com/avatars/"+u.id+"/"+u.avatar+".png"):null,isStaff:STAFF_ROLE_IDS.some(id=>roleIds.includes(id)),roleIds};
    res.redirect("/");
  }catch(e){res.status(500).send("Discord login failed: "+e.message);}
});
app.get("/auth/logout",(req,res)=>req.session.destroy(()=>res.redirect("/")));
app.get("/api/me",(req,res)=>req.session.user?res.json(req.session.user):res.status(401).json({error:"Not logged in"}));

app.get("/api/tickets",requireLogin,async(req,res)=>{
  try{
    const g=guild(); if(!g)return res.status(500).json({error:"Discord server unavailable"});
    const channels=await g.channels.fetch();
    const tickets=[...channels.values()].filter(ch=>ch?.type===ChannelType.GuildText&&ch.name.startsWith("ticket-")&&(isStaff(req)||owns(ch,req.session.user.id))).map(ticketData);
    tickets.sort((a,b)=>b.id.localeCompare(a.id));
    res.json(tickets);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/tickets",requireLogin,async(req,res)=>{
  try{
    const {category,topic,message,robloxUsername}=req.body;
    if(!message?.trim())return res.status(400).json({error:"Message required"});
    const g=guild(); if(!g)return res.status(500).json({error:"Discord server unavailable"});
    const base=("ticket-"+req.session.user.username).toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,45)||"user";
    const name=base+"-"+Date.now().toString(36).slice(-6);
    const ch=await g.channels.create({name,type:ChannelType.GuildText,topic:"owner="+req.session.user.id+" | category="+(category||"other")+" | topic="+(topic||"").slice(0,150),permissionOverwrites:[
      {id:g.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},
      {id:req.session.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}
    ]});
    for(const roleId of STAFF_ROLE_IDS)await ch.permissionOverwrites.create(roleId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
    await ch.send("**New Socce7Ball Support Ticket**\nUser: <@"+req.session.user.id+">\nCategory: "+(category||"Other")+"\nTopic: "+(topic||"N/A")+"\nRoblox: "+(robloxUsername||"N/A")+"\n\n"+message);
    res.json({ticketId:ch.name,channelId:ch.id});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/tickets/:id/messages",requireLogin,async(req,res)=>{
  try{
    const ch=await getTicket(req.params.id); if(!ch)return res.status(404).json({error:"Ticket not found"});
    if(!isStaff(req)&&!owns(ch,req.session.user.id))return res.status(403).json({error:"No access"});
    const msgs=await ch.messages.fetch({limit:100});
    res.json([...msgs.values()].reverse().map(m=>({id:m.id,author:m.author.globalName||m.author.username,avatar:m.author.displayAvatarURL({extension:"png",size:64}),content:m.content,createdAt:m.createdAt})));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/tickets/:id/messages",requireLogin,async(req,res)=>{
  try{
    const ch=await getTicket(req.params.id); if(!ch)return res.status(404).json({error:"Ticket not found"});
    if(!isStaff(req)&&!owns(ch,req.session.user.id))return res.status(403).json({error:"No access"});
    const content=String(req.body.message||"").trim(); if(!content)return res.status(400).json({error:"Message required"});
    const m=await ch.send(content); res.json({id:m.id});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/tickets/:id/:action",requireLogin,async(req,res)=>{
  try{
    if(!isStaff(req))return res.status(403).json({error:"Staff only"});
    const ch=await getTicket(req.params.id); if(!ch)return res.status(404).json({error:"Ticket not found"});
    if(req.params.action==="close"){const ow=ch.permissionOverwrites.cache.get(ch.topic?.match(/owner=(\d+)/)?.[1]);if(ow)await ow.edit({ViewChannel:false,SendMessages:false});}
    else if(req.params.action==="reopen"){const owner=ch.topic?.match(/owner=(\d+)/)?.[1];if(owner)await ch.permissionOverwrites.edit(owner,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});}
    else if(req.params.action==="rename"){const n=String(req.body.name||"").toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,80);if(!n)return res.status(400).json({error:"Name required"});await ch.setName(n.startsWith("ticket-")?n:"ticket-"+n);}
    else return res.status(400).json({error:"Unknown action"});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"..","index.html")));
client.once("ready",()=>console.log("Logged in as "+client.user.tag));
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT||3000,"0.0.0.0",()=>console.log("Support server running"));
