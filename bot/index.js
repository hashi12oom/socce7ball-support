require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const { google } = require("googleapis");
const path = require("path");
const crypto = require("crypto");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "4mb" }));
const allowedOrigin = process.env.FRONTEND_ORIGIN || "https://hashi12oom.github.io";
app.use(cors({ origin: allowedOrigin, credentials: true }));

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TABS = {
  Tickets: ["ticket_id","discord_user_id","discord_username","discord_avatar","category","subject","status","claimed_by_id","claimed_by_username","discord_notification_message_id","created_at","updated_at"],
  Messages: ["message_id","ticket_id","discord_user_id","username","message","sender_type","created_at","attachment_id","attachment_name","attachment_type"],
  Attachments: ["attachment_id","chunk_index","data"],
  Blacklist: ["discord_user_id","discord_username","reason","blacklisted_by","created_at","expires_at"],
  Users: ["discord_user_id","discord_username","avatar","roles","first_seen","last_seen"],
  Bans: ["discord_user_id","discord_username","ban_status","reason","banned_by","banned_at","expires_at"],
  StaffActions: ["action_id","staff_discord_id","staff_username","action","ticket_id","details","created_at"],
  Notifications: ["notification_id","message","ticket_id","created_at"]
};
let sheets = null;
const sheetCache = new Map();
const SHEET_CACHE_TTL_MS = 5000;
const SHEET_CACHE_TTLS = { Tickets: 3000, Messages: 1500, Blacklist: 10000, Users: 30000, Bans: 10000, StaffActions: 10000, Attachments: 30000 };

function invalidateSheetCache(tab) {
  if (tab) sheetCache.delete(tab);
  else sheetCache.clear();
}

function getGooglePrivateKey() {
  let value = String(process.env.GOOGLE_PRIVATE_KEY || "").trim();
  if (value.startsWith("{")) {
    try { value = JSON.parse(value).private_key || value; } catch {}
  }
  value = value.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
  return value;
}

async function initSheets() {
  if (!SHEET_ID || !process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.log("Google Sheets is not configured. Set GOOGLE_SHEET_ID, GOOGLE_CLIENT_EMAIL, and GOOGLE_PRIVATE_KEY.");
    return;
  }
  const privateKey = getGooglePrivateKey();
  if (!privateKey.includes("BEGIN PRIVATE KEY")) throw Error("GOOGLE_PRIVATE_KEY is not a valid service-account private key");
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: privateKey
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  sheets = google.sheets({ version: "v4", auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = new Set((meta.data.sheets || []).map(s => s.properties.title));
  const requests = Object.keys(SHEET_TABS).filter(t => !existing.has(t)).map(title => ({ addSheet: { properties: { title } } }));
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  for (const [tab, headers] of Object.entries(SHEET_TABS)) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: tab + "!1:1" }).catch(() => ({ data: {} }));
    const currentHeaders = r.data.values?.[0] || [];
    if (!currentHeaders.length || headers.some((h,i) => currentHeaders[i] !== h)) await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: tab + "!A1", valueInputOption: "RAW", requestBody: { values: [headers] } });
  }
  console.log("Google Sheets database ready.");
  // Warm the frequently-read tabs once so the first page/chat request does not wait on Sheets.
  await Promise.all(["Tickets","Messages","Blacklist","Users"].map(tab => getRows(tab).catch(e => console.error("Sheet warmup error (" + tab + "):", e.message))));
}
async function getRows(tab) {
  if (!sheets) throw Error("Google Sheets database is not connected");
  const now = Date.now();
  const cached = sheetCache.get(tab);
  const ttl = SHEET_CACHE_TTLS[tab] || SHEET_CACHE_TTL_MS;
  if (cached && now - cached.time < ttl) return cached.rows;
  if (cached?.promise) return cached.promise;
  const promise = sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:tab+"!A:Z"}).then(r => {
    const rows=r.data.values||[]; const headers=rows[0]||SHEET_TABS[tab];
    const result=rows.slice(1).map((row,i)=>({rowNumber:i+2,...Object.fromEntries(headers.map((h,j)=>[h,row[j]??""]))}));
    sheetCache.set(tab,{time:Date.now(),rows:result});
    return result;
  }).catch(err => { sheetCache.delete(tab); throw err; });
  sheetCache.set(tab,{time:now,rows:[],promise});
  return promise;
}
async function appendRow(tab,obj){
  if(!sheets) throw Error("Google Sheets database is not connected");
  await sheets.spreadsheets.values.append({spreadsheetId:SHEET_ID,range:tab+"!A:Z",valueInputOption:"RAW",requestBody:{values:[SHEET_TABS[tab].map(h=>obj[h]??"")]}});
  invalidateSheetCache(tab);
}
async function deleteSheetRows(tab,rowNumbers){
  if(!sheets) throw Error("Google Sheets database is not connected");
  if(!rowNumbers.length) return;
  const meta=await sheets.spreadsheets.get({spreadsheetId:SHEET_ID});
  const sh=(meta.data.sheets||[]).find(s=>s.properties.title===tab); if(!sh) return;
  const sheetId=sh.properties.sheetId;
  const requests=[...new Set(rowNumbers)].sort((a,b)=>b-a).map(row=>({deleteDimension:{range:{sheetId,dimension:"ROWS",startIndex:row-1,endIndex:row}}}));
  await sheets.spreadsheets.batchUpdate({spreadsheetId:SHEET_ID,requestBody:{requests}});
  invalidateSheetCache(tab);
}
async function updateRow(tab,rowNumber,obj){
  if(!sheets) throw Error("Google Sheets database is not connected");
  await sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:tab+"!A"+rowNumber,valueInputOption:"RAW",requestBody:{values:[SHEET_TABS[tab].map(h=>obj[h]??"")]}});
  invalidateSheetCache(tab);
}
async function saveUser(user) {
  if (!sheets) return;
  const rows=await getRows("Users"); const old=rows.find(r=>r.discord_user_id===user.id);
  const now=new Date().toISOString(); const obj={discord_user_id:user.id,discord_username:user.username,avatar:user.avatar||"",roles:(user.roleIds||[]).join(","),first_seen:old?.first_seen||now,last_seen:now};
  if(old) await updateRow("Users",old.rowNumber,obj); else await appendRow("Users",obj);
}

const sessionConfig = {
  secret: process.env.SESSION_SECRET || "change-this",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: "none", httpOnly: true }
};

app.use(session(sessionConfig));
app.use(express.static(path.join(__dirname, "..")));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const guild = () => client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
let STAFF_ROLE_IDS = [...new Set([
  process.env.FOUNDER_ROLE_ID,
  process.env.STAFF_ROLE_ID || "1551038040401780854",
  ...(process.env.STAFF_ROLE_IDS || "").split(",")
].map(x => String(x || "").trim()).filter(Boolean))];

const FOUNDER_ROLE_ID = String(process.env.FOUNDER_ROLE_ID || "").trim();

function hasStaffRole(member) { return !!member && STAFF_ROLE_IDS.some(id => member.roles.cache.has(id)); }
function isFounderOrAdminMember(member) { return !!member && ((FOUNDER_ROLE_ID && member.roles.cache.has(FOUNDER_ROLE_ID)) || member.permissions.has(PermissionFlagsBits.Administrator)); }

const SUPPORT_URL = process.env.SUPPORT_URL || "https://socce7ball-support.onrender.com";
const TICKET_NOTIFICATION_CHANNEL_ID = String(process.env.TICKET_NOTIFICATION_CHANNEL_ID || "1551743893135953970").trim();

async function sendOrUpdateTicketNotification(ticket, mode = "create") {
  try {
    const channel = await client.channels.fetch(TICKET_NOTIFICATION_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) throw Error("Ticket notification channel is not a text channel");
    const staffRoleId = STAFF_ROLE_IDS.find(id => id === "1551038040401780854") || STAFF_ROLE_IDS[0] || "";
    const staffMention = staffRoleId ? "<@&" + staffRoleId + ">" : "";
    const userMention = "<@" + ticket.discord_user_id + ">";
    const topic = ticket.subject || "No topic provided";
    const message = String(ticket.first_message || "No message provided").slice(0, 1500);
    const claimed = ticket.claimed_by_id ? "Claimed by <@" + ticket.claimed_by_id + ">" : "Unclaimed";
    const content = mode === "create"
      ? staffMention + "\n**New Support Ticket**\n" + userMention + " has opened a ticket for **" + String(ticket.category || "Other") + "**.\n**Topic:** " + topic + "\n**Message:** " + message + "\n**Status:** Unclaimed\n**Ticket ID:** " + ticket.ticket_id
      : "**Ticket Update**\n" + userMention + " — **" + String(ticket.category || "Other") + "**\n**Topic:** " + topic + "\n**Status:** " + claimed + "\n**Ticket ID:** " + ticket.ticket_id;
    const payload = { content, allowedMentions: { parse: [], roles: mode === "create" && staffRoleId ? [staffRoleId] : [], users: [ticket.discord_user_id] } };
    if (mode === "update" && ticket.discord_notification_message_id) {
      const old = await channel.messages.fetch(ticket.discord_notification_message_id).catch(() => null);
      if (old) { await old.edit(payload); return old.id; }
    }
    const sent = await channel.send(payload);
    return sent?.id || "";
  } catch (err) {
    console.error("Ticket Discord notification error:", err.message);
    return "";
  }
}
async function addTicketSystemMessage(ticket, actor, message) {
  const now = new Date().toISOString();
  await appendRow("Messages",{message_id:crypto.randomUUID(),ticket_id:ticket.ticket_id,discord_user_id:actor.id,username:actor.username,message,sender_type:"system",created_at:now,attachment_id:"",attachment_name:"",attachment_type:""});
  ticket.updated_at=now;
  await updateRow("Tickets",ticket.rowNumber,ticket);
}
async function addGlobalNotification(message,ticketId="") {
  await appendRow("Notifications",{notification_id:crypto.randomUUID(),message:String(message).slice(0,500),ticket_id:ticketId,created_at:new Date().toISOString()});
}
function ticketActionMessage(action,ticket,actor,extra="") {
  const name=ticket.subject||"Untitled Ticket",who="@"+actor.username;
  if(action==="claim")return 'A Ticket Called "'+name+'" has been claimed by '+who+".";
  if(action==="unclaim")return 'A Ticket Called "'+name+'" has been unclaimed by '+who+".";
  if(action==="close")return 'A Ticket Called "'+name+'" has been closed by '+who+".";
  if(action==="reopen")return 'A Ticket Called "'+name+'" has been reopened by '+who+".";
  if(action==="decline")return 'A Ticket Called "'+name+'" has been declined by '+who+".";
  if(action==="accept")return 'A Ticket Called "'+name+'" has been accepted by '+who+".";
  if(action==="rename")return 'A Ticket Called "'+extra+'" has been renamed to "'+extra+'" by '+who+".";
  if(action==="blacklist")return "You have been blacklisted by "+who+".";
  if(action==="delete")return 'A Ticket Called "'+name+'" has been deleted by '+who+".";
  return 'A Ticket Called "'+name+'" was updated by '+who+".";
}
const botCooldowns = new Map();
const authHandoffs = new Map();
function createAuthHandoff(user) {
  const token = crypto.randomBytes(32).toString("hex");
  authHandoffs.set(token, { user, expires: Date.now() + 5 * 60 * 1000 });
  return token;
}
function consumeAuthHandoff(token) {
  const item = authHandoffs.get(token);
  if (!item || item.expires < Date.now()) { authHandoffs.delete(token); return null; }
  authHandoffs.delete(token);
  return item.user;
}
const BOT_COOLDOWN_MS = 1500;

function getAuthenticatedUser(req) {
  if (req.session.user) return req.session.user;
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ")) {
    const token = h.slice(7);
    const item = authHandoffs.get(token);
    if (item && item.expires >= Date.now()) return item.user;
  }
  return null;
}
function requireLogin(req, res, next) {
  const user = getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Login required" });
  if (!req.session.user) req.session.user = user;
  next();
}

function isStaff(req) { return !!getAuthenticatedUser(req)?.isStaff; }



function ticketAccess(req, ticket) {
  return isStaff(req) || ticket.discord_id === getAuthenticatedUser(req).id;
}

app.get("/health", (req, res) =>
  res.json({ ok: true, bot: client.user?.tag || null, botAvatar: client.user?.displayAvatarURL({ extension: "png", size: 128 }) || null, database: !!sheets })
);

app.get("/auth/discord", (req, res) => {
  const p = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    scope: "identify guilds"
  });
  res.redirect("https://discord.com/oauth2/authorize?" + p.toString());
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (!req.query.code) throw Error("Discord did not return an authorization code.");

    const p = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(req.query.code),
      redirect_uri: process.env.DISCORD_REDIRECT_URI
    });

    const credentials = Buffer.from(
      process.env.DISCORD_CLIENT_ID + ":" + process.env.DISCORD_CLIENT_SECRET
    ).toString("base64");

    const tr = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + credentials
      },
      body: p
    });
    const token = await tr.json();
    if (!tr.ok || !token.access_token) {
      throw Error(token.error_description || token.error || "Discord OAuth token exchange failed.");
    }

    const ur = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + token.access_token }
    });
    const u = await ur.json();
    if (!ur.ok || !u?.id) {
      console.error("Discord /users/@me failed:", ur.status, u);
      throw Error(u?.message || u?.error_description || "Discord user lookup failed.");
    }

    const g = guild();
    // Member/role lookup is optional. Login must still work if this lookup fails.
    const member = g ? await g.members.fetch(u.id).catch(err => {
      console.error("Discord member lookup failed:", err.message);
      return null;
    }) : null;
    const roleIds = member ? member.roles.cache.map(r => r.id) : [];

    // Do NOT require server membership. Banned users can still log in and appeal.
    const roleNames = member ? member.roles.cache.filter(r => r.id !== g?.id).map(r => r.name) : [];
    const founder = !!((FOUNDER_ROLE_ID && roleIds.includes(FOUNDER_ROLE_ID)) || member?.permissions.has(PermissionFlagsBits.Administrator));
    const staff = !!STAFF_ROLE_IDS.some(id => roleIds.includes(id)) || founder;
    const premium = roleNames.some(name => /premium/i.test(name));

    const user = {
      id: u.id,
      username: u.global_name || u.username,
      roleNames,
      roleBadges: { founder, staff, premium },
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
      isStaff: staff,
      isFounder: founder,
      isAdmin: !!member?.permissions.has(PermissionFlagsBits.Administrator),
      roleIds,
      isGuildMember: !!member,
      botAvatar: client.user?.displayAvatarURL({ extension: "png", size: 128 }) || null
    };

    req.session.user = user;
    // A database/profile write must never prevent Discord login from succeeding.
    try {
      await saveUser(user);
    } catch (err) {
      console.error("User profile save failed during login:", err.message);
    }
    const handoff = createAuthHandoff(user);
    res.redirect((process.env.FRONTEND_URL || "/") + "?auth=" + encodeURIComponent(handoff));
  } catch (e) {
    console.error("Discord OAuth callback error:", e);
    res.status(500).send("Discord login failed: " + e.message);
  }
});

app.get("/auth/logout", (req, res) => req.session.destroy(() => res.redirect("/")));
app.get("/api/me", (req, res) => {
  const user = getAuthenticatedUser(req);
  user ? res.json(user) : res.status(401).json({ error: "Not logged in" });
});
app.post("/auth/exchange", (req, res) => {
  const token = String(req.body?.token || "");
  const user = consumeAuthHandoff(token);
  if (!user) return res.status(401).json({ error: "Login link expired. Please log in again." });
  const accessToken = crypto.randomBytes(32).toString("hex");
  authHandoffs.set(accessToken, { user, expires: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  req.session.user = user;
  res.json({ token: accessToken, user });
});

app.get("/api/tickets", requireLogin, async (req,res)=>{
  try{
    const rows=await getRows("Tickets");
    const mine=rows.filter(t=>isStaff(req)||t.discord_user_id===req.session.user.id);
    res.json(mine.sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).map(t=>({id:t.ticket_id,ownerId:t.discord_user_id,name:t.subject||("ticket-"+t.ticket_id.slice(0,8)),category:t.category,topic:t.subject,status:t.status,claimedBy:t.claimed_by_id?{id:t.claimed_by_id,username:t.claimed_by_username}:null,createdAt:t.created_at,updatedAt:t.updated_at})));
  }catch(e){res.status(503).json({error:e.message});}
});
app.post("/api/tickets", requireLogin, async (req,res)=>{
  try{
    const category=String(req.body.category||"Other").trim().slice(0,80);
    const topic=String(req.body.topic||"").trim().slice(0,200);
    const message=String(req.body.message||"").trim().slice(0,5000);
    if(!message)return res.status(400).json({error:"Message required"});
    const nowMs = Date.now();
    const blacklisted = (await getRows("Blacklist")).some(x => x.discord_user_id === req.session.user.id && (!x.expires_at || new Date(x.expires_at).getTime() > nowMs));
    if (blacklisted) return res.status(403).json({error:"You are blacklisted from opening tickets."});
    const id=crypto.randomUUID(), now=new Date().toISOString();
    const ticket={ticket_id:id,discord_user_id:req.session.user.id,discord_username:getAuthenticatedUser(req).username,discord_avatar:req.session.user.avatar||"",category,subject:topic,status:"unclaimed",claimed_by_id:"",claimed_by_username:"",discord_notification_message_id:"",created_at:now,updated_at:now};
    await appendRow("Tickets",ticket);
    await appendRow("Messages",{message_id:crypto.randomUUID(),ticket_id:id,discord_user_id:req.session.user.id,username:req.session.user.username,message,sender_type:"user",created_at:now,attachment_id:"",attachment_name:"",attachment_type:""});
    const notificationId=await sendOrUpdateTicketNotification({...ticket,first_message:message},"create");
    if(notificationId){ticket.discord_notification_message_id=notificationId;const saved=(await getRows("Tickets")).find(x=>x.ticket_id===id);if(saved)await updateRow("Tickets",saved.rowNumber,ticket);}
    res.json({ticketId:id});
  }catch(e){res.status(503).json({error:e.message});}
});

app.get("/api/staff/tickets",requireLogin,async(req,res)=>{try{if(!isStaff(req))return res.status(403).json({error:"Staff only"});const ts=await getRows("Tickets"),users=await getRows("Users");res.json(ts.sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).map(t=>({id:t.ticket_id,ownerId:t.discord_user_id,name:t.subject||("ticket-"+t.ticket_id.slice(0,8)),category:t.category,topic:t.subject,status:t.status,claimedBy:t.claimed_by_id?{id:t.claimed_by_id,username:t.claimed_by_username}:null,createdAt:t.created_at,updatedAt:t.updated_at,owner:{id:t.discord_user_id,username:t.discord_username,avatar:t.discord_avatar||users.find(u=>u.discord_user_id===t.discord_user_id)?.avatar||""}})));}catch(e){res.status(503).json({error:e.message})}});
app.get("/api/notifications",requireLogin,async(req,res)=>{try{const rows=await getRows("Notifications");res.json(rows.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,20).map(n=>({id:n.notification_id,message:n.message,ticketId:n.ticket_id,createdAt:n.created_at})));}catch(e){res.status(503).json({error:e.message});}});
app.get("/api/blacklist",requireLogin,async(req,res)=>{try{if(!isStaff(req))return res.status(403).json({error:"Staff only"});res.json(await getRows("Blacklist"));}catch(e){res.status(503).json({error:e.message})}});
app.post("/api/blacklist",requireLogin,async(req,res)=>{try{if(!isStaff(req))return res.status(403).json({error:"Staff only"});const id=String(req.body.userId||"").trim();if(!/^\d{17,20}$/.test(id))return res.status(400).json({error:"Valid Discord user ID required"});const reason=String(req.body.reason||"Blacklisted by staff").trim().slice(0,500);const duration=Number(req.body.durationHours||0);const expiresAt=duration>0?new Date(Date.now()+duration*3600000).toISOString():"";const rows=await getRows("Blacklist");const old=rows.find(x=>x.discord_user_id===id);const actor=getAuthenticatedUser(req);const obj={discord_user_id:id,discord_username:String(req.body.username||id).slice(0,100),reason,blacklisted_by:actor.username,created_at:new Date().toISOString(),expires_at:expiresAt};if(old)await updateRow("Blacklist",old.rowNumber,obj);else await appendRow("Blacklist",obj);const notification="You have been blacklisted by @"+actor.username+".";await addGlobalNotification(notification,"");res.json({ok:true,expiresAt,notification});}catch(e){res.status(503).json({error:e.message})}});
app.delete("/api/blacklist/:id",requireLogin,async(req,res)=>{try{if(!isStaff(req))return res.status(403).json({error:"Staff only"});const r=await getRows("Blacklist");const x=r.find(v=>v.discord_user_id===req.params.id);if(!x)return res.status(404).json({error:"Not blacklisted"});await deleteSheetRows("Blacklist",[x.rowNumber]);res.json({ok:true});}catch(e){res.status(503).json({error:e.message})}});
app.post("/api/tickets/delete-all",requireLogin,async(req,res)=>{try{const u=getAuthenticatedUser(req);if(!u?.isFounder&&!u?.isAdmin)return res.status(403).json({error:"Founder/Administrator only"});await addGlobalNotification("All tickets have been deleted by @"+u.username+".","");const tabs=["Attachments","Messages","Tickets"];for(const tab of tabs){const rows=await getRows(tab);await deleteSheetRows(tab,rows.map(x=>x.rowNumber));}for(const [tab,headers] of Object.entries(SHEET_TABS)){if(["Tickets","Messages","Attachments"].includes(tab))await sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:tab+"!A1",valueInputOption:"RAW",requestBody:{values:[headers]}});}res.json({ok:true});}catch(e){res.status(503).json({error:e.message})}});
app.get("/api/tickets/:id/messages",requireLogin,async(req,res)=>{
  try{
    const tickets=await getRows("Tickets");const t=tickets.find(x=>x.ticket_id===req.params.id);if(!t)return res.status(404).json({error:"Ticket not found"});
    if(!isStaff(req)&&t.discord_user_id!==req.session.user.id)return res.status(403).json({error:"No access"});
    const [ms,attachments,users]=await Promise.all([getRows("Messages"),getRows("Attachments"),getRows("Users")]);
    const userMap=new Map(users.map(u=>[u.discord_user_id,u]));const attachmentMap=new Map();
    for(const a of attachments){if(!attachmentMap.has(a.attachment_id))attachmentMap.set(a.attachment_id,[]);attachmentMap.get(a.attachment_id).push(a);}
    const out=ms.filter(m=>m.ticket_id===req.params.id).map(m=>{let attachment=null;if(m.attachment_id){const chunks=(attachmentMap.get(m.attachment_id)||[]).sort((a,b)=>Number(a.chunk_index)-Number(b.chunk_index));attachment={name:m.attachment_name,type:m.attachment_type,data:chunks.map(x=>x.data).join("")};}const u=userMap.get(m.discord_user_id);return{id:m.message_id,discordId:m.discord_user_id,author:m.username,avatar:u?.avatar||"",content:m.message,senderType:m.sender_type||"user",createdAt:m.created_at,attachment};});
    res.json(out);
  }catch(e){res.status(503).json({error:e.message});}
});
app.post("/api/tickets/:id/messages",requireLogin,async(req,res)=>{
  try{
    const content=String(req.body.message||"").trim().slice(0,5000); const attachment=req.body.attachment&&typeof req.body.attachment==="object"?req.body.attachment:null; if(!content&&!attachment)return res.status(400).json({error:"Message or attachment required"}); if(attachment&&(!attachment.data||String(attachment.data).length>3000000))return res.status(400).json({error:"File is too large. Maximum 2 MB."});
    const rows=await getRows("Tickets"),t=rows.find(x=>x.ticket_id===req.params.id); if(!t)return res.status(404).json({error:"Ticket not found"});
    if(!isStaff(req)&&t.discord_user_id!==req.session.user.id)return res.status(403).json({error:"No access"});
    if(t.status==="closed" && !isStaff(req))return res.status(400).json({error:"Ticket is closed"});
    const now=new Date().toISOString(); const messageId=crypto.randomUUID(); const attachmentId=attachment?crypto.randomUUID():""; await appendRow("Messages",{message_id:messageId,ticket_id:req.params.id,discord_user_id:req.session.user.id,username:req.session.user.username,message:content,sender_type:isStaff(req)?"staff":"user",created_at:now,attachment_id:attachmentId,attachment_name:attachment?.name||"",attachment_type:attachment?.type||""}); if(attachment){const data=String(attachment.data); const chunkSize=45000; for(let i=0;i<data.length;i+=chunkSize) await appendRow("Attachments",{attachment_id:attachmentId,chunk_index:Math.floor(i/chunkSize),data:data.slice(i,i+chunkSize)});}
    t.updated_at=now; await updateRow("Tickets",t.rowNumber,t); res.json({ok:true});
  }catch(e){res.status(503).json({error:e.message});}
});
app.post("/api/tickets/:id/:action",requireLogin,async(req,res)=>{
  try{
    if(!isStaff(req))return res.status(403).json({error:"Staff only"});
    const rows=await getRows("Tickets"),t=rows.find(x=>x.ticket_id===req.params.id); if(!t)return res.status(404).json({error:"Ticket not found"});
    const action=req.params.action;
    const actor=getAuthenticatedUser(req);
    if(action==="delete"){
      const notification=ticketActionMessage("delete",t,actor);
      await addGlobalNotification(notification,t.ticket_id);
      const ticketMessages=await getRows("Messages"); const attachmentIds=new Set(ticketMessages.filter(x=>x.ticket_id===t.ticket_id&&x.attachment_id).map(x=>x.attachment_id)); await deleteSheetRows("Messages",ticketMessages.filter(x=>x.ticket_id===t.ticket_id).map(x=>x.rowNumber)); const attachmentRows=await getRows("Attachments"); await deleteSheetRows("Attachments",attachmentRows.filter(x=>attachmentIds.has(x.attachment_id)).map(x=>x.rowNumber));
      await deleteSheetRows("Tickets",[t.rowNumber]);
      return res.json({ok:true,notification});
    }
    let renameTarget="";
    if(action==="claim"){
      if(t.status==="claimed" && t.claimed_by_id && t.claimed_by_id!==actor.id) return res.status(409).json({error:"Ticket is already claimed by "+t.claimed_by_username});
      t.status="claimed";t.claimed_by_id=actor.id;t.claimed_by_username=actor.username;
    } else if(action==="unclaim"){
      t.status="unclaimed";t.claimed_by_id="";t.claimed_by_username="";
    } else if(["close","reopen","resolve","decline","accept"].includes(action)){
      t.status=action==="reopen"?"unclaimed":action==="close"?"closed":action==="resolve"?"resolved":action==="decline"?"declined":"accepted";
      if(action==="reopen"){t.claimed_by_id="";t.claimed_by_username="";}
    } else if(action==="rename"){
      const n=String(req.body.name||"").trim().slice(0,80);if(!n)return res.status(400).json({error:"Name required"});renameTarget=n;t.subject=n;
    } else if(action==="blacklist"){
      const existing=(await getRows("Blacklist")).find(x=>x.discord_user_id===t.discord_user_id);
      if(!existing) await appendRow("Blacklist",{discord_user_id:t.discord_user_id,discord_username:t.discord_username,reason:String(req.body.reason||"Blacklisted by staff").slice(0,500),blacklisted_by:actor.username,created_at:new Date().toISOString(),expires_at:String(req.body.expiresAt||"")});
      const notification=ticketActionMessage("blacklist",t,actor);
      await addTicketSystemMessage(t,actor,notification);
      await addGlobalNotification(notification,t.ticket_id);
      return res.json({ok:true});
    } else return res.status(400).json({error:"Unknown action"});
    t.updated_at=new Date().toISOString();
    await updateRow("Tickets",t.rowNumber,t);
    const notification=ticketActionMessage(action,t,actor,renameTarget);
    await addTicketSystemMessage(t,actor,notification);
    await addGlobalNotification(notification,t.ticket_id);
    if(action==="claim"||action==="unclaim") await sendOrUpdateTicketNotification(t,"update");
    res.json({ok:true,claimedBy:t.claimed_by_id?{id:t.claimed_by_id,username:t.claimed_by_username}:null,status:t.status,notification});
  }catch(e){res.status(503).json({error:e.message});}
});


async function checkBan(message, text) {
  const g = guild();
  if (!g) return "I can't check the server right now.";
  const mention = message.mentions.users.first();
  const idMatch = text.match(/\\b\\d{17,20}\\b/);
  let userId = mention?.id || idMatch?.[0];
  if (!userId) {
    const name = text.replace(/\\b(check|is|the|ban|banned|discord|user|id|status|for|please)\\b/gi, " ").trim().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 100);
    if (name) {
      const members = await g.members.search({ query: name, limit: 10 }).catch(() => null);
      const found = members?.find(m => m.user.username.toLowerCase() === name.toLowerCase() || (m.user.globalName || "").toLowerCase() === name.toLowerCase());
      if (found) userId = found.id;
    }
  }
  if (!userId) return "Send me the Discord ID or @mention of the user you want me to check.";
  const user = await client.users.fetch(userId).catch(() => null);
  const ban = await g.bans.fetch(userId).catch(() => null);
  if (ban) { const name = user ? (user.globalName || user.username) : userId; const reason = ban.reason ? ` Reason: ${ban.reason.slice(0, 250)}` : ""; return `Yes — ${name} is banned from Socce7Ball.${reason}`; }
  const member = await g.members.fetch(userId).catch(() => null);
  const name = user ? (user.globalName || user.username) : (member?.user.username || userId);
  if (member) return `No — ${name} is not banned from Socce7Ball. They are currently in the server.`;
  return `No — ${name} is not on the current ban list.`;
}

async function answerDiscordMessage(message) {
  const now = Date.now();
  const last = botCooldowns.get(message.author.id) || 0;
  if (now - last < BOT_COOLDOWN_MS) return null;
  botCooldowns.set(message.author.id, now);

  const text = message.content.replace(new RegExp("<@!?" + client.user.id + ">", "g"), "").trim().slice(0, 700);
  console.log("Mention received from " + message.author.tag + ": " + text.slice(0, 120));
  if (!text) return SUPPORT_URL;

  if (/\b(check|is|am|was|has)\b.*\b(ban|banned|banlist)\b|\b(ban|banned|banlist)\b.*\b(check|status|user|id)\b/i.test(text)) {
    return checkBan(message, text);
  }

  return "AI chat and web research have been removed. Please create a ticket at " + SUPPORT_URL;
}

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (!message.guildId || message.guildId !== process.env.DISCORD_GUILD_ID) return;
  if (!client.user || !message.mentions.has(client.user.id)) return;

  let typingTimer = null;
  try {
    await message.channel.sendTyping().catch(() => {});
    typingTimer = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    const answer = await answerDiscordMessage(message);
    if (answer) {
      await message.reply({ content: answer, allowedMentions: { repliedUser: false } });
    }
  } catch (e) {
    console.error("Discord AI reply error:", e.message);
    await message.reply({ content: "I can't answer right now. Please create a ticket at " + SUPPORT_URL, allowedMentions: { repliedUser: false } }).catch(() => {});
  } finally {
    if (typingTimer) clearInterval(typingTimer);
  }
});

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show Socce7Ball bot commands"),
    new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is online"),
    new SlashCommandBuilder().setName("sendlink").setDescription("Send the Socce7Ball support website link"),
    new SlashCommandBuilder().setName("ticket").setDescription("Open the Socce7Ball support website"),
    new SlashCommandBuilder().setName("avatar").setDescription("Show a Discord user's avatar").addUserOption(o => o.setName("user").setDescription("User to inspect")),
    new SlashCommandBuilder().setName("serverinfo").setDescription("Show basic Socce7Ball server information"),
    new SlashCommandBuilder().setName("userinfo").setDescription("View Discord user information").addUserOption(o => o.setName("user").setDescription("The user to inspect")),
    new SlashCommandBuilder().setName("checkban").setDescription("Check whether a Discord user is banned").addUserOption(o => o.setName("user").setDescription("The user to check")).addStringOption(o => o.setName("user_id").setDescription("Discord user ID if they are not selectable")),
    new SlashCommandBuilder().setName("addstaff").setDescription("Add a role to the Socce7Ball staff roles").addRoleOption(o => o.setName("role").setDescription("The role to add").setRequired(true)),
    new SlashCommandBuilder().setName("removestaff").setDescription("Remove a role from the Socce7Ball staff roles").addRoleOption(o => o.setName("role").setDescription("The role to remove").setRequired(true)),
    new SlashCommandBuilder().setName("stafflist").setDescription("Show staff members and their staff roles"),
  ];
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands.map(c => c.toJSON()) });
  console.log("Slash commands registered: " + commands.length);
}

async function handleSlashCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const member = interaction.member;
  const command = interaction.commandName;

  if (command === "help") {
    return interaction.reply({
      content: [
        "**Socce7Ball Bot Commands**",
        "`/ask` — ask a question; web research is used when useful",
        "`/research` — research a topic using Google, YouTube and TikTok results",
        "`/checkban` — staff ban check by user or Discord ID",
        "`/userinfo` — staff user information",
        "`/avatar` — show a user's avatar",
        "`/serverinfo` — server information",
        "`/stafflist` — staff list",
        "`/ticket` — support website",
        "`/sendlink` — support website link",
        "`/ping` — bot status"
      ].join("\n")
    });
  }

  if (command === "ping") {
    return interaction.reply({ content: "Pong — " + client.ws.ping + "ms." });
  }

  if (command === "sendlink" || command === "ticket") {
    return interaction.reply({ content: SUPPORT_URL });
  }

  if (command === "avatar") {
    const user = interaction.options.getUser("user") || interaction.user;
    return interaction.reply({ content: user.displayAvatarURL({ extension: "png", size: 1024 }) });
  }

  if (command === "serverinfo") {
    const g = interaction.guild;
    return interaction.reply({
      content: [
        "**Socce7Ball Server**",
        "Members: " + (g.memberCount ?? "unknown"),
        "Channels: " + g.channels.cache.size,
        "Roles: " + g.roles.cache.size,
        "Created: <t:" + Math.floor(g.createdTimestamp / 1000) + ":F>"
      ].join("\n")
    });
  }

  if (command === "userinfo") {
    if (!hasStaffRole(member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
    const user = interaction.options.getUser("user");
    if (!user) return interaction.reply({ content: "Select a user.", ephemeral: true });
    const gm = await interaction.guild.members.fetch(user.id).catch(() => null);
    const roles = gm ? gm.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => "<@&" + r.id + ">").join(", ") || "No roles" : "Not currently in the server";
    return interaction.reply({ content: ["**User:** " + (user.globalName || user.username), "**Username:** " + user.username, "**ID:** " + user.id, "**Roles:** " + roles, "**Created:** <t:" + Math.floor(user.createdTimestamp / 1000) + ":F>"].join("\n"), allowedMentions: { parse: [] } });
  }

  if (command === "checkban") {
    if (!hasStaffRole(member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
    const selected = interaction.options.getUser("user");
    const rawId = interaction.options.getString("user_id");
    const userId = selected?.id || rawId?.trim();
    if (!userId || !/^\\d{17,20}$/.test(userId)) return interaction.reply({ content: "Provide a user or a valid Discord user ID.", ephemeral: true });
    const g = interaction.guild;
    const ban = await g.bans.fetch(userId).catch(() => null);
    const user = await client.users.fetch(userId).catch(() => null);
    if (ban) return interaction.reply("Yes — **" + (user?.globalName || user?.username || userId) + "** is banned from Socce7Ball." + (ban.reason ? " Reason: " + ban.reason.slice(0, 250) : ""));
    return interaction.reply("No — **" + (user?.globalName || user?.username || userId) + "** is not on the current Socce7Ball ban list.");
  }

  if (command === "addstaff") {
    if (!isFounderOrAdminMember(member)) return interaction.reply({ content: "Founder/Administrator only.", ephemeral: true });
    const role = interaction.options.getRole("role", true);
    if (role.managed) return interaction.reply({ content: "Managed/integration roles cannot be used as staff roles.", ephemeral: true });
    if (STAFF_ROLE_IDS.includes(role.id)) return interaction.reply({ content: role.toString() + " is already a staff role.", ephemeral: true });
    STAFF_ROLE_IDS.push(role.id);
    return interaction.reply("Added " + role.toString() + " to the Socce7Ball staff roles.");
  }
  if (command === "removestaff") {
    if (!isFounderOrAdminMember(member)) return interaction.reply({ content: "Founder/Administrator only.", ephemeral: true });
    const role = interaction.options.getRole("role", true);
    if (!STAFF_ROLE_IDS.includes(role.id)) return interaction.reply({ content: role.toString() + " is not currently a staff role.", ephemeral: true });
    STAFF_ROLE_IDS = STAFF_ROLE_IDS.filter(id => id !== role.id);
    return interaction.reply("Removed " + role.toString() + " from the Socce7Ball staff roles.");
  }
  if (command === "stafflist") {
    if (!isFounderOrAdminMember(member)) return interaction.reply({ content: "Founder/Administrator only.", ephemeral: true });
    await interaction.deferReply();
    const members = await interaction.guild.members.fetch();
    const staff = members.filter(m => hasStaffRole(m));
    if (!staff.size) return interaction.editReply("No staff members found.");
    const lines = Array.from(staff.values()).map(m => { const roles = m.roles.cache.filter(r => STAFF_ROLE_IDS.includes(r.id)).map(r => r.name).join(", "); return "• **" + (m.user.globalName || m.user.username) + "** — " + (roles || "Staff"); });
    const body = lines.join("\n");
    if (body.length <= 3900) return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Socce7Ball Staff List").setDescription(body).setFooter({ text: staff.size + " staff member" + (staff.size === 1 ? "" : "s") })] });
    return interaction.editReply("**Socce7Ball Staff List**\n" + lines.slice(0, 60).join("\n") + "\n\nShowing the first 60 staff members.");
  }
}

client.on("interactionCreate", interaction => {
  handleSlashCommand(interaction).catch(async e => {
    console.error("Slash command error:", e);
    if (interaction.replied || interaction.deferred) await interaction.editReply("Something went wrong.").catch(() => {});
    else await interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
  });
});

client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);
  try { await registerSlashCommands(); } catch (e) { console.error("Slash command registration error:", e); }
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "..", "index.html")));

(async () => {
  try {
    try {
      await initSheets();
    } catch (e) {
      sheets = null;
      console.error("Google Sheets startup error:", e.message);
      console.error("The API and Discord bot will continue, but ticket/database endpoints will remain unavailable until Google Sheets credentials are fixed.");
    }
    const rawDiscordToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
    const discordToken = String(rawDiscordToken || "").trim().replace(/^["']|["']$/g, "");
    if (!discordToken) throw Error("Missing DISCORD_BOT_TOKEN (or legacy DISCORD_TOKEN)");
    await client.login(discordToken);
    app.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("Support server running"));
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
