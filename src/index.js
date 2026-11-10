require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const net = require("node:net");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const {
  ActionRowBuilder, ActivityType, AttachmentBuilder, ChannelType, Client, Partials,
  EmbedBuilder, GatewayIntentBits, ModalBuilder, PermissionFlagsBits,
  REST, Routes, SlashCommandBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle
} = require("discord.js");

const required = ["DISCORD_TOKEN", "API_SECRET", "DATABASE_URL"];
for (const name of required) {
  if (!process.env[name]) throw new Error("Missing required environment variable: " + name);
}
if (process.env.API_SECRET.length < 32) throw new Error("API_SECRET must contain at least 32 characters.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message]
});

const runtime = { lastHeartbeatAt: 0, mta: null };
const DEFAULT_CATEGORIES = [
  { key: "soporte-general", name: "Soporte general", description: "Ayuda y consultas generales", emoji: "🛠️", roleId: null },
  { key: "reportar-jugador", name: "Reportar jugador", description: "Reporta una incidencia de un jugador", emoji: "🚨", roleId: null },
  { key: "donaciones", name: "Donaciones", description: "Consultas sobre donaciones", emoji: "💎", roleId: null }
];

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_warnings (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const existing = await getJson("ticket_categories", null);
  if (!existing) await setJson("ticket_categories", DEFAULT_CATEGORIES);
}
async function getJson(key, fallback) {
  const r = await pool.query("SELECT value FROM bot_kv WHERE key = $1", [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}
async function setJson(key, value) {
  await pool.query(
    "INSERT INTO bot_kv(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()",
    [key, JSON.stringify(value)]
  );
}
async function getTicket(channelId) { return getJson("ticket:" + channelId, null); }
async function setTicket(channelId, ticket) { return setJson("ticket:" + channelId, ticket); }
async function getVisual() {
  return (await getJson("visual", {})) || {};
}
function cleanText(value, max = 100) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function safeHex(value) { return /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : "#00C7FF"; }
function slug(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "ticket";
}
function isAdmin(interaction) {
  const ids = (process.env.ADMIN_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  return ids.includes(interaction.user.id) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}
function isStaffForTicket(interaction, ticket) {
  if (isAdmin(interaction) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  return Boolean(ticket?.roleId && interaction.member?.roles?.cache?.has(ticket.roleId));
}
async function sendLog(guild, embed, files = []) {
  const channelId = await getJson("log_channel", null);
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) await channel.send({ embeds: [embed], files }).catch(() => null);
}
function logoUrl(visual) { return visual.logoUrl || process.env.LOGO_URL || null; }
async function makeStatusEmbed() {
  const visual = await getVisual();
  const online = runtime.lastHeartbeatAt > 0 && Date.now() - runtime.lastHeartbeatAt <= 60000;
  const data = runtime.mta || {};
  const embed = new EmbedBuilder()
    .setColor(online ? safeHex(visual.color) : 0xED4245)
    .setTitle(cleanText(visual.title, 120) || "ꜱᴛᴀᴛᴜꜱ ᴅᴇʟ ꜱᴇʀᴠɪᴅᴏʀ")
    .setDescription(online ? "🟢 **ONLINE** · Servidor respondiendo" : "🔴 **OFFLINE** · Sin latido reciente")
    .addFields(
      { name: "Servidor", value: cleanText(data.serverName || "Esperando datos MTA", 100) || "No disponible", inline: true },
      { name: "Jugadores", value: online ? String(data.players ?? 0) : "—", inline: true },
      { name: "Capacidad", value: online ? String(data.maxPlayers ?? 0) : "—", inline: true },
      { name: "Último latido", value: runtime.lastHeartbeatAt ? "<t:" + Math.floor(runtime.lastHeartbeatAt / 1000) + ":R>" : "Aún no recibido", inline: false }
    )
    .setFooter({ text: "DRIP X SHOP · MTA STATUS" })
    .setTimestamp(new Date());
  const serverIp = await getJson("server_ip", null);
  if (serverIp) embed.addFields({ name: "IP del servidor", value: cleanText(serverIp, 100), inline: false });
  const logo = logoUrl(visual);
  if (logo) embed.setThumbnail(logo);
  if (visual.bannerStatus && /^https:\/\//i.test(visual.bannerStatus)) embed.setImage(visual.bannerStatus);
  return embed;
}
async function makeTicketPanelEmbed() {
  const visual = await getVisual();
  const embed = new EmbedBuilder()
    .setColor(safeHex(visual.color))
    .setTitle("ꜱɪꜱᴛᴇᴍᴀ ᴅᴇ ᴛɪᴄᴋᴇᴛꜱ")
    .setDescription("Selecciona una categoría en el menú para abrir un canal privado de atención.")
    .setFooter({ text: "DRIP X SHOP · SOPORTE" });
  const logo = logoUrl(visual);
  if (logo) embed.setThumbnail(logo);
  if (visual.bannerTickets && /^https:\/\//i.test(visual.bannerTickets)) embed.setImage(visual.bannerTickets);
  return embed;
}
async function makeTicketManagementEmbed(ticket) {
  const visual = await getVisual();
  const embed = new EmbedBuilder()
    .setColor(safeHex(visual.color))
    .setTitle("ᴛɪᴄᴋᴇᴛ · " + cleanText(ticket.categoryName, 70))
    .setDescription("Usa el menú de gestión para reclamar, guardar la transcripción, añadir a una persona o cerrar este ticket.")
    .addFields(
      { name: "Solicitante", value: "<@" + ticket.openerId + ">", inline: true },
      { name: "Responsable", value: ticket.claimedBy ? "<@" + ticket.claimedBy + ">" : "Sin asignar", inline: true }
    )
    .setFooter({ text: "DRIP X SHOP · GESTIÓN DE TICKETS" });
  const logo = logoUrl(visual);
  if (logo) embed.setThumbnail(logo);
  return embed;
}
function makeTicketMenu(categories) {
  const options = categories.slice(0, 25).map(c => {
    const o = { label: cleanText(c.name, 100), description: cleanText(c.description, 100) || "Abrir un ticket", value: c.key };
    if (c.emoji) o.emoji = c.emoji;
    return o;
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("ticket:create").setPlaceholder("Selecciona el motivo de contacto").addOptions(options)
  );
}
function makeManagementMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("ticket:manage").setPlaceholder("Acciones del ticket")
      .addOptions(
        { label: "Reclamar ticket", value: "claim", emoji: "🧑‍💼" },
        { label: "Guardar transcripción", value: "transcript", emoji: "📄" },
        { label: "Añadir usuario", value: "add_user", emoji: "➕" },
        { label: "Cerrar ticket", value: "close", emoji: "🔒" }
      )
  );
}
async function refreshStatusPanel() {
  const panel = await getJson("panel_status", null);
  if (!panel || !client.isReady()) return;
  const channel = await client.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = await makeStatusEmbed();
  let message = await channel.messages.fetch(panel.messageId).catch(() => null);
  if (message) await message.edit({ embeds: [embed] }).catch(() => null);
  else {
    message = await channel.send({ embeds: [embed] }).catch(() => null);
    if (message) await setJson("panel_status", { channelId: channel.id, messageId: message.id });
  }
}
async function refreshTicketPanel() {
  const panel = await getJson("panel_tickets", null);
  if (!panel || !client.isReady()) return;
  const channel = await client.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const categories = await getJson("ticket_categories", DEFAULT_CATEGORIES);
  const embed = await makeTicketPanelEmbed();
  const components = categories.length ? [makeTicketMenu(categories)] : [];
  let message = await channel.messages.fetch(panel.messageId).catch(() => null);
  if (message) await message.edit({ embeds: [embed], components }).catch(() => null);
  else {
    message = await channel.send({ embeds: [embed], components }).catch(() => null);
    if (message) await setJson("panel_tickets", { channelId: channel.id, messageId: message.id });
  }
}
async function updatePresence() {
  if (!client.user) return;
  const online = runtime.lastHeartbeatAt > 0 && Date.now() - runtime.lastHeartbeatAt <= 60000;
  const data = runtime.mta || {};
  client.user.setPresence({
    status: online ? "online" : "idle",
    activities: [{ name: online ? "MTA: " + (data.players ?? 0) + "/" + (data.maxPlayers ?? 0) : "MTA: OFFLINE", type: ActivityType.Playing }]
  });
}
async function recreateDeletedPanel(message) {
  const channelId = message.channelId || message.channel?.id;
  if (!channelId) return;
  for (const key of ["panel_status", "panel_tickets"]) {
    const panel = await getJson(key, null);
    if (panel?.messageId !== message.id || panel?.channelId !== channelId) continue;
    const channel = await client.channels.fetch(panel.channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;
    const fresh = key === "panel_status"
      ? await channel.send({ embeds: [await makeStatusEmbed()] })
      : await channel.send({
          embeds: [await makeTicketPanelEmbed()],
          components: [makeTicketMenu(await getJson("ticket_categories", DEFAULT_CATEGORIES))]
        });
    await setJson(key, { channelId: channel.id, messageId: fresh.id });
  }
}
function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
async function buildTranscript(channel) {
  let before;
  const all = [];
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch?.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = all.map(m => {
    const time = new Date(m.createdTimestamp).toISOString();
    const attachments = [...m.attachments.values()].map(a => '<div><a href="' + htmlEscape(a.url) + '">' + htmlEscape(a.name || "adjunto") + '</a></div>').join("");
    return '<article><small>' + htmlEscape(time) + ' · ' + htmlEscape(m.author?.tag || m.author?.username || "Usuario") + '</small><p>' + htmlEscape(m.content || "") + '</p>' + attachments + '</article>';
  }).join("\n");
  return '<!doctype html><html lang="es"><meta charset="utf-8"><title>Transcripción</title><style>body{font:14px system-ui;background:#101216;color:#e9eef7;padding:24px}article{padding:12px;border-bottom:1px solid #303642}small{color:#8ba0ba}p{white-space:pre-wrap}</style><h1>Transcripción · ' + htmlEscape(channel.name) + '</h1>' + lines + '</html>';
}
async function sendTranscript(channel, guild) {
  const html = await buildTranscript(channel);
  const file = new AttachmentBuilder(Buffer.from(html, "utf8"), { name: channel.name + "-transcript.html" });
  const embed = new EmbedBuilder().setColor(0x00C7FF).setTitle("Transcripción de ticket").setDescription("Canal: #" + channel.name + "\nID: " + channel.id);
  const logId = await getJson("log_channel", null);
  const logChannel = logId ? await guild.channels.fetch(logId).catch(() => null) : null;
  if (logChannel?.isTextBased()) await logChannel.send({ embeds: [embed], files: [file] });
  else await channel.send({ embeds: [embed], files: [file] });
}
async function ensureTicketAccess(interaction, ticket) {
  if (interaction.user.id === ticket.openerId || isStaffForTicket(interaction, ticket)) return true;
  await interaction.reply({ content: "No tienes permiso para gestionar este ticket.", ephemeral: true }).catch(() => null);
  return false;
}
function makeVisualModal() {
  const modal = new ModalBuilder().setCustomId("visual:save").setTitle("Editar identidad visual");
  const fields = [
    ["visual:banner_status", "Banner status (URL HTTPS)", TextInputStyle.Short, false],
    ["visual:logo", "Logo pequeño / thumbnail (URL HTTPS)", TextInputStyle.Short, false],
    ["visual:banner_tickets", "Banner tickets (URL HTTPS)", TextInputStyle.Short, false],
    ["visual:color", "Color HEX, ej. #00C7FF", TextInputStyle.Short, false],
    ["visual:title", "Título del panel de estado", TextInputStyle.Short, false]
  ];
  for (const [id, label, style, requiredField] of fields) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(requiredField).setMaxLength(300)
    ));
  }
  return modal;
}
function buildCommands() {
  const textChannel = option => option.addChannelTypes(ChannelType.GuildText);
  return [
    new SlashCommandBuilder().setName("panel-status").setDescription("Publica o mueve el panel de estado MTA").addChannelOption(o => textChannel(o.setName("canal").setDescription("Canal del panel"))),
    new SlashCommandBuilder().setName("panel-tickets").setDescription("Publica o mueve el panel de tickets").addChannelOption(o => textChannel(o.setName("canal").setDescription("Canal del panel"))),
    new SlashCommandBuilder().setName("config-logs").setDescription("Configura los canales de registros")
      .addChannelOption(o => textChannel(o.setName("canal").setDescription("Canal de registros").setRequired(true)))
      .addStringOption(o => o.setName("tipo").setDescription("Tipo de registro").setRequired(false)
        .addChoices({ name: "General / moderación", value: "general" }, { name: "JOIN / QUIT MTA", value: "joinquit" })),
    new SlashCommandBuilder().setName("configsv").setDescription("Configura la IP del servidor MTA en el panel")
      .addStringOption(o => o.setName("ip").setDescription("IP o dominio público del servidor MTA").setRequired(true).setMaxLength(253)),
    new SlashCommandBuilder().setName("editar-visual").setDescription("Edita banners, logo y color de los embeds"),
    new SlashCommandBuilder().setName("ticket-add-opcion").setDescription("Añade una categoría al menú de tickets")
      .addStringOption(o => o.setName("nombre").setDescription("Nombre visible").setRequired(true))
      .addStringOption(o => o.setName("descripcion").setDescription("Descripción").setRequired(true))
      .addStringOption(o => o.setName("emoji").setDescription("Emoji opcional").setRequired(false))
      .addRoleOption(o => o.setName("rol_soporte").setDescription("Rol que atenderá esta categoría").setRequired(false)),
    new SlashCommandBuilder().setName("ticket-remove-opcion").setDescription("Elimina una categoría del menú de tickets")
      .addStringOption(o => o.setName("nombre").setDescription("Nombre o clave de la categoría").setRequired(true)),
    new SlashCommandBuilder().setName("ban").setDescription("Banea a un miembro")
      .addUserOption(o => o.setName("usuario").setDescription("Miembro").setRequired(true))
      .addStringOption(o => o.setName("razon").setDescription("Motivo").setRequired(true)),
    new SlashCommandBuilder().setName("kick").setDescription("Expulsa a un miembro")
      .addUserOption(o => o.setName("usuario").setDescription("Miembro").setRequired(true))
      .addStringOption(o => o.setName("razon").setDescription("Motivo").setRequired(true)),
    new SlashCommandBuilder().setName("timeout").setDescription("Aplica tiempo de silencio")
      .addUserOption(o => o.setName("usuario").setDescription("Miembro").setRequired(true))
      .addIntegerOption(o => o.setName("minutos").setDescription("Duración en minutos").setMinValue(1).setMaxValue(40320).setRequired(true))
      .addStringOption(o => o.setName("razon").setDescription("Motivo").setRequired(true)),
    new SlashCommandBuilder().setName("clear").setDescription("Elimina mensajes recientes")
      .addIntegerOption(o => o.setName("cantidad").setDescription("Entre 1 y 100").setMinValue(1).setMaxValue(100).setRequired(true)),
    new SlashCommandBuilder().setName("warn").setDescription("Registra una advertencia")
      .addUserOption(o => o.setName("usuario").setDescription("Miembro").setRequired(true))
      .addStringOption(o => o.setName("razon").setDescription("Motivo").setRequired(true))
  ].map(c => c.toJSON());
}
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const body = buildCommands();
  if (process.env.GUILD_ID) await rest.put(Routes.applicationGuildCommands(client.application.id, process.env.GUILD_ID), { body });
  else await rest.put(Routes.applicationCommands(client.application.id), { body });
}
async function executeCommand(i) {
  const name = i.commandName;
  const adminCommands = ["panel-status", "panel-tickets", "config-logs", "configsv", "editar-visual", "ticket-add-opcion", "ticket-remove-opcion"];
  if (adminCommands.includes(name) && !isAdmin(i)) return i.reply({ content: "Necesitas permisos de administrador.", ephemeral: true });
  if (name === "editar-visual") return i.showModal(makeVisualModal());

  if (name === "panel-status") {
    const channel = i.options.getChannel("canal") || i.channel;
    const message = await channel.send({ embeds: [await makeStatusEmbed()] });
    await setJson("panel_status", { channelId: channel.id, messageId: message.id });
    return i.reply({ content: "Panel de estado guardado y actualizado en " + channel.toString() + ".", ephemeral: true });
  }
  if (name === "panel-tickets") {
    const channel = i.options.getChannel("canal") || i.channel;
    const categories = await getJson("ticket_categories", DEFAULT_CATEGORIES);
    const message = await channel.send({ embeds: [await makeTicketPanelEmbed()], components: categories.length ? [makeTicketMenu(categories)] : [] });
    await setJson("panel_tickets", { channelId: channel.id, messageId: message.id });
    return i.reply({ content: "Panel de tickets guardado en " + channel.toString() + ".", ephemeral: true });
  }
  if (name === "config-logs") {
    const channel = i.options.getChannel("canal");
    const type = i.options.getString("tipo") || "general";
    await setJson(type === "joinquit" ? "joinquit_log_channel" : "log_channel", channel.id);
    return i.reply({ content: (type === "joinquit" ? "Canal de logs JOIN/QUIT MTA" : "Canal de logs general") + " configurado: " + channel.toString(), ephemeral: true });
  }
  if (name === "configsv") {
    const ip = cleanText(i.options.getString("ip"), 253).replace(/^https?:\/\//i, "").replace(/\/$/, "");
    const valid = net.isIP(ip) !== 0 || /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(ip);
    if (!valid || /[\s/]/.test(ip)) return i.reply({ content: "Introduce una IP válida o dominio sin protocolo ni rutas.", ephemeral: true });
    await setJson("server_ip", ip);
    await refreshStatusPanel();
    return i.reply({ content: "IP del servidor guardada y panel actualizado: " + ip, ephemeral: true });
  }
  if (name === "ticket-add-opcion") {
    const categories = await getJson("ticket_categories", DEFAULT_CATEGORIES);
    if (categories.length >= 25) return i.reply({ content: "Discord permite como máximo 25 opciones por menú.", ephemeral: true });
    const label = cleanText(i.options.getString("nombre"), 100);
    const key = slug(label);
    if (categories.some(c => c.key === key)) return i.reply({ content: "Ya existe una categoría con esa clave.", ephemeral: true });
    const role = i.options.getRole("rol_soporte");
    categories.push({ key, name: label, description: cleanText(i.options.getString("descripcion"), 100), emoji: cleanText(i.options.getString("emoji") || "", 40), roleId: role?.id || null });
    await setJson("ticket_categories", categories);
    await refreshTicketPanel();
    return i.reply({ content: "Categoría añadida y panel actualizado.", ephemeral: true });
  }
  if (name === "ticket-remove-opcion") {
    const key = slug(i.options.getString("nombre"));
    const categories = await getJson("ticket_categories", DEFAULT_CATEGORIES);
    const next = categories.filter(c => c.key !== key && slug(c.name) !== key);
    if (next.length === categories.length) return i.reply({ content: "No encontré esa categoría. Usa su nombre o clave.", ephemeral: true });
    if (!next.length) return i.reply({ content: "No puedes dejar el panel sin categorías.", ephemeral: true });
    await setJson("ticket_categories", next);
    await refreshTicketPanel();
    return i.reply({ content: "Categoría eliminada y panel actualizado.", ephemeral: true });
  }

  const target = i.options.getUser("usuario");
  const reason = cleanText(i.options.getString("razon"), 450) || "Sin motivo especificado";
  if (["ban", "kick", "timeout", "clear", "warn"].includes(name)) {
    const needed = name === "ban" ? PermissionFlagsBits.BanMembers :
      name === "kick" ? PermissionFlagsBits.KickMembers :
      name === "timeout" ? PermissionFlagsBits.ModerateMembers :
      name === "clear" ? PermissionFlagsBits.ManageMessages : PermissionFlagsBits.ModerateMembers;
    if (!i.memberPermissions?.has(needed) && !isAdmin(i)) return i.reply({ content: "No tienes el permiso de Discord necesario.", ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const audit = new EmbedBuilder().setColor(0x00C7FF).setTimestamp().setFooter({ text: "DRIP X SHOP · MODERACIÓN" });
    try {
      if (name === "ban") {
        await i.guild.members.ban(target.id, { reason: reason + " | Moderador: " + i.user.tag });
        audit.setTitle("🔨 Ban").setDescription("Usuario: <@" + target.id + ">\nModerador: " + i.user.tag + "\nMotivo: " + reason);
      } else if (name === "kick") {
        const member = await i.guild.members.fetch(target.id);
        await member.kick(reason + " | Moderador: " + i.user.tag);
        audit.setTitle("👢 Kick").setDescription("Usuario: <@" + target.id + ">\nModerador: " + i.user.tag + "\nMotivo: " + reason);
      } else if (name === "timeout") {
        const member = await i.guild.members.fetch(target.id);
        const minutes = i.options.getInteger("minutos");
        await member.timeout(minutes * 60000, reason + " | Moderador: " + i.user.tag);
        audit.setTitle("⏳ Timeout").setDescription("Usuario: <@" + target.id + ">\nDuración: " + minutes + " min\nMotivo: " + reason);
      } else if (name === "clear") {
        const amount = i.options.getInteger("cantidad");
        const deleted = await i.channel.bulkDelete(amount, true);
        audit.setTitle("🧹 Clear").setDescription("Mensajes eliminados: " + deleted.size + "\nModerador: " + i.user.tag);
      } else {
        await pool.query("INSERT INTO bot_warnings(guild_id,user_id,moderator_id,reason) VALUES($1,$2,$3,$4)", [i.guildId, target.id, i.user.id, reason]);
        audit.setTitle("⚠️ Advertencia").setDescription("Usuario: <@" + target.id + ">\nModerador: " + i.user.tag + "\nMotivo: " + reason);
      }
      await sendLog(i.guild, audit);
      return i.editReply("Acción ejecutada y registrada.");
    } catch (error) {
      console.error("Moderation command failed:", error.message);
      return i.editReply("No se pudo ejecutar. Comprueba la jerarquía de roles y los permisos del bot.");
    }
  }
}
async function handleTicketCreate(i) {
  const categories = await getJson("ticket_categories", DEFAULT_CATEGORIES);
  const category = categories.find(c => c.key === i.values[0]);
  if (!category) return i.reply({ content: "Esta categoría ya no está disponible. Actualiza el panel.", ephemeral: true });
  await i.deferReply({ ephemeral: true });
  const overwrites = [
    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
  ];
  if (category.roleId && i.guild.roles.cache.has(category.roleId)) {
    overwrites.push({ id: category.roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
  }
  const channel = await i.guild.channels.create({
    name: "ticket-" + slug(category.key) + "-" + slug(i.user.username).slice(0, 18),
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    reason: "Ticket creado por " + i.user.tag
  });
  const ticket = { openerId: i.user.id, categoryKey: category.key, categoryName: category.name, roleId: category.roleId, claimedBy: null, createdAt: Date.now() };
  await setTicket(channel.id, ticket);
  await channel.send({
    content: "<@" + i.user.id + ">" + (category.roleId ? " <@&" + category.roleId + ">" : ""),
    embeds: [await makeTicketManagementEmbed(ticket)],
    components: [makeManagementMenu()],
    allowedMentions: { users: [i.user.id], roles: category.roleId ? [category.roleId] : [] }
  });
  return i.editReply("Tu ticket está listo: " + channel.toString());
}
async function handleTicketManage(i) {
  const ticket = await getTicket(i.channelId);
  if (!ticket) return i.reply({ content: "No encuentro los datos de este ticket.", ephemeral: true });
  const action = i.values[0];
  if (action === "add_user") {
    if (!await ensureTicketAccess(i, ticket)) return;
    const modal = new ModalBuilder().setCustomId("ticket:adduser").setTitle("Añadir usuario");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("user_id").setLabel("ID de usuario de Discord").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(22)
    ));
    return i.showModal(modal);
  }
  if (action === "claim" && !isStaffForTicket(i, ticket)) return i.reply({ content: "Solo el equipo de soporte puede reclamar el ticket.", ephemeral: true });
  if (!await ensureTicketAccess(i, ticket)) return;
  if (action === "claim") {
    ticket.claimedBy = i.user.id;
    await setTicket(i.channelId, ticket);
    await i.update({ embeds: [await makeTicketManagementEmbed(ticket)], components: [makeManagementMenu()] });
    await i.channel.send("🧑‍💼 Ticket reclamado por " + i.user.toString() + ".");
  } else if (action === "transcript") {
    await i.deferReply({ ephemeral: true });
    await sendTranscript(i.channel, i.guild);
    await i.editReply("Transcripción HTML enviada al canal de logs configurado (o a este ticket).");
  } else if (action === "close") {
    await i.deferReply({ ephemeral: true });
    await sendTranscript(i.channel, i.guild).catch(() => null);
    await sendLog(i.guild, new EmbedBuilder().setColor(0xED4245).setTitle("Ticket cerrado").setDescription("Canal: #" + i.channel.name + "\nCerrado por: " + i.user.tag).setTimestamp());
    await i.editReply("Ticket cerrado. El canal se eliminará en 5 segundos.");
    setTimeout(() => i.channel.delete("Ticket cerrado por " + i.user.tag).catch(() => null), 5000);
  }
}
async function handleModal(i) {
  if (i.customId === "visual:save") {
    if (!isAdmin(i)) return i.reply({ content: "Necesitas permisos de administrador.", ephemeral: true });
    const get = id => cleanText(i.fields.getTextInputValue(id) || "", 300);
    const fields = {
      bannerStatus: get("visual:banner_status"),
      logoUrl: get("visual:logo"),
      bannerTickets: get("visual:banner_tickets"),
      color: safeHex(get("visual:color")),
      title: get("visual:title")
    };
    for (const key of ["bannerStatus", "logoUrl", "bannerTickets"]) {
      if (fields[key] && !/^https:\/\//i.test(fields[key])) return i.reply({ content: "Las imágenes deben usar una URL HTTPS.", ephemeral: true });
    }
    const old = await getVisual();
    for (const [key, value] of Object.entries(fields)) if (value) old[key] = value;
    await setJson("visual", old);
    await refreshStatusPanel();
    await refreshTicketPanel();
    return i.reply({ content: "Identidad visual guardada y paneles actualizados.", ephemeral: true });
  }
  if (i.customId === "ticket:adduser") {
    const ticket = await getTicket(i.channelId);
    if (!ticket || !await ensureTicketAccess(i, ticket)) return;
    if (!isStaffForTicket(i, ticket)) return i.reply({ content: "Solo soporte puede añadir usuarios.", ephemeral: true });
    const userId = i.fields.getTextInputValue("user_id").trim();
    if (!/^\d{17,22}$/.test(userId)) return i.reply({ content: "El ID no tiene un formato válido.", ephemeral: true });
    const member = await i.guild.members.fetch(userId).catch(() => null);
    if (!member) return i.reply({ content: "No encontré a ese miembro en el servidor.", ephemeral: true });
    await i.channel.permissionOverwrites.edit(member.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true
    });
    return i.reply({ content: "Usuario añadido al ticket: " + member.toString(), ephemeral: true });
  }
}
client.on("interactionCreate", async i => {
  try {
    if (i.isChatInputCommand()) await executeCommand(i);
    else if (i.isStringSelectMenu() && i.customId === "ticket:create") await handleTicketCreate(i);
    else if (i.isStringSelectMenu() && i.customId === "ticket:manage") await handleTicketManage(i);
    else if (i.isModalSubmit()) await handleModal(i);
  } catch (error) {
    console.error("Interaction failed:", error.message);
    const payload = { content: "Ocurrió un error al procesar la acción. Revisa los permisos del bot y vuelve a intentarlo.", ephemeral: true };
    if (i.deferred || i.replied) await i.followUp(payload).catch(() => null);
    else await i.reply(payload).catch(() => null);
  }
});
client.on("messageDelete", message => { recreateDeletedPanel(message).catch(err => console.error("Panel recovery failed:", err.message)); });
client.once("ready", async () => {
  console.log("Discord bot connected as " + client.user.tag);
  try {
    await registerCommands();
    await refreshStatusPanel();
    await refreshTicketPanel();
    await updatePresence();
  } catch (error) {
    console.error("Discord initialization error:", error.message);
  }
});

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "12kb", strict: true }));
app.use("/api/", rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.get("/", (_req, res) => res.status(200).json({ service: "DRIP X SHOP MTA Discord Manager", status: "ok" }));
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, discord: client.isReady(), database: true });
  } catch {
    res.status(503).json({ ok: false, database: false });
  }
});
app.post("/api/mta-status", async (req, res) => {
  const secret = req.get("x-api-key") || "";
  const expected = process.env.MTA_API_SECRET || process.env.API_SECRET;
  if (!safeEqual(secret, expected)) return res.status(401).json({ error: "unauthorized" });
  const body = req.body || {};
  const serverName = cleanText(body.serverName, 100);
  const players = body.players;
  const maxPlayers = body.maxPlayers;
  if (!serverName || !Number.isInteger(players) || !Number.isInteger(maxPlayers) ||
      players < 0 || maxPlayers < 1 || maxPlayers > 10000 || players > 10000) {
    return res.status(400).json({ error: "invalid_payload" });
  }
  runtime.lastHeartbeatAt = Date.now();
  runtime.mta = { serverName, players, maxPlayers };
  const visual = await getVisual();
  let visualChanged = false;
  for (const field of ["bannerStatus", "logoUrl", "bannerTickets"]) {
    const candidate = cleanText(body[field], 500);
    if (candidate && /^https:\/\//i.test(candidate) && visual[field] !== candidate) {
      visual[field] = candidate;
      visualChanged = true;
    }
  }
  if (visualChanged) await setJson("visual", visual);
  await setJson("mta_latest", { ...runtime.mta, receivedAt: runtime.lastHeartbeatAt });
  await Promise.all([refreshStatusPanel(), updatePresence(), ...(visualChanged ? [refreshTicketPanel()] : [])]);
  return res.status(200).json({ accepted: true, online: true });
});
app.post("/api/mta-event", async (req, res) => {
  const secret = req.get("x-api-key") || "";
  const expected = process.env.MTA_API_SECRET || process.env.API_SECRET;
  if (!safeEqual(secret, expected)) return res.status(401).json({ error: "unauthorized" });
  const event = req.body?.event;
  const playerName = cleanText(req.body?.playerName, 48);
  if (!["join", "quit"].includes(event) || !playerName) return res.status(400).json({ error: "invalid_payload" });
  const logId = await getJson("joinquit_log_channel", null);
  if (logId && client.isReady()) {
    const channel = await client.channels.fetch(logId).catch(() => null);
    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder().setColor(event === "join" ? 0x57F287 : 0xED4245)
        .setTitle(event === "join" ? "MTA JOIN" : "MTA QUIT")
        .setDescription("Jugador: " + playerName).setTimestamp(new Date())
        .setFooter({ text: "DRIP X SHOP · MTA LOGS" });
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
    }
  }
  return res.status(200).json({ accepted: true });
});
app.use("/assets", express.static(path.join(__dirname, "..", "public"), { fallthrough: true, maxAge: "1h" }));

async function start() {
  await initDatabase();
  const persisted = await getJson("mta_latest", null);
  if (persisted) runtime.mta = persisted;
  // A fresh process is offline until it receives a new authenticated heartbeat.
  runtime.lastHeartbeatAt = 0;
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => console.log("HTTP service listening on port " + port));
  await client.login(process.env.DISCORD_TOKEN);
  setInterval(async () => {
    const online = runtime.lastHeartbeatAt > 0 && Date.now() - runtime.lastHeartbeatAt <= 60000;
    if (!online) {
      await refreshStatusPanel().catch(err => console.error("Status refresh failed:", err.message));
      await updatePresence().catch(() => null);
    }
  }, 15000);
}
process.on("unhandledRejection", error => console.error("Unhandled rejection:", error?.message || error));
process.on("SIGTERM", async () => {
  try { await client.destroy(); await pool.end(); } finally { process.exit(0); }
});
start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});
