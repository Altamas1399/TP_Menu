import { system, world, ItemStack, ItemLockMode } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";

// ---- Form helpers: work with @minecraft/server-ui 1.x AND 2.x ----
function addTextField(ui, label, placeholder, defaultValue = "") {
  try { ui.textField(label, placeholder, { defaultValue }); }
  catch { ui.textField(label, placeholder, defaultValue); }
}
function addToggle(ui, label, defaultValue = false) {
  try { ui.toggle(label, { defaultValue }); }
  catch { ui.toggle(label, defaultValue); }
}
function addDropdown(ui, label, options, defaultValueIndex = 0) {
  try { ui.dropdown(label, options, { defaultValueIndex }); }
  catch { ui.dropdown(label, options, defaultValueIndex); }
}
function addSlider(ui, label, min, max, valueStep, defaultValue) {
  try { ui.slider(label, min, max, { valueStep, defaultValue }); }
  catch { ui.slider(label, min, max, valueStep, defaultValue); }
}

const ADMIN_TAG = "admin";
const COUNTDOWN_TAG = "underMovementCountdown";

const DEFAULT_SETTINGS = {
  blacklistTag: "tpiBlocked",
  tprTpaCountdown: true,
  respawnpointMarker: true,
  respawnpointIcon: "textures/items/bed_red",
  movementCountdown: 5,
  maxWaypoints: 5,
  locationHistoryEnabled: true,
  waypointsEnabled: true,
  infoButtonEnabled: true,
  autoGiveTpMenu: true,
  deathpointEnabled: true,
  deathpointCooldown: 5,
};

// Runtime state lives in module variables, not as custom properties on world/player objects
let settings = { ...DEFAULT_SETTINGS };
const tpRequests = new Map();          // senderName -> receiverName
const deathPoints = new Map();         // playerName -> { x, y, z, dim, created }
const deathPointsCooldown = new Map(); // playerName -> timestamp
const countdowns = new Map();          // playerId -> { location, dimId, runId }

// Set to false once everything works
const DEBUG = false;
function debug(player, msg) {
  console.warn("[TP Menu] " + msg);
  if (DEBUG && player) { try { player.sendMessage("§7[TP Menu] " + msg); } catch { } }
}

// World/dynamic-property access is not allowed while the script first loads
// (early execution), so load saved data once the world has loaded.
let worldReady = false;
function initWorldData() {
  if (worldReady) return;
  worldReady = true;
  try {
    const raw = world.getDynamicProperty("packSettings");
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { }
  if (settings.blacklistTag === ADMIN_TAG) settings.blacklistTag = "tpiBlocked";
  world.setDynamicProperty("packSettings", JSON.stringify(settings));
  if (!world.getDynamicProperty("globalWaypoints")) {
    world.setDynamicProperty("globalWaypoints", JSON.stringify({}));
  }
  console.warn("[TP Menu] world data loaded");
}
try {
  if (world.afterEvents.worldLoad) world.afterEvents.worldLoad.subscribe(() => { try { initWorldData(); } catch (e) { console.warn("[TP Menu] init failed: " + e); } });
} catch { }
system.runTimeout(() => { try { initWorldData(); } catch (e) { console.warn("[TP Menu] init failed: " + e); } }, 1);
console.warn("[TP Menu] script file loaded");

world.afterEvents.playerLeave.subscribe(e => {
  tpRequests.delete(e.playerName);
  for (const [k, v] of tpRequests)
    if (v === e.playerName) tpRequests.delete(k);
  deathPoints.delete(e.playerName);
  const cd = countdowns.get(e.playerId);
  if (cd) {
    system.clearRun(cd.runId);
    countdowns.delete(e.playerId);
  }
});

// A player who left mid-countdown keeps the tag and would be locked out of the menu forever
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;
  player.removeTag(COUNTDOWN_TAG);
  debug(player, "script is running");
  // short delay so the inventory and settings are ready
  system.runTimeout(() => {
    try {
      try {
        if (settings.autoGiveTpMenu) autoGiveTpMenuCheck(player);
      } catch (e) {
        console.warn("[TP Menu] auto-give failed: " + e);
      }
    } catch (e) {
      console.warn("[TP Menu] auto-give failed: " + e);
    }
  }, 40);
});

function cancelCountdown(player) {
  const cd = countdowns.get(player.id);
  if (cd) system.clearRun(cd.runId);
  countdowns.delete(player.id);
  player.removeTag(COUNTDOWN_TAG);
}

system.runInterval(() => {
  for (const player of world.getPlayers({ tags: [COUNTDOWN_TAG] })) {
    const cd = countdowns.get(player.id);
    if (!cd) {
      player.removeTag(COUNTDOWN_TAG);
      continue;
    }
    const loc = player.location;
    const dx = loc.x - cd.location.x, dy = loc.y - cd.location.y, dz = loc.z - cd.location.z;
    if (player.dimension.id !== cd.dimId || dx * dx + dy * dy + dz * dz > 0.01) {
      player.sendMessage("§cAction canceled, you moved");
      cancelCountdown(player);
      playSound(player, "note.bass");
    } else {
      player.runCommand("particle minecraft:end_chest ~~1~");
    }
  }
}, 5);

system.runInterval(() => {
  for (const player of world.getPlayers()) {
    try {
      if (settings.autoGiveTpMenu) autoGiveTpMenuCheck(player);
    } catch (e) {
      console.warn("[TP Menu] auto-give failed: " + e);
    }
    const data = player.getDynamicProperty("locationHistory") ?? "[]";
    let arr;
    try { arr = JSON.parse(data); } catch { arr = []; }
    arr.push({
      x: player.location.x,
      y: player.location.y,
      z: player.location.z,
      dim: player.dimension.id,
      t: Date.now()
    });
    if (arr.length > 100) arr.shift();
    player.setDynamicProperty("locationHistory", JSON.stringify(arr));
  }
}, 1200);

world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
  if (!deadEntity || deadEntity.typeId !== "minecraft:player") return;
  const player = deadEntity;
  const cfg = settings;
  if (!cfg.deathpointEnabled) return;
  const name = player.name;
  const cooldownMs = cfg.deathpointCooldown * 60 * 1000;
  const now = Date.now();
  const last = deathPointsCooldown.get(name) ?? 0;
  if (now - last < cooldownMs) {
    player.sendMessage("§cDeathpoint was not saved. You can only save one deathpoint per cooldown.");
    return;
  }
  deathPointsCooldown.set(name, now);
  const pos = player.location;
  const dim = player.dimension.id;
  const dpData = { x: pos.x, y: pos.y, z: pos.z, dim, created: now };
  deathPoints.set(name, dpData);
  player.sendMessage("§eYou have 3 minutes to teleport to your deathpoint using the TP Menu.");
  system.runTimeout(() => {
    const stored = deathPoints.get(name);
    if (stored && stored.created === dpData.created) {
      deathPoints.delete(name);
      try { player.sendMessage("§cYour deathpoint has expired."); } catch { }
    }
  }, 3600);
});

world.afterEvents.itemUse.subscribe(({ source, itemStack }) => {
  if (!source || !("hasTag" in source)) return;
  if (itemStack.typeId !== "tpi:tp_menu") return;
  debug(source, "TP Menu used");
  if (source.hasTag(settings.blacklistTag)) {
    source.sendMessage("§cYou are blacklisted from using the TP Menu");
    playSound(source, "note.bass");
    return;
  }
  if (source.hasTag(COUNTDOWN_TAG)) {
    source.sendMessage("§cCan't use the menu while waiting for an action");
    playSound(source, "note.bass");
    return;
  }
  system.run(() => {
    try {
      openMainMenu(source);
    } catch (e) {
      console.warn("[TP Menu] failed to open menu: " + e);
      source.sendMessage("§cTP Menu error: " + e);
    }
  });
});

function openMainMenu(player, msg = "") {
  playSound(player, "random.pop");
  const cfg = settings;
  const reqOut = tpRequests.get(player.name);
  let incoming = 0;
  for (const val of tpRequests.values()) if (val === player.name) incoming++;
  const dpData = deathPoints.get(player.name);
  const ui = new ActionFormData();
  ui.title("§lTP Menu (Extended)§r");
  if (msg) ui.body("§c" + msg);
  const isAdmin = player.hasTag(ADMIN_TAG);
  const actions = [];
  const add = (label, icon, action) => { ui.button(label, icon); actions.push(action); };
  if (!reqOut) add("Send a TP Request", "textures/items/ender_pearl", () => openSendRequest(player));
  else add(`Your outgoing Request\nTo §3${reqOut}`, "textures/items/ender_eye", () => openOutgoingRequest(player));
  add(`Your incoming Requests\n§8[§a${incoming > 0 ? incoming : "§4None"}§8]`, "textures/ui/icon_blackfriday", () => openIncomingRequests(player));
  add("Teleport to a Marker", "textures/ui/mashup_world", () => openMarkers(player));
  if (cfg.waypointsEnabled || isAdmin) add("Waypoints", "textures/ui/mashup_world", () => openWaypointsMenu(player));
  else add("Waypoints (Disabled)", "textures/ui/mashup_world", () => disabledFeature(player));
  if (cfg.locationHistoryEnabled || isAdmin) add("Location History", "textures/ui/icon_map", () => openLocationHistory(player));
  else add("Location History (Disabled)", "textures/ui/icon_map", () => disabledFeature(player));
  if (dpData && cfg.deathpointEnabled) add("Deathpoint", "textures/ui/heart_background", () => confirmDeathpointTeleport(player, dpData));
  if (cfg.infoButtonEnabled || isAdmin) add("§lInfo", "textures/ui/infobulb", () => openInfo(player));
  if (isAdmin) add("Admin Menu", "textures/ui/icon_setting", () => openAdminMenu(player));
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled || selection === undefined) return;
    actions[selection]?.();
  }).catch(e => console.warn("[TP Menu] main menu error: " + e));
}

function disabledFeature(player) {
  playSound(player, "note.bass");
  player.sendMessage("§cThis feature was disabled by an admin.");
}

function confirmDeathpointTeleport(player, dp) {
  const ui = new MessageFormData()
    .title("Confirm Deathpoint Teleport")
    .body("Teleport to your saved deathpoint?\nAvailable for 3 minutes or until you die again.")
    .button1("Yes")
    .button2("No");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled || selection === 1) return openMainMenu(player);
    startCountdown(player, () => teleportDeathpoint(player, dp), null, "Teleporting to your Deathpoint...");
  });
}

function teleportDeathpoint(player, dp) {
  const existing = deathPoints.get(player.name);
  if (!existing || existing.created !== dp.created) {
    playSound(player, "note.bass");
    player.sendMessage("§cNo active deathpoint found.");
    return;
  }
  const dim = world.getDimension(dp.dim);
  if (!dim) {
    playSound(player, "note.bass");
    player.sendMessage("§cDeathpoint dimension not found.");
    return;
  }
  playTpParticles(player);
  player.teleport({ x: dp.x, y: dp.y, z: dp.z }, { dimension: dim });
  player.sendMessage("§aTeleported to your deathpoint.");
  deathPoints.delete(player.name);
}

function openInfo(player) {
  const ui = new MessageFormData()
    .title("§lAdd-On Info")
    .body(
      "§eTP Menu v1.0.0\n" +
      "Created by: §bAltamas#1682§r"
    );
  ui.button1("Close");
  ui.button2("Return");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled || selection === 0) return;
    openMainMenu(player);
  });
}

function openAdminMenu(player) {
  if (!player.hasTag(ADMIN_TAG)) return;
  playSound(player, "random.pop");
  const ui = new ActionFormData();
  ui.title("§lAdmin Menu§r");
  ui.button("Manage Markers", "textures/items/map_filled");
  ui.button("Manage Player Waypoints", "textures/ui/creative_icon");
  ui.button("Settings", "textures/ui/icon_setting");
  ui.button("Return");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    if (selection === 0) openMarkerManagement(player);
    else if (selection === 1) openManageAllWaypoints(player);
    else if (selection === 2) openSettings(player);
    else openMainMenu(player);
  });
}

function openManageAllWaypoints(player) {
  if (!player.hasTag(ADMIN_TAG)) return;
  const ui = new ActionFormData();
  ui.title("Manage Others' Waypoints");
  ui.body("Select an option:");
  ui.button("Search Player by Name", "textures/ui/icon_map");
  ui.button("List All Players", "textures/ui/magnifyingGlass");
  ui.button("Return");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    if (selection === 0) manageAllWaypointsSearch(player);
    else if (selection === 1) manageAllWaypointsList(player);
    else openAdminMenu(player);
  });
}

function manageAllWaypointsSearch(player) {
  if (!player.hasTag(ADMIN_TAG)) return;
  const ui = new ModalFormData();
  ui.title("Search Player");
  addTextField(ui, "Enter partial or full player name", "Name", "");
  ui.submitButton("Search");
  ui.show(player).then(({ canceled, formValues }) => {
    if (canceled) return openManageAllWaypoints(player);
    const input = formValues[0].trim().toLowerCase();
    const gwp = getGlobalWaypoints();
    const results = Object.keys(gwp).filter(n => n.toLowerCase().includes(input));
    if (!results.length) {
      playSound(player, "note.bass");
      return manageAllWaypointsSearch(player);
    }
    const ui2 = new ActionFormData();
    ui2.title("Search Results");
    for (const rName of results) ui2.button(rName);
    ui2.button("Return");
    ui2.show(player).then(({ canceled, selection }) => {
      if (canceled) return openManageAllWaypoints(player);
      if (selection === results.length) return openManageAllWaypoints(player);
      openOtherPlayerWaypoints(player, results[selection]);
    });
  });
}

function manageAllWaypointsList(player) {
  if (!player.hasTag(ADMIN_TAG)) return;
  const gwp = getGlobalWaypoints();
  const all = Object.keys(gwp);
  if (!all.length) {
    playSound(player, "note.bass");
    return openManageAllWaypoints(player);
  }
  const ui = new ActionFormData();
  ui.title("All Players with Waypoints");
  for (const nm of all) ui.button(nm);
  ui.button("Return");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return openManageAllWaypoints(player);
    if (selection === all.length) return openManageAllWaypoints(player);
    openOtherPlayerWaypoints(player, all[selection]);
  });
}

function openOtherPlayerWaypoints(admin, target) {
  if (!admin.hasTag(ADMIN_TAG)) return;
  const gwp = getGlobalWaypoints();
  if (!gwp[target]) gwp[target] = [];
  const list = gwp[target];
  const ui = new ActionFormData();
  ui.title(`Waypoints of "${target}"`);
  if (!list.length) ui.body("No waypoints found for this player.");
  for (const w of list) ui.button(`${w.name}\n${coloredDimension(w.dim)}`);
  ui.button("Return");
  ui.show(admin).then(({ canceled, selection }) => {
    if (canceled) return openManageAllWaypoints(admin);
    if (selection === list.length) return openManageAllWaypoints(admin);
    openOtherPlayerWaypointOptions(admin, target, selection);
  });
}

function openOtherPlayerWaypointOptions(admin, target, idx) {
  const gwp = getGlobalWaypoints();
  const list = gwp[target] || [];
  const wp = list[idx];
  if (!wp) {
    playSound(admin, "note.bass");
    return openOtherPlayerWaypoints(admin, target);
  }
  const createdAgo = getTimeAgo(wp.created || 0);
  const ui = new ActionFormData();
  ui.title(wp.name);
  ui.body(`Coordinates: X${wp.pos.x.toFixed(1)} Y${wp.pos.y.toFixed(1)} Z${wp.pos.z.toFixed(1)}\nDimension: ${coloredDimension(wp.dim)}\nCreated: ${createdAgo}`);
  ui.button("Teleport", "textures/items/ender_pearl");
  ui.button("Rename", "textures/items/book_writable");
  ui.button("Delete", "textures/ui/icon_trash");
  ui.button("Return");
  ui.show(admin).then(({ canceled, selection }) => {
    if (canceled) return openOtherPlayerWaypoints(admin, target);
    if (selection === 0) startCountdown(admin, () => adminTeleportToWaypoint(admin, wp), null, `Teleporting to ${wp.name}...`);
    else if (selection === 1) openOtherPlayerWaypointRename(admin, target, idx);
    else if (selection === 2) openOtherPlayerWaypointDelete(admin, target, idx);
    else openOtherPlayerWaypoints(admin, target);
  });
}

function adminTeleportToWaypoint(admin, wp) {
  playTpParticles(admin);
  const dim = world.getDimension(wp.dim);
  if (!dim) {
    admin.sendMessage("Invalid dimension.");
    playSound(admin, "note.bass");
    return;
  }
  admin.teleport(wp.pos, { dimension: dim, rotation: wp.rot });
  admin.sendMessage(`Teleported to ${wp.name}`);
}

function openOtherPlayerWaypointRename(admin, target, idx) {
  const gwp = getGlobalWaypoints();
  const list = gwp[target];
  const wp = list[idx];
  if (!wp) return openOtherPlayerWaypoints(admin, target);
  const ui = new ModalFormData();
  ui.title("Rename " + wp.name);
  addTextField(ui, "New Name", "Name", wp.name);
  ui.submitButton("Save");
  ui.show(admin).then(({ canceled, formValues }) => {
    if (canceled) return openOtherPlayerWaypoints(admin, target);
    const nName = formValues[0].trim();
    if (!nName) {
      playSound(admin, "note.bass");
      return openOtherPlayerWaypoints(admin, target);
    }
    wp.name = nName;
    list[idx] = wp;
    gwp[target] = list;
    saveGlobalWaypoints(gwp);
    admin.sendMessage("Renamed waypoint.");
    playSound(admin, "random.orb");
    openOtherPlayerWaypoints(admin, target);
  });
}

function openOtherPlayerWaypointDelete(admin, target, idx) {
  const gwp = getGlobalWaypoints();
  const list = gwp[target];
  const wp = list[idx];
  if (!wp) return openOtherPlayerWaypoints(admin, target);
  const ui = new MessageFormData()
    .title("Delete " + wp.name)
    .body("Delete this waypoint?")
    .button1("Yes")
    .button2("No");
  ui.show(admin).then(({ selection }) => {
    if (selection === 0) {
      list.splice(idx, 1);
      gwp[target] = list;
      saveGlobalWaypoints(gwp);
      admin.sendMessage("Waypoint deleted.");
      playSound(admin, "random.glass");
      openOtherPlayerWaypoints(admin, target);
    } else {
      openOtherPlayerWaypoints(admin, target);
    }
  });
}

function openSendRequest(player, msg = "") {
  const ui = new ModalFormData();
  ui.title("Send a TP Request");
  if (msg) addTextField(ui, `Search for a Player\n${msg}`, "Name", "");
  else addTextField(ui, "Search for a Player", "Name", "");
  ui.submitButton("Search");
  ui.show(player).then(({ canceled, formValues }) => {
    if (canceled) return;
    const search = formValues[0].trim().toLowerCase();
    const all = world.getAllPlayers();
    const found = all.filter(p => p.name.toLowerCase().includes(search) && p.name !== player.name);
    if (!found.length) {
      playSound(player, "note.bass");
      return openSendRequest(player, `No player found with "${formValues[0]}"`);
    }
    const ui2 = new ActionFormData();
    ui2.title("Send a TP Request");
    ui2.body(`Players matching "${search}"`);
    found.forEach(p => ui2.button(p.name));
    ui2.button("Return");
    ui2.show(player).then(({ canceled, selection }) => {
      if (canceled) return;
      if (selection === found.length) return;
      const target = found[selection];
      if (settings.tprTpaCountdown) startCountdown(player, () => sendRequest(player, target), null, `Sending ${target.name} a request...`);
      else sendRequest(player, target);
    });
  });
}

function sendRequest(sender, receiver) {
  tpRequests.set(sender.name, receiver.name);
  receiver.sendMessage(`§a${sender.name} has sent you a TP Request.`);
  playSound(receiver, "random.orb");
  sender.sendMessage(`§aA TP Request was sent to ${receiver.name}`);
  playSound(sender, "random.orb");
}

function openOutgoingRequest(player) {
  const tgt = tpRequests.get(player.name);
  const rec = world.getPlayers({ name: tgt })[0];
  if (!rec) {
    tpRequests.delete(player.name);
    openMainMenu(player, "The target is no longer online.");
    return;
  }
  const ui = new MessageFormData()
    .title("TP Request to " + tgt)
    .body(`Active request to ${tgt}.\nYou can cancel here.`)
    .button1("Cancel")
    .button2("Return");
  ui.show(player).then(({ selection }) => {
    if (selection === 0) {
      tpRequests.delete(player.name);
      player.sendMessage(`§cYour request to ${tgt} was cancelled`);
      rec.sendMessage(`§c${player.name} cancelled their request`);
      rec.removeTag(COUNTDOWN_TAG);
      playSound(player, "random.orb");
      playSound(rec, "note.bass");
    }
  });
}

function openIncomingRequests(player) {
  const arr = [];
  for (const [snd, rcp] of tpRequests) if (rcp === player.name) arr.push(snd);
  if (!arr.length) {
    openMainMenu(player, "No incoming TP Requests");
    return;
  }
  const ui = new ActionFormData();
  ui.title("Your incoming Requests");
  ui.body("Select a request to accept or reject.");
  arr.forEach(n => ui.button(n));
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    const snd = arr[selection];
    const sPlayer = world.getPlayers({ name: snd })[0];
    if (!sPlayer) {
      tpRequests.delete(snd);
      playSound(player, "note.bass");
      openMainMenu(player, "Request sender not online.");
      return;
    }
    const ui2 = new MessageFormData()
      .title((snd.endsWith("s") ? snd + "'" : snd + "'s") + " Request")
      .body(`${snd} wants to teleport to you.\nAccepting will teleport them here.`)
      .button1("Decline")
      .button2("Accept");
    ui2.show(player).then(({ canceled, selection }) => {
      if (canceled) return;
      if (selection === 0) {
        tpRequests.delete(snd);
        player.sendMessage(`§c${snd}'s request was declined`);
        sPlayer.sendMessage(`§c${player.name} declined your request`);
        playSound(player, "random.orb");
        playSound(sPlayer, "note.bass");
      } else {
        if (settings.tprTpaCountdown) startCountdown(player, () => acceptRequest(player, sPlayer), null, `Accepting ${snd}'s request...`);
        else acceptRequest(player, sPlayer);
      }
    });
  });
}

function acceptRequest(acceptor, sender) {
  if (tpRequests.get(sender.name) !== acceptor.name) return;
  tpRequests.delete(sender.name);
  playTpParticles(sender);
  sender.teleport(acceptor.location, { dimension: acceptor.dimension });
  acceptor.sendMessage(`${sender.name}'s request was accepted`);
  sender.sendMessage(`${acceptor.name} accepted your request`);
  playSound(acceptor, "random.levelup");
  playSound(sender, "random.orb");
}

function openMarkers(player) {
  const regAll = JSON.parse(world.getDynamicProperty("markerRegistry") ?? "[]");
  const reg = player.hasTag(ADMIN_TAG) ? regAll : regAll.filter(m => !m.hid);
  if (!reg.length && !settings.respawnpointMarker) {
    openMainMenu(player, "No Markers available.");
    return;
  }
  const ui = new ActionFormData();
  ui.title("Teleport to a Marker");
  if (settings.respawnpointMarker) ui.button("Respawnpoint\n§8[§2Personal§8]", settings.respawnpointIcon);
  reg.forEach(m => {
    const base = m.name.replace(/§.?/g, "");
    const extra = m.hid ? "\n§8[Private]" : "";
    ui.button(base + extra, m.ico ?? "textures/ui/mashup_world");
  });
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    if (settings.respawnpointMarker && selection === 0) {
      startCountdown(player, () => tpToRespawnpoint(player), null, "Teleporting to Respawnpoint...");
    } else {
      const idx = settings.respawnpointMarker ? selection - 1 : selection;
      const marker = reg[idx];
      if (!marker) return;
      startCountdown(player, () => tpToMarker(player, marker), null, `Teleporting to ${marker.name}...`);
    }
  });
}

function tpToRespawnpoint(player) {
  playTpParticles(player);
  const sp = player.getSpawnPoint() ?? world.getDefaultSpawnLocation();
  if (sp.y > 319 && sp.dimension === undefined) {
    sp.y = world.getDimension("minecraft:overworld").getTopmostBlock(sp).y + 1;
    world.setDefaultSpawnLocation(sp);
  }
  player.teleport(sp, { dimension: sp.dimension ?? world.getDimension("minecraft:overworld") });
  player.sendMessage("Teleported to Respawnpoint");
  player.addEffect("resistance", 3, { amplifier: 255, showParticles: false });
}

function tpToMarker(player, marker) {
  try {
    playTpParticles(player);
    const dim = world.getDimension(marker.dim);
    player.teleport(marker.pos, { rotation: marker.rot, dimension: dim });
    player.sendMessage(`Teleported to ${marker.name}`);
  } catch {
    player.sendMessage(`§cMarker data error: ${marker.name}`);
    playSound(player, "note.bass");
  }
}

function openMarkerManagement(player) {
  if (!player.hasTag(ADMIN_TAG)) return;
  const reg = JSON.parse(world.getDynamicProperty("markerRegistry") ?? "[]");
  const ui = new ActionFormData();
  ui.title("Manage Markers");
  ui.button("New Marker", "textures/ui/subscription_glyph_color");
  reg.forEach(m => {
    const base = m.name.replace(/§.?/g, "");
    const priv = m.hid ? "\n§8[Private]" : "";
    ui.button(base + priv, m.ico ?? "textures/ui/mashup_world");
  });
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    if (selection === 0) openCreateMarker(player);
    else {
      const idx = selection - 1;
      if (!reg[idx]) {
        playSound(player, "note.bass");
        return;
      }
      openEditMarker(player, idx);
    }
  });
}

function openCreateMarker(player) {
  const pos = player.location;
  const dp = `${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`;
  const dims = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
  const ui = new ModalFormData();
  ui.title("New Marker");
  addTextField(ui, "Marker Name", "Name", "");
  addTextField(ui, "Position (X Y Z)", "Coordinates", dp);
  addTextField(ui, "Rotation (X Y)", "Rotation", "0 0");
  addDropdown(ui, "Dimension", dims, 0);
  addTextField(ui, "Icon Path", "textures/ui/mashup_world", "");
  addToggle(ui, "Private?", false);
  ui.submitButton("Create");
  ui.show(player).then(({ canceled, formValues }) => {
    if (canceled) return;
    const [mName, xyz, rot, dIdx, iconPath, priv] = formValues;
    const name = mName.trim() || "Unnamed";
    const icon = iconPath.trim() || "textures/ui/mashup_world";
    const coords = xyz.split(/\s+/g, 3).map(Number);
    const rots = rot.split(/\s+/g, 2).map(Number);
    const dimension = dims[dIdx] ?? "minecraft:overworld";
    if (coords.length < 3 || coords.some(isNaN)) {
      playSound(player, "note.bass");
      player.sendMessage("§cInvalid position. Use: X Y Z");
      return;
    }
    const reg = JSON.parse(world.getDynamicProperty("markerRegistry") ?? "[]");
    reg.push({
      name: name,
      pos: { x: coords[0], y: coords[1], z: coords[2] },
      rot: { x: rots[0] || 0, y: rots[1] || 0 },
      dim: dimension,
      ico: icon,
      hid: priv
    });
    world.setDynamicProperty("markerRegistry", JSON.stringify(reg));
    player.sendMessage(`§aCreated marker "${name}"`);
    playSound(player, "random.orb");
    openMarkerManagement(player);
  });
}

function openEditMarker(player, idx) {
  const reg = JSON.parse(world.getDynamicProperty("markerRegistry") ?? "[]");
  const m = reg[idx];
  if (!m) return;
  const dims = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
  const dimI = dims.indexOf(m.dim);
  const ui = new ModalFormData();
  ui.title("Edit Marker");
  addToggle(ui, "Delete Marker?", false);
  addTextField(ui, "Marker Name", "Name", m.name);
  addTextField(ui, "Position (X Y Z)", "Coordinates", `${m.pos.x} ${m.pos.y} ${m.pos.z}`);
  addTextField(ui, "Rotation (X Y)", "Rotation", `${m.rot.x} ${m.rot.y}`);
  addDropdown(ui, "Dimension", dims, dimI === -1 ? 0 : dimI);
  addTextField(ui, "Icon Path", "textures/ui/mashup_world", m.ico ?? "textures/ui/mashup_world");
  addToggle(ui, "Private?", !!m.hid);
  ui.submitButton("Save");
  ui.show(player).then(({ canceled, formValues }) => {
    if (canceled) return;
    const [del, nName, xyz, roxy, dd, ic, pr] = formValues;
    if (del) {
      reg.splice(idx, 1);
      world.setDynamicProperty("markerRegistry", JSON.stringify(reg));
      player.sendMessage(`§cDeleted marker "${m.name}"`);
      playSound(player, "random.glass");
      return openMarkerManagement(player);
    }
    const coords = xyz.split(/\s+/g, 3).map(Number);
    const rots = roxy.split(/\s+/g, 2).map(Number);
    if (coords.length < 3 || coords.some(isNaN)) {
      playSound(player, "note.bass");
      player.sendMessage("§cInvalid position. Use: X Y Z");
      return;
    }
    m.name = nName.trim() || m.name;
    m.pos = { x: coords[0], y: coords[1], z: coords[2] };
    m.rot = { x: rots[0], y: rots[1] };
    m.dim = dims[dd] ?? "minecraft:overworld";
    m.ico = ic.trim() || "textures/ui/mashup_world";
    m.hid = pr;
    reg[idx] = m;
    world.setDynamicProperty("markerRegistry", JSON.stringify(reg));
    player.sendMessage(`§6Edited marker "${m.name}"`);
    playSound(player, "random.orb");
    openMarkerManagement(player);
  });
}

function openWaypointsMenu(player, msg = "") {
  const cfg = settings;
  if (!cfg.waypointsEnabled && !player.hasTag(ADMIN_TAG)) {
    playSound(player, "note.bass");
    player.sendMessage("§cThis feature was disabled by an admin.");
    return;
  }
  if (player.hasTag(cfg.blacklistTag)) {
    openMainMenu(player, "You are blacklisted.");
    return;
  }
  const ui = new ActionFormData();
  ui.title("Waypoints");
  if (msg) ui.body("§c" + msg);
  ui.button("Create New Waypoint", "textures/items/book_writable");
  const list = getWaypointsOfPlayer(player.name);
  for (let i = 0; i < list.length; i++) {
    const ago = getTimeAgo(list[i].created || 0);
    ui.button(`${list[i].name}\n${coloredDimension(list[i].dim)}\n§8[${ago}]`);
  }
  ui.button("Return");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    if (selection === 0) {
      if (list.length >= cfg.maxWaypoints) {
        playSound(player, "note.bass");
        openWaypointsMenu(player, `Max of ${cfg.maxWaypoints} waypoints reached.`);
        return;
      }
      startCountdown(player, () => createWaypoint(player), null, "Creating a new Waypoint...");
    } else if (selection === list.length + 1) {
      openMainMenu(player);
    } else {
      const idx = selection - 1;
      const wp = list[idx];
      if (!wp) {
        playSound(player, "note.bass");
        openWaypointsMenu(player);
        return;
      }
      openWaypointOptions(player, wp, idx);
    }
  });
}

function createWaypoint(player) {
  openNewWaypointNameMenu(player);
}

function openNewWaypointNameMenu(player) {
  const loc = player.location;
  const defaultName = `Waypoint ${getWaypointsOfPlayer(player.name).length + 1}`;
  const ui = new ModalFormData();
  ui.title("New Waypoint");
  addTextField(ui, "Enter waypoint name", "Name", defaultName);
  ui.submitButton("Save");
  ui.show(player).then(({ canceled, formValues }) => {
    if (canceled) {
      player.sendMessage("Waypoint creation cancelled.");
      playSound(player, "note.bass");
      return;
    }
    const name = formValues[0].trim();
    if (!name) {
      player.sendMessage("Name cannot be empty. Waypoint creation cancelled.");
      playSound(player, "note.bass");
      return;
    }
    const savedLoc = loc;
    const wps = getWaypointsOfPlayer(player.name);
    wps.push({
      name: name,
      dim: player.dimension.id,
      pos: { x: savedLoc.x, y: savedLoc.y, z: savedLoc.z },
      rot: { x: 0, y: 0 },
      created: Date.now()
    });
    saveWaypointsOfPlayer(player.name, wps);
    player.sendMessage("New Waypoint created.");
    playSound(player, "random.orb");
  });
}

function openWaypointOptions(player, wp, index) {
  const createdAgo = getTimeAgo(wp.created || 0);
  const ui = new ActionFormData();
  ui.title(wp.name);
  ui.body(`Coordinates: X${wp.pos.x.toFixed(1)} Y${wp.pos.y.toFixed(1)} Z${wp.pos.z.toFixed(1)}\nDimension: ${coloredDimension(wp.dim)}\nCreated: ${createdAgo}`);
  ui.button("Teleport", "textures/items/ender_pearl");
  ui.button("Edit Name", "textures/items/book_writable");
  ui.button("Delete", "textures/ui/icon_trash");
  ui.button("Return");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    if (selection === 0) startCountdown(player, () => teleportToPlayerWaypoint(player, wp), null, `Teleporting to ${wp.name}...`);
    else if (selection === 1) openRenameWaypoint(player, index);
    else if (selection === 2) openDeleteWaypoint(player, index);
    else openWaypointsMenu(player);
  });
}

function openRenameWaypoint(player, index) {
  const wps = getWaypointsOfPlayer(player.name);
  const wp = wps[index];
  if (!wp) {
    openWaypointsMenu(player);
    return;
  }
  const ui = new ModalFormData();
  ui.title(`Rename ${wp.name}`);
  addTextField(ui, "Enter new name", "Name", wp.name);
  ui.submitButton("Save");
  ui.show(player).then(({ canceled, formValues }) => {
    if (canceled) return openWaypointsMenu(player);
    const nName = formValues[0].trim();
    if (!nName) {
      playSound(player, "note.bass");
      openWaypointsMenu(player, "Name cannot be empty.");
      return;
    }
    wp.name = nName;
    wps[index] = wp;
    saveWaypointsOfPlayer(player.name, wps);
    player.sendMessage("Waypoint renamed.");
    playSound(player, "random.orb");
    openWaypointsMenu(player);
  });
}

function openDeleteWaypoint(player, index) {
  const wps = getWaypointsOfPlayer(player.name);
  const wp = wps[index];
  if (!wp) {
    openWaypointsMenu(player);
    return;
  }
  const ui = new MessageFormData()
    .title(`Delete ${wp.name}`)
    .body("Do you want to delete this waypoint?")
    .button1("Yes")
    .button2("No");
  ui.show(player).then(({ selection }) => {
    if (selection === 0) {
      wps.splice(index, 1);
      saveWaypointsOfPlayer(player.name, wps);
      player.sendMessage("Waypoint deleted.");
      playSound(player, "random.glass");
      openWaypointsMenu(player);
    } else {
      openWaypointsMenu(player);
    }
  });
}

function teleportToPlayerWaypoint(player, wp) {
  playTpParticles(player);
  const dim = world.getDimension(wp.dim);
  if (!dim) {
    player.sendMessage("Invalid dimension.");
    playSound(player, "note.bass");
    return;
  }
  player.teleport(wp.pos, { dimension: dim, rotation: wp.rot });
  player.sendMessage(`Teleported to ${wp.name}`);
}

function openLocationHistory(player) {
  const cfg = settings;
  if (!cfg.locationHistoryEnabled && !player.hasTag(ADMIN_TAG)) {
    playSound(player, "note.bass");
    player.sendMessage("§cThis feature was disabled by an admin.");
    return;
  }
  const raw = player.getDynamicProperty("locationHistory") || "[]";
  let arr;
  try { arr = JSON.parse(raw); } catch { arr = []; }
  if (!arr.length) {
    openMainMenu(player, "No Location History found.");
    return;
  }
  const ui = new ActionFormData();
  ui.title("Location History");
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    const ago = getTimeAgo(e.t);
    ui.button(`§0${ago}§r - ${coloredDimension(e.dim)}`, "textures/ui/icon_map");
  }
  ui.button("Return");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled) return;
    if (selection === arr.length) {
      openMainMenu(player);
      return;
    }
    const entry = arr[arr.length - 1 - selection];
    openLocationHistoryConfirm(player, entry);
  });
}

function openLocationHistoryConfirm(player, entry) {
  const ago = getTimeAgo(entry.t);
  const ui = new MessageFormData()
    .title("Confirm Teleport")
    .body(`Teleport to:\nDimension: ${coloredDimension(entry.dim)}\nCoordinates: X${entry.x.toFixed(2)} Y${entry.y.toFixed(2)} Z${entry.z.toFixed(2)}\nRecorded: ${ago}\nProceed?`)
    .button1("Yes")
    .button2("No");
  ui.show(player).then(({ canceled, selection }) => {
    if (canceled || selection === 1) {
      openLocationHistory(player);
      return;
    }
    startCountdown(player, () => teleportHistory(player, entry), null, "Teleporting...");
  });
}

function teleportHistory(player, entry) {
  playTpParticles(player);
  const dim = world.getDimension(entry.dim);
  if (!dim) {
    player.sendMessage("Invalid dimension.");
    playSound(player, "note.bass");
    return;
  }
  player.teleport({ x: entry.x, y: entry.y, z: entry.z }, { dimension: dim });
  player.sendMessage("Teleported to selected location.");
}

function openSettings(player) {
  if (!player.hasTag(ADMIN_TAG)) return;
  const cfg = settings;
  const ui = new ModalFormData();
  ui.title("Settings");
  addTextField(ui, "Blacklist Tag\n§6(Players with this tag cannot use the TP Menu)", "Default: tpiBlocked", cfg.blacklistTag);
  addToggle(ui, "Movement Countdown\n§6(For teleport requests)", cfg.tprTpaCountdown);
  addToggle(ui, "Respawnpoint Marker\n§6(Shows personal respawnpoint in Marker menu)", cfg.respawnpointMarker);
  addTextField(ui, "Respawnpoint Marker Icon\n§6(Icon used in the marker menu)", "textures/items/bed_red", cfg.respawnpointIcon);
  addSlider(ui, "Movement Countdown (Secs)\n§6(Time required not to move)", 0, 30, 1, cfg.movementCountdown);
  addSlider(ui, "Max Waypoints/Player\n§6(How many personal waypoints can each player create)", 2, 100, 1, cfg.maxWaypoints);
  addToggle(ui, "Enable Location History\n§6(Stores the last 100 locations)", cfg.locationHistoryEnabled);
  addToggle(ui, "Enable Waypoints\n§6(Allow players to create personal waypoints)", cfg.waypointsEnabled);
  addToggle(ui, "Enable Info Button\n§6(Toggle visibility of the Info button)", cfg.infoButtonEnabled);
  addToggle(ui, "Auto-Give TP Menu\n§6(Automatically give players the TP Menu if they don't have one)", cfg.autoGiveTpMenu);
  addToggle(ui, "Enable Deathpoint\n§6(Players can teleport to their deathpoint)", cfg.deathpointEnabled);
  addSlider(ui, "Deathpoint Cooldown (Minutes)\n§6(Time until next deathpoint can be saved)", 0, 60, 1, cfg.deathpointCooldown);
  ui.submitButton("Save");
  ui.show(player).then(({ canceled, formValues }) => {
    if (canceled) {
      openAdminMenu(player);
      return;
    }
    const bl = formValues[0].trim();
    const icon = formValues[3].trim();
    settings = {
      blacklistTag: bl === "" || bl === ADMIN_TAG ? "tpiBlocked" : bl,
      tprTpaCountdown: formValues[1],
      respawnpointMarker: formValues[2],
      respawnpointIcon: icon === "" ? "textures/items/bed_red" : icon,
      movementCountdown: formValues[4],
      maxWaypoints: formValues[5],
      locationHistoryEnabled: formValues[6],
      waypointsEnabled: formValues[7],
      infoButtonEnabled: formValues[8],
      autoGiveTpMenu: formValues[9],
      deathpointEnabled: formValues[10],
      deathpointCooldown: formValues[11],
    };
    world.setDynamicProperty("packSettings", JSON.stringify(settings));
    player.sendMessage("Settings saved.");
    playSound(player, "random.orb");
    openAdminMenu(player);
  });
}

function autoGiveTpMenuCheck(player) {
  const inv = player.getComponent("minecraft:inventory").container;
  let found = false;
  for (let i = 0; i < inv.size; i++) {
    const slot = inv.getItem(i);
    if (slot && slot.typeId === "tpi:tp_menu") {
      found = true;
      break;
    }
  }
  if (!found) {
    debug(player, "no tpi:tp_menu in inventory, giving one");
    giveTpMenu(player);
    openTpItemWelcomeMenu(player);
  }
}

function giveTpMenu(player) {
  try {
    player.runCommand(
      `give @s tpi:tp_menu 1 0 {"minecraft:keep_on_death":{},"minecraft:item_lock":{"mode":"lock_in_inventory"}}`
    );
  } catch (e) {
    debug(player, "§cgive command failed: " + e);
    try {
      const item = new ItemStack("tpi:tp_menu", 1);
      item.keepOnDeath = true;
      item.lockMode = ItemLockMode.inventory;
      player.getComponent("minecraft:inventory").container.addItem(item);
    } catch (e2) {
      debug(player, "§cItemStack give failed: " + e2 + " (is tpi:tp_menu defined in the pack's items folder?)");
    }
  }
}

function startCountdown(player, callback, data, text) {
  const t = settings.movementCountdown;
  if (player.hasTag(ADMIN_TAG) || t < 1) {
    callback(data);
    return;
  }
  if (player.hasTag(COUNTDOWN_TAG)) return;
  player.sendMessage(`${text}\n§eDon't move for ${t} seconds`);
  player.addTag(COUNTDOWN_TAG);
  playSound(player, "random.orb");
  const id = player.id;
  const runId = system.runTimeout(() => {
    if (!countdowns.has(id)) return;
    countdowns.delete(id);
    try {
      const stillWaiting = player.hasTag(COUNTDOWN_TAG);
      player.removeTag(COUNTDOWN_TAG);
      if (stillWaiting) callback(data);
    } catch { }
  }, t * 20);
  const loc = player.location;
  countdowns.set(id, { location: { x: loc.x, y: loc.y, z: loc.z }, dimId: player.dimension.id, runId });
}

function playTpParticles(p) {
  p.runCommand("particle minecraft:knockback_roar_particle ~~1~");
  playSound(p, "random.pop");
}

function playSound(p, s) {
  try {
    p.runCommand(`playsound ${s} @s`);
  } catch { }
}

function coloredDimension(d) {
  if (d === "minecraft:overworld") return "§aOverworld§r";
  if (d === "minecraft:nether") return "§cNether§r";
  if (d === "minecraft:the_end") return "§5The End§r";
  return "§7Unknown§r";
}

function getTimeAgo(ts) {
  if (!ts) return "unknown";
  const now = Date.now();
  if (ts > now) return "unknown";
  const diff = now - ts;
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const w = Math.floor(d / 7);
  if (w > 0) return `${w}w ago`;
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return `${s}s ago`;
}

function getGlobalWaypoints() {
  const raw = world.getDynamicProperty("globalWaypoints");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveGlobalWaypoints(obj) {
  world.setDynamicProperty("globalWaypoints", JSON.stringify(obj));
}

function getWaypointsOfPlayer(name) {
  const gwp = getGlobalWaypoints();
  if (!gwp[name]) gwp[name] = [];
  return gwp[name];
}

function saveWaypointsOfPlayer(name, arr) {
  const gwp = getGlobalWaypoints();
  gwp[name] = arr;
  saveGlobalWaypoints(gwp);
}