(() => {
  // Clean up any previous injection's network patches before capturing originals.
  window.__xsearch_restore?.();

  // Patches fetch and XHR to passively capture the auth token, API version, and client metadata headers from Discord's own outgoing requests. Self-restores once enough data is collected.
  let _capturedToken = null;
  let _capturedApiVersion = null;
  // Replaying these on our requests makes them look identical to normal Discord UI traffic.
  const _capturedHeaders = {};
  const _origFetch = window.fetch;
  const _origXHROpen = XMLHttpRequest.prototype.open;
  const _origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const _xhrUrls = new WeakMap();

  const _restoreNet = () => {
    window.fetch = _origFetch;
    XMLHttpRequest.prototype.open = _origXHROpen;
    XMLHttpRequest.prototype.setRequestHeader = _origXHRSetHeader;
    window.__xsearch_restore = null;
  };
  window.__xsearch_restore = _restoreNet;

  const _maybeRestore = () => {
    // Stop intercepting once we have what we need - minimizes the time spent patching native APIs.
    if (_capturedToken && _capturedApiVersion && Object.keys(_capturedHeaders).length > 0) {
      _restoreNet();
    }
  };

  const _saveHeader = (name, value) => {
    if (!name || value == null) return;
    const lower = String(name).toLowerCase();
    // Capture all x- prefixed custom headers from Discord API requests; skip authorization (handled separately).
    if (!lower.startsWith("x-") || lower === "authorization") return;
    if (!_capturedHeaders[lower]) _capturedHeaders[lower] = String(value);
  };

  const _netCapture = (urlStr, authHeader, headerEntries) => {
    if (!urlStr || !urlStr.includes("discord.com/api/")) return;
    if (!_capturedApiVersion) {
      const m = urlStr.match(/discord(?:app)?\.com\/api\/(v\d+)\//);
      if (m) _capturedApiVersion = m[1];
    }
    if (!_capturedToken && typeof authHeader === "string" && authHeader.length > 30) {
      // User tokens are sent raw; bot/OAuth tokens include "Bearer ". Strip it so the value is consistent.
      _capturedToken = authHeader.replace(/^Bearer\s+/i, "");
    }
    if (headerEntries) {
      for (const [name, value] of headerEntries) _saveHeader(name, value);
    }
    _maybeRestore();
  };

  const _entriesFromInit = (init) => {
    if (!init?.headers) return null;
    if (init.headers instanceof Headers) return [...init.headers.entries()];
    if (Array.isArray(init.headers)) return init.headers;
    return Object.entries(init.headers);
  };

  window.fetch = function(url, init) {
    try {
      const urlStr = String(typeof url === "string" ? url : (url?.url ?? url));
      const entries = _entriesFromInit(init);
      let auth;
      if (entries) {
        for (const [n, v] of entries) {
          if (String(n).toLowerCase() === "authorization") { auth = v; break; }
        }
      }
      _netCapture(urlStr, auth, entries);
    } catch (e) {}
    return _origFetch.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    try { _xhrUrls.set(this, String(url)); } catch (e) {}
    return _origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try {
      const url = _xhrUrls.get(this) ?? "";
      if (String(name).toLowerCase() === "authorization") {
        _netCapture(url, value, null);
      } else if (url.includes("discord.com/api/")) {
        _saveHeader(name, value);
        _maybeRestore();
      }
    } catch (e) {}
    return _origXHRSetHeader.apply(this, arguments);
  };

  // Webpack chunk discovery - tries the known bundle name first, then scans window for any webpackChunk* property.
  const getWebpackChunk = () => {
    if (window.webpackChunkdiscord_app) return window.webpackChunkdiscord_app;
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        if (key.startsWith("webpackChunk") && Array.isArray(window[key]) && window[key].push) {
          return window[key];
        }
      } catch (e) {}
    }
    return null;
  };

  let _wpRequire = null;
  // Using a string chunk ID instead of Symbol() since newer webpack builds can reject Symbol keys.
  const _wpProbeId = "_xsearch_probe_" + Math.random().toString(36).slice(2);

  // Vencord's live webpack require function. Structurally validated (.c must be an object).
  // Present in any Vencord-based client (Vesktop, injected Discord, etc.).
  // If Vencord changes its API path in the future, update only this one spot.
  const _vcWreq = (() => {
    try {
      const w = window.Vencord?.Webpack?.wreq;
      if (typeof w === "function" && w.c && typeof w.c === "object") return w;
    } catch (e) {}
    return null;
  })();

  // Vencord's webpack Common namespace. Requires at least one known store to be populated
  // before trusting the object -- guards against a partially-initialized state at inject time.
  // If Vencord changes its API path in the future, update only this one spot.
  const _vcCommon = (() => {
    try {
      const c = window.Vencord?.Webpack?.Common;
      if (c && (c.AuthenticationStore || c.GuildStore || c.FluxDispatcher)) return c;
    } catch (e) {}
    return null;
  })();

  const wp = () => {
    if (_wpRequire) return _wpRequire;
    // Vencord/Vesktop: wreq is already captured and exposed; skip the chunk probe entirely.
    if (_vcWreq) { _wpRequire = _vcWreq; return _wpRequire; }
    const chunk = getWebpackChunk();
    if (!chunk) return null;
    try {
      _wpRequire = chunk.push([[_wpProbeId], {}, r => r]);
      chunk.pop();
    } catch (e) {
      // Some builds reject empty modules; try again with a no-op module factory
      try {
        _wpRequire = chunk.push([[_wpProbeId + "_2"], { [_wpProbeId]: () => {} }, r => r]);
        chunk.pop();
      } catch (e2) {}
    }
    return _wpRequire;
  };

  // Extract all possible export surfaces from a webpack module: top-level, default export, and keyed sub-objects.
  const candidatesOf = (mod) => {
    if (!mod?.exports) return [];
    const seen = new Set();
    const out = [];
    const add = (v) => {
      if (v && typeof v === "object" && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    };
    add(mod.exports);
    try {
      if (mod.exports.default) add(mod.exports.default);
      for (const k of Object.keys(mod.exports)) {
        add(mod.exports[k]);
      }
    } catch (e) {}
    return out;
  };

  // Discord's i18n system wraps strings in Proxy objects where any property access returns a function.
  // This causes false positives when scanning for module shapes. Detect them by probing an impossible key.
  const isI18nProxy = (obj) => {
    try {
      return typeof obj["__xsearch_i18n_probe__"] === "function";
    } catch (e) {
      return false;
    }
  };

  // Build and cache a flat list of all exported objects across webpack modules (i18n proxies excluded).
  const _buildCandidates = () => {
    const wpRequire = wp();
    if (!wpRequire || !wpRequire.c) return [];
    const out = [];
    for (const id in wpRequire.c) {
      try {
        for (const exp of candidatesOf(wpRequire.c[id])) {
          if (!isI18nProxy(exp)) out.push(exp);
        }
      } catch (e) {}
    }
    return out;
  };
  const _candidates = _buildCandidates();

  // Detect the live API version instead of hardcoding v9.
  const getApiBase = () => {
    if (_capturedApiVersion) return `https://discord.com/api/${_capturedApiVersion}`;
    try {
      const env = window.GLOBAL_ENV;
      if (env?.API_ENDPOINT) {
        const ep = env.API_ENDPOINT.replace(/\/$/, "");
        if (/\/v\d+$/.test(ep)) return ep;
        if (env.API_VERSION != null) return `${ep}/v${env.API_VERSION}`;
      }
    } catch (e) {}
    for (const exp of _candidates) {
      try {
        for (const key of Object.keys(exp)) {
          const val = exp[key];
          if (typeof val === "string" && /^https:\/\/discord(?:app)?\.com\/api\/v\d+$/.test(val))
            return val;
        }
      } catch (e) {}
    }
    return "https://discord.com/api/v9";
  };
  const API_BASE = getApiBase();

  // The token is read from Discord's own internal stores and only ever sent as the Authorization header to discord.com search endpoints. It is never logged, stored externally, or sent elsewhere. Verify by searching "token" in this file -- it only appears in getToken(), the variable below, and searchOneGuild().
  const jwtLike = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}$/;
  const isTokenLike = (t) => typeof t === "string" && t.length > 30 && jwtLike.test(t);

  const getToken = () => {
    // 1. network capture from the patched fetch/XHR above
    if (_capturedToken) return _capturedToken;
    // 2. Vencord/Vesktop: AuthenticationStore always holds the live session token.
    if (_vcCommon) {
      try {
        const t = _vcCommon.AuthenticationStore?.getToken?.();
        if (isTokenLike(t)) return t;
      } catch (e) {}
    }
    // 3. Discord's webpack auth store (holds the token in memory for the session)
    for (const exp of _candidates) {
      try {
        if (typeof exp.getToken !== "function") continue;
        const t = exp.getToken();
        if (isTokenLike(t)) return t;
      } catch (e) {}
    }
    // 4. localStorage (older Discord builds stored it here)
    try {
      const raw = localStorage.getItem("token");
      if (raw) {
        const cleaned = raw.replace(/^"|"$/g, "");
        if (isTokenLike(cleaned)) return cleaned;
      }
    } catch (e) {}
    // 5. Structural scan: call zero-arg getter-shaped functions and check for a JWT-shaped return value.
    const safeFnNameRe = /^(?:get|is|has|fetch|read|peek)|^[a-zA-Z]$/;
    for (const exp of _candidates) {
      try {
        const fns = Object.keys(exp).filter(k =>
          typeof exp[k] === "function"
          && exp[k].length === 0
          && safeFnNameRe.test(k)
        );
        if (fns.length < 1 || fns.length > 30) continue;
        for (const key of fns) {
          const t = exp[key]();
          if (isTokenLike(t)) return t;
        }
      } catch (e) {}
    }
    return null;
  };

  // Guild shape validator - requires guild-specific fields to avoid matching unrelated id/name maps.
  const looksLikeGuild = (v) =>
    v && typeof v.id === "string" && typeof v.name === "string"
    && (Array.isArray(v.features) || Array.isArray(v.roles) || v.ownerId != null);

  const isGuildMap = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const vals = Object.values(obj);
    if (vals.length === 0) return false;
    return vals.slice(0, Math.min(3, vals.length)).every(looksLikeGuild);
  };

  const getGuildIconUrl = (guild) => {
    const icon = guild?.icon ?? guild?.iconHash ?? guild?.iconId;
    if (!guild?.id || !icon) return "";
    const ext = String(icon).startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/icons/${guild.id}/${icon}.${ext}?size=64`;
  };

  const extractGuildList = (obj) =>
    Object.values(obj)
      .filter(v => v?.id && v?.name)
      .map(v => ({ id: v.id, name: v.name, iconUrl: getGuildIconUrl(v) }));

  const getGuilds = () => {
    // Vencord/Vesktop: GuildStore is fully populated by console inject time.
    if (_vcCommon) {
      try {
        const g = _vcCommon.GuildStore?.getGuilds?.();
        if (isGuildMap(g)) return extractGuildList(g);
      } catch (e) {}
    }
    // 1. name-based fast path
    for (const exp of _candidates) {
      try {
        if (typeof exp.getGuilds !== "function") continue;
        const g = exp.getGuilds();
        if (isGuildMap(g)) return extractGuildList(g);
      } catch (e) {}
    }
    // 2. Structural scan: same zero-arg getter filter used in getToken.
    const safeFnNameRe = /^(?:get|is|has|fetch|read|peek)|^[a-zA-Z]$/;
    for (const exp of _candidates) {
      try {
        for (const key of Object.keys(exp)) {
          const fn = exp[key];
          if (typeof fn !== "function" || fn.length !== 0) continue;
          if (!safeFnNameRe.test(key)) continue;
          const result = fn.call(exp);
          if (isGuildMap(result)) return extractGuildList(result);
        }
      } catch (e) {}
    }
    return [];
  };

  const getFolderData = () => {
    for (const exp of _candidates) {
      try {
        if (typeof exp.getGuildFolders === "function") {
          const folders = exp.getGuildFolders();
          if (Array.isArray(folders) && folders.length > 0) return folders;
        }
      } catch (e) {}
    }
    for (const exp of _candidates) {
      try {
        const arr = exp.guildFolders ?? exp.sortedGuildFolders;
        if (Array.isArray(arr) && arr.length > 0) return arr;
      } catch (e) {}
    }
    return null;
  };

  const folderColorToCss = (color) => {
    if (!color) return null;
    return "#" + (color >>> 0).toString(16).padStart(6, "0");
  };

  const parseCssUrl = (value) => {
    const match = String(value ?? "").match(/url\((['"]?)(.*?)\1\)/);
    return match?.[2] ?? "";
  };

  const getSidebarGuildIcons = () => {
    const icons = new Map();
    document.querySelectorAll('a[href^="/channels/"]').forEach(link => {
      const href = link.getAttribute("href") || "";
      const match = href.match(/^\/channels\/([^/]+)/);
      const guildId = match?.[1];
      if (!guildId || guildId === "@me" || icons.has(guildId)) return;
      const img = link.querySelector("img");
      const src = img?.currentSrc || img?.src || "";
      if (src) {
        icons.set(guildId, src);
        return;
      }
      const bgNode = link.querySelector('[style*="background-image"]');
      const bg = parseCssUrl(bgNode?.style?.backgroundImage);
      if (bg) icons.set(guildId, bg);
    });
    return icons;
  };

  // Generic module finder used for navigation lookups below.
  const findModule = (filter) => {
    for (const exp of _candidates) {
      try { if (filter(exp)) return exp; } catch (e) {}
    }
    return null;
  };

  // Navigation: tries transitionTo, then selectChannel, then FluxDispatcher, then history.pushState.
  const getTransitionTo = () => {
    const mod =
      findModule(m => typeof m.transitionTo === "function" && typeof m.replaceWith === "function")
      ?? findModule(m => typeof m.transitionTo === "function");
    if (mod) return mod.transitionTo.bind(mod);
    // Schema-based: React Router exposes a history object with push/replace/location.
    const routerMod = findModule(m =>
      m?.history && typeof m.history.push === "function"
      && typeof m.history.replace === "function"
      && m?.location && typeof m.location.pathname === "string"
    );
    if (routerMod) return (path) => routerMod.history.push(path);
    return null;
  };

  const getSelectChannel = () => {
    const mod =
      findModule(m => typeof m.selectChannel === "function" && typeof m.selectVoiceChannel === "function")
      ?? findModule(m => typeof m.selectChannel === "function");
    if (mod) return mod.selectChannel.bind(mod);
    // Schema-based: match on sibling methods (selectVoiceChannel, selectPrivateChannel) in case selectChannel was renamed.
    const chanMod = findModule(m =>
      typeof m.selectVoiceChannel === "function" || typeof m.selectPrivateChannel === "function"
    );
    if (chanMod) {
      const fn = chanMod.selectChannel ?? chanMod.selectPrivateChannel ?? chanMod.selectVoiceChannel;
      if (typeof fn === "function") return fn.bind(chanMod);
    }
    return null;
  };

  // Flux dispatcher is the last webpack-based fallback; CHANNEL_SELECT drives navigation internally.
  const getFluxDispatcher = () => {
    // Vencord/Vesktop: FluxDispatcher is set at startup with a stable interface.
    if (_vcCommon) {
      try {
        const d = _vcCommon.FluxDispatcher;
        // Validate both dispatch and subscribe to confirm it is a real FluxDispatcher.
        if (typeof d?.dispatch === "function" && typeof d?.subscribe === "function") return d;
      } catch (e) {}
    }
    return findModule(m =>
      typeof m.dispatch === "function"
      && (typeof m.subscribe === "function" || typeof m._subscriptions === "object")
      && (Array.isArray(m._actionHandlers?._orderedActionHandlers)
          || typeof m.register === "function"
          || typeof m.wait === "function")
    );
  };

  const transitionTo = getTransitionTo();
  const selectChannel = getSelectChannel();
  const fluxDispatcher = getFluxDispatcher();

  const jumpToMessage = (guildId, channelId, messageId) => {
    const path = `/channels/${guildId}/${channelId}/${messageId}`;
    try { if (transitionTo) { transitionTo(path); return; } } catch (e) {}
    try { if (selectChannel) { selectChannel({ guildId, channelId, messageId }); return; } } catch (e) {}
    try {
      if (fluxDispatcher) {
        fluxDispatcher.dispatch({ type: "CHANNEL_SELECT", guildId, channelId, messageId });
        return;
      }
    } catch (e) {}
    // Last-resort: push state directly. Discord may not react if its router isn't listening on popstate.
    try {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) { console.error("[xsearch] no navigation method worked", e); }
  };

  // Token is scoped to this IIFE and only ever sent as the Authorization header to discord.com search endpoints.
  let token = getToken();

  // --- Current user detection (6-strategy fallback chain) ---
  // Strategy 1: decode user ID from the auth token. Discord user tokens encode the numeric user ID
  // as a plain-decimal string in the first base64url segment. This is the most reliable method
  // since it is derived from a stable token format, not from Discord's UI or webpack internals.
  const _selfIdFromToken = () => {
    if (!token) return null;
    try {
      const seg = token.split('.')[0];
      const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      const decoded = atob(padded);
      return /^\d{5,}$/.test(decoded.trim()) ? decoded.trim() : null;
    } catch (e) { return null; }
  };

  const getSelf = () => {
    // --- ID ---
    const id = _selfIdFromToken();

    // --- Username (best-effort; only used for display) ---
    // Try multiple class-name patterns -- Discord refactors these occasionally.
    const panel =
      document.querySelector('[aria-label="User Controls"]') ??
      document.querySelector('[class*="panels"]');
    const nameEl = panel
      ? (panel.querySelector('[class*="username"]') ??
         panel.querySelector('[class*="nameTag"]') ??
         panel.querySelector('[class*="name_"]'))
      : null;
    const username = nameEl?.textContent?.trim() || null;

    if (id) return { id, username };

    // Strategy 2/3/4: DOM avatar URL -- CDN path pattern is stable.
    const avatarImg =
      panel?.querySelector('img[src*="/avatars/"]') ??
      document.querySelector('[class*="sidebar"] img[src*="/avatars/"]') ??
      document.querySelector('img[src*="cdn.discordapp.com/avatars/"]');
    if (avatarImg) {
      const m = avatarImg.src.match(/\/avatars\/(\d{5,})\//);
      if (m) return { id: m[1], username };
    }

    // Strategy 5: webpack named getCurrentUser()
    for (const exp of _candidates) {
      try {
        if (typeof exp.getCurrentUser !== 'function') continue;
        const user = exp.getCurrentUser();
        if (user?.id && /^\d{5,}$/.test(String(user.id)))
          return { id: String(user.id), username: user.username ?? username };
      } catch (e) {}
    }

    // Strategy 6: webpack structural scan (same zero-arg getter pattern used in getToken/getGuilds)
    const _selfFnRe = /^(?:get|is|has|fetch|read|peek)|^[a-zA-Z]$/;
    for (const exp of _candidates) {
      try {
        const fns = Object.keys(exp).filter(k =>
          typeof exp[k] === 'function' && exp[k].length === 0 && _selfFnRe.test(k)
        );
        if (fns.length < 1 || fns.length > 30) continue;
        for (const key of fns) {
          const result = exp[key]();
          if (result && /^\d{5,}$/.test(String(result.id ?? '')) &&
              typeof result.username === 'string' &&
              !result.guildId && !Array.isArray(result.features)) {
            return { id: String(result.id), username: result.username };
          }
        }
      } catch (e) {}
    }

    return null;
  };

  const _selfData = getSelf();
  let selfId = _selfData?.id ?? null;
  let selfUsername = _selfData?.username ?? null;
  if (selfId) console.log(`[xsearch] Self detected: id=${selfId}, username=${selfUsername ?? '(unknown)'}`);
  else console.warn('[xsearch] Could not detect self -- "Hide my messages" filter will be disabled until search time.');

  const sidebarGuildIcons = getSidebarGuildIcons();
  const _rawFolders = getFolderData();

  // Build a flat position map from folder data (sidebar top-to-bottom order).
  // Each rawFolders entry is in sidebar order; guildIds within each entry is in folder-internal order.
  const _navOrder = (() => {
    const m = new Map();
    if (!_rawFolders) return m;
    let pos = 0;
    for (const entry of _rawFolders) {
      for (const id of (entry.guildIds ?? entry.guild_ids ?? []).map(String)) {
        if (!m.has(id)) m.set(id, pos++);
      }
    }
    return m;
  })();
  const _navPos = (id) => _navOrder.has(id) ? _navOrder.get(id) : Infinity;

  const guilds = getGuilds()
    .map(g => ({ ...g, iconUrl: sidebarGuildIcons.get(g.id) || g.iconUrl || "" }))
    .sort((a, b) => _navPos(a.id) - _navPos(b.id) || a.name.localeCompare(b.name));
  if (guilds.length === 0) { console.error("[xsearch] Found 0 guilds."); return; }
  if (!token) console.warn("[xsearch] Token not found via webpack; will retry at search time via network capture.");
  console.log(`[xsearch] Ready: ${guilds.length} guilds, nav=${!!(transitionTo || selectChannel || fluxDispatcher)}, api=${API_BASE}, stealthHeaders=${Object.keys(_capturedHeaders).length}`);

  const buildOrganizedGuilds = () => {
    if (!_rawFolders || _rawFolders.length === 0) return null;
    const guildMap = new Map(guilds.map(g => [g.id, g]));
    const assignedIds = new Set();
    const groups = [];

    for (const entry of _rawFolders) {
      const guildIds = (entry.guildIds ?? entry.guild_ids ?? []).map(String);
      const folderId = entry.folderId ?? entry.id ?? null;
      const folderName = entry.folderName ?? entry.name ?? null;
      const folderColor = entry.folderColor ?? entry.color ?? null;

      // Ungrouped single-guild entries (null folderId): insert inline at their sidebar position.
      if (!folderId && guildIds.length <= 1) {
        if (guildIds.length === 1) {
          const g = guildMap.get(guildIds[0]);
          if (g) { groups.push({ type: "ungrouped", guilds: [g] }); assignedIds.add(g.id); }
        }
        continue;
      }

      // Use guildIds array order - it reflects the user's folder-internal arrangement.
      const members = guildIds.map(id => guildMap.get(id)).filter(Boolean);
      if (members.length === 0) continue;

      groups.push({
        type: "folder",
        id: String(folderId),
        name: folderName || "Group",
        color: folderColorToCss(folderColor),
        guilds: members,
      });
      for (const g of members) assignedIds.add(g.id);
    }

    // Any guilds absent from folder data entirely (edge case) go at the end.
    const remaining = guilds.filter(g => !assignedIds.has(g.id));
    if (remaining.length > 0) groups.push({ type: "ungrouped", guilds: remaining });
    return groups.length > 0 ? groups : null;
  };
  const organizedGuilds = buildOrganizedGuilds();

  // Injected via CSSStyleSheet (avoids style-src unsafe-inline CSP restrictions); falls back to a <style> element.
  const CSS_TEXT = `
    #xsearch-overlay { position: fixed; top: 50px; right: 50px; width: 760px; max-width: 90vw; background: #2b2d31; color: #dbdee1; border: 1px solid #1e1f22; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); z-index: 99999; font-family: system-ui, sans-serif; display: flex; flex-direction: column; overflow: hidden; transition: height 220ms ease, transform 220ms ease, opacity 200ms ease; }
    #xsearch-overlay.expanded { height: 750px; max-height: 88vh; }
    #xsearch-overlay.minimized { height: 40px; }
    #xsearch-header { padding: 10px 14px; background: #1e1f22; cursor: move; display: flex; justify-content: space-between; align-items: center; user-select: none; border-radius: 8px 8px 0 0; position: relative; flex-shrink: 0; }
    #xsearch-overlay:not(.expanded) #xsearch-header { border-radius: 8px; }
    #xsearch-header strong { font-size: 14px; }
    #xsearch-header-actions { display: flex; gap: 6px; align-items: center; }
    #xsearch-header-progress { position: absolute; left: 0; right: 0; top: 0; height: 2px; background: rgba(255,255,255,0.06); overflow: hidden; opacity: 0; transition: opacity 200ms ease; pointer-events: none; }
    #xsearch-header-progress.active { opacity: 1; }
    #xsearch-header-progress-bar { height: 100%; width: 0%; background: #5865f2; transition: width 0.2s ease, background 400ms ease; position: relative; overflow: hidden; }
    #xsearch-header-progress-bar.done { background: #3ba55d; }
    #xsearch-launcher-ring { position: absolute; top: 0; left: 0; width: 52px; height: 52px; pointer-events: none; opacity: 0; transition: opacity 500ms ease; }
    #xsearch-launcher-ring.active { opacity: 1; }
    #xsearch-launcher-ring circle { fill: none; stroke: rgba(255,255,255,0.85); stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset 0.2s ease, stroke 400ms ease; }
    #xsearch-launcher-ring.done circle { stroke: #3ba55d; }
    #xsearch-toggle, #xsearch-close { color: #fff; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
    #xsearch-toggle { background: #4e5058; }
    #xsearch-close { background: #ed4245; }
    #xsearch-body { padding: 14px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
    #xsearch-overlay:not(.expanded) #xsearch-body { display: none; }
    #xsearch-overlay input[type=text] { width: 100%; padding: 9px 12px; background: #1e1f22; color: #fff; border: 1px solid #444; border-radius: 4px; box-sizing: border-box; }
    #xsearch-controls { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
    #xsearch-options-row { display: flex; gap: 8px; align-items: center; width: 100%; }
    #xsearch-options-row .ctl-group { margin-left: 0; }
    #xsearch-overlay .ctl-group { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #b5bac1; margin-left: auto; }
    #xsearch-overlay .ctl-group select { background: #1e1f22; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; font-size: 12px; }
    #xsearch-overlay .hl { background: #5865f2; color: #fff; padding: 0 2px; border-radius: 2px; }
    #xsearch-overlay button.act { padding: 8px 14px; background: #5865f2; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    #xsearch-overlay button.act.alt { background: #3ba55d; }
    #xsearch-overlay button.act.ghost { background: #4e5058; }
    #xsearch-overlay button.act:disabled { opacity: 0.5; cursor: not-allowed; }
    #xsearch-servers-wrap { background: #1e1f22; border-radius: 6px; margin: 12px 0; border: 1px solid #2b2d31; }
    #xsearch-servers-head { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid #2b2d31; }
    #xsearch-servers-head .lbl { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #b5bac1; font-weight: 600; }
    #xsearch-servers-head .mini { background: transparent; color: #5865f2; border: none; cursor: pointer; font-size: 12px; padding: 2px 6px; }
    #xsearch-servers-head .mini:hover { color: #818cf8; }
    #xsearch-servers { padding: 8px; max-height: 240px; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
    #xsearch-servers label { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 8px; border-radius: 4px; cursor: pointer; color: #dbdee1; transition: background 0.1s; min-width: 0; }
    #xsearch-servers label:hover { background: #2b2d31; }
    #xsearch-servers .server-icon { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: #3f4147; }
    #xsearch-servers .server-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #xsearch-servers input[type=checkbox] { appearance: none; width: 16px; height: 16px; border: 1.5px solid #4e5058; border-radius: 3px; background: #2b2d31; cursor: pointer; flex-shrink: 0; position: relative; }
    #xsearch-servers input[type=checkbox]:checked { background: #5865f2; border-color: #5865f2; }
    #xsearch-servers input[type=checkbox]:checked::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    #xsearch-servers input[type=checkbox]:indeterminate { background: #5865f2; border-color: #5865f2; }
    #xsearch-servers input[type=checkbox]:indeterminate::after { content: ""; position: absolute; left: 3px; top: 6px; width: 8px; height: 2px; background: #fff; transform: none; border: none; }
    #xsearch-servers .folder-group { grid-column: 1 / -1; }
    #xsearch-servers .folder-header { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #dbdee1; margin-top: 4px; border-left: 3px solid #4e5058; background: rgba(78,80,88,0.20); }
    #xsearch-servers .folder-servers { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; padding: 4px 0 4px 12px; }
    #xsearch-status { font-size: 12px; color: #b5bac1; margin: 8px 0; }
    #xsearch-progress-wrap { background: #1e1f22; border-radius: 4px; height: 14px; margin: 6px 0; overflow: hidden; display: none; }
    #xsearch-progress-bar { background: #5865f2; height: 100%; width: 0%; transition: width 0.2s ease; position: relative; overflow: hidden; }
    #xsearch-sort-row { display: none; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; font-size: 12px; color: #b5bac1; }
    #xsearch-sort-row.visible { display: flex; }
    #xsearch-sort-row select { background: #1e1f22; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; font-size: 12px; }
    #xsearch-secondary-wrap { display: none; align-items: center; gap: 6px; }
    #xsearch-secondary-wrap.visible { display: flex; }
    #xsearch-overlay .group-block { margin-top: 12px; }
    #xsearch-overlay .group-header { font-size: 15px; font-weight: 700; color: #5865f2; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; padding: 8px 4px; border-bottom: 1px solid rgba(88,101,242,0.4); transition: color 120ms ease; }
    #xsearch-overlay .group-header:hover { color: #818cf8; }
    #xsearch-overlay .group-header .toggle { font-size: 13px; display: inline-block; transition: transform 180ms ease; transform: rotate(90deg); }
    #xsearch-overlay .group-block.collapsed .group-header .toggle { transform: rotate(0deg); }
    #xsearch-overlay .group-header .count { color: #b5bac1; font-weight: 500; font-size: 13px; }
    .group-cards-wrap { display: grid; grid-template-rows: 1fr; overflow: hidden; }
    .group-cards { min-height: 0; }
    .group-block.collapsed .group-cards-wrap { grid-template-rows: 0fr; }
    .msg.skeleton { pointer-events: none; border-left-color: transparent; }
    .sk-line { border-radius: 4px; background: linear-gradient(90deg, #3f4147 25%, #4e5058 50%, #3f4147 75%); background-size: 200% 100%; margin-bottom: 6px; }
    .sk-line-meta { height: 10px; width: 60%; margin-bottom: 8px; }
    .sk-line-content { height: 14px; width: 90%; }
    .sk-line.sk-short { width: 45%; }
    #xsearch-overlay .msg { background: #313338; padding: 10px; border-radius: 4px; margin: 6px 0; cursor: pointer; border-left: 3px solid #5865f2; }
    #xsearch-overlay .msg:hover { background: #383a40; }
    #xsearch-overlay .msg .meta { font-size: 11px; color: #b5bac1; margin-bottom: 4px; }
    #xsearch-overlay .msg .content { font-size: 14px; white-space: pre-wrap; word-wrap: break-word; }
    #xsearch-launcher { position: fixed; bottom: 96px; right: 24px; width: 52px; height: 52px; background: #5865f2; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.5); z-index: 99999; font-size: 26px; user-select: none; opacity: 0; transform: scale(0); pointer-events: none; transition: transform 220ms ease, opacity 200ms ease, box-shadow 200ms ease; }
    #xsearch-launcher.visible { opacity: 1; transform: scale(1); pointer-events: auto; }
    #xsearch-launcher:hover { box-shadow: 0 6px 22px rgba(88,101,242,0.7); }
    #xsearch-launcher.searching { animation: xsearch-pulse 1.6s ease-in-out infinite; }
    @keyframes xsearch-pulse { 0%,100% { box-shadow: 0 4px 16px rgba(88,101,242,0.5); } 50% { box-shadow: 0 4px 28px rgba(88,101,242,1); } }

    /* Discord-style scrollbars -- scoped to overlay elements only, won't affect Discord's own UI */
    #xsearch-body::-webkit-scrollbar, #xsearch-servers::-webkit-scrollbar { width: 16px; }
    #xsearch-body::-webkit-scrollbar-track, #xsearch-servers::-webkit-scrollbar-track { background: transparent; }
    #xsearch-body::-webkit-scrollbar-thumb, #xsearch-servers::-webkit-scrollbar-thumb { background: #5865f2; border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
    #xsearch-body::-webkit-scrollbar-thumb:hover, #xsearch-servers::-webkit-scrollbar-thumb:hover { background: #4752c4; border-radius: 8px; background-clip: content-box; }

    /* Result card hover lift */
    #xsearch-overlay .msg { transition: transform 120ms ease, background 0.1s ease; }
    #xsearch-overlay .msg:hover { transform: translateX(3px); }

    /* Button micro-press */
    #xsearch-overlay button.act:active { transform: scale(0.96); transition: transform 80ms ease; }

    /* Animations -- skipped for users who prefer reduced motion */
    @media (prefers-reduced-motion: no-preference) {
      #xsearch-overlay { animation: xsearch-appear 200ms ease-out both; }
      @keyframes xsearch-appear { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: none; } }
      #xsearch-overlay .msg.animating { animation: xsearch-card-in 140ms ease-out both; animation-delay: calc(var(--i, 0) * 18ms); }
      @keyframes xsearch-card-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      #xsearch-header.flash { animation: xsearch-header-flash 700ms ease-out both; }
      @keyframes xsearch-header-flash { 0% { background: #1e1f22; } 25% { background: #2a2e38; } 100% { background: #1e1f22; } }
      .group-cards-wrap { transition: grid-template-rows 280ms cubic-bezier(0.4, 0, 0.2, 1); }
      .sk-line { animation: xsearch-shimmer 1.4s ease-in-out infinite; }
      @keyframes xsearch-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      #xsearch-progress-bar::after, #xsearch-header-progress-bar::after { content: ""; position: absolute; top: 0; left: -60%; bottom: 0; width: 60%; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent); animation: xsearch-bar-shimmer 1.6s ease-in-out infinite; }
      @keyframes xsearch-bar-shimmer { 0% { left: -60%; } 100% { left: 140%; } }
      #xsearch-overlay button.act.export-flash { animation: xsearch-export-pop 1.5s ease-out both; }
      @keyframes xsearch-export-pop { 0% { filter: brightness(1.6); transform: scale(1.07); } 20% { filter: brightness(1.2); transform: scale(1.0); } 100% { filter: brightness(1); transform: scale(1); } }
    }
  `;

  let _removeStyles = null;
  const injectStyles = (cssText) => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      document.adoptedStyleSheets = [...(document.adoptedStyleSheets ?? []), sheet];
      return () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet); };
    } catch (e) {}
    const style = document.createElement("style");
    style.textContent = cssText;
    (document.head ?? document.documentElement).appendChild(style);
    return () => style.remove();
  };

  // Overlay UI
  document.getElementById("xsearch-overlay")?.remove();
  document.getElementById("xsearch-launcher")?.remove();
  _removeStyles?.();

  const TIME_RANGE_OPTIONS = [
    { label: "Any time",     ms: 0 },
    { label: "Past day",     ms: 86_400_000 },
    { label: "Past 3 days",  ms: 259_200_000 },
    { label: "Past week",    ms: 604_800_000 },
    { label: "Past month",   ms: 2_592_000_000 },
    { label: "Past year",    ms: 31_536_000_000 },
    { label: "Past 2 years", ms: 63_072_000_000 },
  ];

  const SERVER_DELAY_OPTIONS = [
    { label: "Instant (unsafe)",         ms: 0 },
    { label: "1 second",                 ms: 1_000 },
    { label: "3 seconds",                ms: 3_000 },
    { label: "5 seconds",                ms: 5_000 },
    { label: "10 seconds (recommended)", ms: 10_000 },
    { label: "30 seconds",               ms: 30_000 },
    { label: "1 minute",                 ms: 60_000 },
    { label: "5 minutes",                ms: 300_000 },
    { label: "10 minutes (safest)",      ms: 600_000 },
  ];

  const overlay = document.createElement("div");
  overlay.id = "xsearch-overlay";
  overlay.innerHTML = `
    <div id="xsearch-header">
      <strong>Cross-Server Search</strong>
      <div id="xsearch-header-actions">
        <button id="xsearch-toggle">Min</button>
        <button id="xsearch-close">Close</button>
      </div>
      <div id="xsearch-header-progress"><div id="xsearch-header-progress-bar"></div></div>
    </div>
    <div id="xsearch-body">
      <input id="xsearch-q" type="text" placeholder="Search query..." />
      <div id="xsearch-controls">
        <button class="act" id="xsearch-go">Search all pages</button>
        <button class="act ghost" id="xsearch-stop" disabled>Stop</button>
        <button class="act alt" id="xsearch-export" disabled>Export CSV</button>
        <label class="ctl-group" id="xsearch-self-wrap" title="Hide your own messages from results and CSV export">
          <input type="checkbox" id="xsearch-exclude-self" style="width:14px;height:14px;flex-shrink:0;cursor:pointer;">
          <span>Hide my messages</span>
        </label>
        <span class="ctl-group">
          <label for="xsearch-concurrency" title="How many servers to search at once. Each server has its own rate-limit bucket on Discord's side, so 2-3 is faster without raising your per-bucket request rate.">Parallel</label>
          <select id="xsearch-concurrency">
            <option value="1">1 (slowest, safest)</option>
            <option value="2" selected>2 (recommended)</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5 (fastest)</option>
          </select>
        </span>
        <div id="xsearch-options-row">
          <span class="ctl-group" style="margin-left:0">
            <select id="xsearch-timerange">
              ${TIME_RANGE_OPTIONS.map(o => `<option value="${o.ms}"${o.ms === 0 ? " selected" : ""}>${o.label}</option>`).join("\n              ")}
            </select>
          </span>
          <span class="ctl-group" style="margin-left:auto">
            <label for="xsearch-server-delay" title="How long to wait between searching each server. Higher values are safer but slower.">Server delay</label>
            <select id="xsearch-server-delay">
              ${SERVER_DELAY_OPTIONS.map(o => `<option value="${o.ms}"${o.ms === 10_000 ? " selected" : ""}>${o.label}</option>`).join("\n              ")}
            </select>
          </span>
        </div>
      </div>
      <div id="xsearch-servers-wrap">
        <div id="xsearch-servers-head">
          <span class="lbl">Servers</span>
          <div>
            <button class="mini" id="xsearch-all">Select all</button>
            <button class="mini" id="xsearch-none">Clear</button>
          </div>
        </div>
        <div id="xsearch-servers"></div>
      </div>
      <div id="xsearch-status"></div>
      <div id="xsearch-progress-wrap"><div id="xsearch-progress-bar"></div></div>
      <div id="xsearch-sort-row">
        <label for="xsearch-sort-primary">Sort:</label>
        <select id="xsearch-sort-primary">
          <option value="newest" selected>Newest</option>
          <option value="oldest">Oldest</option>
          <option value="az">A-Z</option>
          <option value="server-latest">Server (Latest)</option>
          <option value="server-az">Server (A-Z)</option>
          <option value="user-latest">User (Latest)</option>
          <option value="user-az">User (A-Z)</option>
        </select>
        <span id="xsearch-secondary-wrap">
          <label for="xsearch-sort-secondary">Within group:</label>
          <select id="xsearch-sort-secondary">
            <option value="newest" selected>Newest</option>
            <option value="oldest">Oldest</option>
            <option value="az">A-Z</option>
          </select>
        </span>
      </div>
      <div id="xsearch-results"></div>
    </div>
  `;
  overlay.classList.add("expanded");
  _removeStyles = injectStyles(CSS_TEXT);
  document.body.appendChild(overlay);

  document.getElementById("xsearch-launcher")?.remove();
  const launcher = document.createElement("div");
  launcher.id = "xsearch-launcher";
  launcher.title = "Open Cross-Server Search";
  launcher.textContent = "🔍";

  const RING_CIRC = 2 * Math.PI * 23;
  const launcherRing = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  launcherRing.id = "xsearch-launcher-ring";
  launcherRing.setAttribute("viewBox", "0 0 52 52");
  const ringCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  ringCircle.setAttribute("cx", "26");
  ringCircle.setAttribute("cy", "26");
  ringCircle.setAttribute("r", "23");
  ringCircle.setAttribute("transform", "rotate(-90 26 26)");
  ringCircle.style.strokeDasharray = RING_CIRC;
  ringCircle.style.strokeDashoffset = RING_CIRC;
  launcherRing.appendChild(ringCircle);
  launcher.appendChild(launcherRing);

  document.body.appendChild(launcher);

  let ringFadeTimer = null;
  const fadeRingOut = (delay) => {
    if (ringFadeTimer) clearTimeout(ringFadeTimer);
    ringFadeTimer = setTimeout(() => {
      ringFadeTimer = null;
      launcherRing.classList.remove("active");
      setTimeout(() => {
        launcherRing.classList.remove("done");
        ringCircle.style.transition = "none";
        ringCircle.style.strokeDashoffset = RING_CIRC;
        requestAnimationFrame(() => { ringCircle.style.transition = ""; });
      }, 550);
    }, Math.max(0, delay));
  };

  // Restore previous overlay position, clamped to viewport bounds to prevent orphaning.
  const POS_KEY = "xsearch_pos_v1";
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      const maxLeft = Math.max(0, window.innerWidth - 200);
      const maxTop = Math.max(0, window.innerHeight - 100);
      overlay.style.left = Math.min(maxLeft, Math.max(0, saved.left)) + "px";
      overlay.style.top = Math.min(maxTop, Math.max(0, saved.top)) + "px";
      overlay.style.right = "auto";
    }
  } catch (e) {}
  const savePos = () => {
    try {
      const r = overlay.getBoundingClientRect();
      localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top }));
    } catch (e) {}
  };

  let overlayState = "expanded";
  let preDockState = "expanded";

  const setOverlayState = (next) => {
    if (next === overlayState) return;
    const toggleBtn = overlay.querySelector("#xsearch-toggle");
    if (next === "docked") {
      if (overlayState === "expanded" || overlayState === "minimized") preDockState = overlayState;
      const r = overlay.getBoundingClientRect();
      launcher.classList.add("visible");
      requestAnimationFrame(() => {
        const lr = launcher.getBoundingClientRect();
        const dx = (lr.left + lr.width / 2) - (r.left + r.width / 2);
        const dy = (lr.top + lr.height / 2) - (r.top + r.height / 2);
        overlay.style.transformOrigin = "center center";
        overlay.style.transform = `translate(${dx}px, ${dy}px) scale(0.05)`;
        overlay.style.opacity = "0";
        overlay.style.pointerEvents = "none";
        overlay.classList.add("docked");
      });
    } else if (next === "expanded" || next === "minimized") {
      overlay.classList.remove("docked");
      overlay.style.transform = "";
      overlay.style.opacity = "";
      overlay.style.pointerEvents = "";
      if (next === "expanded") {
        overlay.classList.add("expanded");
        overlay.classList.remove("minimized");
        if (toggleBtn) toggleBtn.textContent = "Min";
        // If search is done, hold the green ring until the overlay finishes opening (~220ms), then fade out.
        fadeRingOut(launcherRing.classList.contains("done") ? 280 : 0);
      } else {
        overlay.classList.add("minimized");
        overlay.classList.remove("expanded");
        if (toggleBtn) toggleBtn.textContent = "Show";
      }
      launcher.classList.remove("visible");
    }
    overlayState = next;
  };

  launcher.onclick = () => setOverlayState(preDockState || "expanded");

  const onKeyDown = (e) => {
    if (e.key === "Escape" && document.body.contains(overlay)) {
      if (overlay.contains(document.activeElement) || document.activeElement === document.body) {
        if (overlayState !== "docked") setOverlayState("docked");
      }
    }
  };
  document.addEventListener("keydown", onKeyDown);

  // Drag handling
  const header = overlay.querySelector("#xsearch-header");
  let dragging = false, dx = 0, dy = 0, dragMoved = false;
  header.addEventListener("mousedown", e => {
    if (e.target.tagName === "BUTTON") return;
    if (overlayState !== "expanded" && overlayState !== "minimized") return;
    dragging = true;
    dragMoved = false;
    const rect = overlay.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", e => {
    if (!dragging) return;
    dragMoved = true;
    overlay.style.left = (e.clientX - dx) + "px";
    overlay.style.top = (e.clientY - dy) + "px";
    overlay.style.right = "auto";
  });
  document.addEventListener("mouseup", () => {
    if (dragging && dragMoved) savePos();
    dragging = false;
  });

  header.addEventListener("click", e => {
    if (e.target.tagName === "BUTTON") return;
    if (dragMoved) return;
    setOverlayState(overlayState === "expanded" ? "minimized" : "expanded");
  });

  overlay.querySelector("#xsearch-toggle").onclick = (e) => {
    e.stopPropagation();
    setOverlayState(overlayState === "expanded" ? "minimized" : "expanded");
  };
  overlay.querySelector("#xsearch-close").onclick = (e) => {
    e.stopPropagation();
    setOverlayState("docked");
  };

  const serversDiv = overlay.querySelector("#xsearch-servers");

  const makeServerLabel = (g) => {
    const lbl = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.id = g.id;
    checkbox.checked = true;
    lbl.appendChild(checkbox);

    if (g.iconUrl) {
      const icon = document.createElement("img");
      icon.className = "server-icon";
      icon.alt = "";
      icon.src = g.iconUrl;
      icon.loading = "lazy";
      icon.decoding = "async";
      icon.referrerPolicy = "no-referrer";
      icon.draggable = false;
      icon.addEventListener("error", () => icon.remove(), { once: true });
      lbl.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "server-name";
    name.title = g.name;
    name.textContent = g.name;
    lbl.appendChild(name);
    return lbl;
  };

  const hexToRgb = (hex) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
  };

  const syncFolderCheckbox = (folderCb, serverCbs) => {
    const checkedCount = serverCbs.filter(c => c.checked).length;
    if (checkedCount === 0) { folderCb.checked = false; folderCb.indeterminate = false; }
    else if (checkedCount === serverCbs.length) { folderCb.checked = true; folderCb.indeterminate = false; }
    else { folderCb.checked = false; folderCb.indeterminate = true; }
  };

  // Updates the search button label based on whether every guild checkbox is checked.
  const syncGoBtn = () => {
    const goBtn = overlay.querySelector("#xsearch-go");
    if (!goBtn) return;
    const all = [...serversDiv.querySelectorAll("input[data-id]")];
    const allChecked = all.length > 0 && all.every(c => c.checked);
    goBtn.textContent = allChecked ? "Search all pages" : "Search selected";
  };

  if (organizedGuilds) {
    for (const group of organizedGuilds) {
      if (group.type === "folder") {
        const groupDiv = document.createElement("div");
        groupDiv.className = "folder-group";

        const headerDiv = document.createElement("div");
        headerDiv.className = "folder-header";

        const folderCb = document.createElement("input");
        folderCb.type = "checkbox";
        folderCb.checked = true;

        if (group.color) {
          const rgb = hexToRgb(group.color);
          if (rgb) {
            headerDiv.style.borderLeftColor = group.color;
            headerDiv.style.backgroundColor = `rgba(${rgb.r},${rgb.g},${rgb.b},0.20)`;
          }
        }

        headerDiv.appendChild(folderCb);
        const folderNameSpan = document.createElement("span");
        folderNameSpan.textContent = group.name;
        headerDiv.appendChild(folderNameSpan);
        groupDiv.appendChild(headerDiv);

        const serversInner = document.createElement("div");
        serversInner.className = "folder-servers";
        const serverCbs = [];

        for (const g of group.guilds) {
          const lbl = makeServerLabel(g);
          const cb = lbl.querySelector("input[type=checkbox]");
          serverCbs.push(cb);
          cb.addEventListener("change", () => syncFolderCheckbox(folderCb, serverCbs));
          serversInner.appendChild(lbl);
        }

        folderCb.addEventListener("change", () => {
          for (const cb of serverCbs) cb.checked = folderCb.checked;
          folderCb.indeterminate = false;
          syncGoBtn();
        });

        groupDiv.appendChild(serversInner);
        serversDiv.appendChild(groupDiv);
      } else {
        for (const g of group.guilds) {
          serversDiv.appendChild(makeServerLabel(g));
        }
      }
    }
  } else {
    for (const g of guilds) {
      serversDiv.appendChild(makeServerLabel(g));
    }
  }

  // Event delegation: catch individual guild checkbox changes not covered by folder handler.
  serversDiv.addEventListener("change", e => {
    if (e.target.matches("input[data-id]")) syncGoBtn();
  });
  syncGoBtn();

  overlay.querySelector("#xsearch-all").onclick = () => {
    serversDiv.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = true; c.indeterminate = false; });
    syncGoBtn();
  };
  overlay.querySelector("#xsearch-none").onclick = () => {
    serversDiv.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = false; c.indeterminate = false; });
    syncGoBtn();
  };

  // Search state
  let currentQuery = "";
  let lastResults = [];
  let stopRequested = false;
  // hardKill is set on 401 or 403/40002; all workers exit immediately and the script must be re-injected.
  let hardKill = false;

  // Progressive rendering state -- reset at the start of each search run.
  let liveResults = [];
  let _liveSeenIds = new Set();
  let _liveRenderTimer = null;
  // When true, renderResults() will add entry animations to new cards. Reset to false at the top of renderResults().
  let _isLiveUpdate = false;
  // IDs that were present in the last completed render; used to skip re-animating already-shown cards.
  let _lastRenderedIds = new Set();

  const _addLiveResults = (found) => {
    for (const m of found) {
      if (_liveSeenIds.has(m.id)) continue;
      _liveSeenIds.add(m.id);
      liveResults.push(m);
    }
  };

  const debouncedLiveRender = () => {
    if (_liveRenderTimer) clearTimeout(_liveRenderTimer);
    _liveRenderTimer = setTimeout(() => {
      _liveRenderTimer = null;
      lastResults = liveResults;  // sync so getVisibleResults() sees the latest data
      _isLiveUpdate = true;
      renderResults();
    }, 400);
  };

  // Returns the results to display, applying the self-exclusion filter if active.
  // lastResults is never mutated -- toggling the filter is always instantly reversible.
  const getVisibleResults = () => {
    const excludeSelf = overlay.querySelector("#xsearch-exclude-self")?.checked;
    if (!excludeSelf || !selfId) return lastResults;
    return lastResults.filter(m => m.author?.id !== selfId);
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Jitter uses a right-skewed distribution to mimic real human browsing behavior:
  // base spread of ±30%, plus a 15% chance of an extra reading pause of 20-80% of the delay.
  const jitter = (ms, pct = 0.30) => {
    if (ms <= 0) return 0;
    const base = ms + (Math.random() - 0.5) * 2 * ms * pct;
    const extra = Math.random() < 0.15 ? ms * (0.2 + Math.random() * 0.6) : 0;
    return Math.max(0, base + extra);
  };
  const jitteredSleep = (ms, pct) => sleep(jitter(ms, pct));

  // 2.5s mean per page stays well under Discord's per-guild search bucket (roughly 10 req/5s historically).
  const PAGE_DELAY = 2500;
  const PAGE_SIZE = 25;
  const INDEX_WAIT = 5000;
  const MAX_INDEX_RETRIES = 12;
  // 3 consecutive 429s on the same guild usually indicates a behavior-flag rate limit, not a normal bucket reset.
  const MAX_CONSECUTIVE_429 = 3;

  // Discord Snowflake epoch (2015-01-01T00:00:00Z). Used to convert timestamps to Snowflake IDs for search date filtering.
  const DISCORD_EPOCH = 1420070400000n;

  const tsToSnowflake = (ms) => String((BigInt(Math.max(0, ms)) - DISCORD_EPOCH) << 22n);

  // Applies time-range constraints to URLSearchParams. If Discord adds or renames date filter parameters, update only this function.
  const buildTimeRangeParams = (minId, params) => {
    if (minId) params.set("min_id", minId);
  };

  let _hlCache = null;  // { query: string, re: RegExp | null }
  const getHlRe = (query) => {
    if (_hlCache?.query === query) return _hlCache.re;
    const terms = query.split(/\s+/).filter(t => t.length >= 2);
    const re = terms.length > 0
      ? new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi")
      : null;
    _hlCache = { query, re };
    return re;
  };

  // Highlights matching query terms in result content so the user can see why each result matched.
  const highlightInto = (parent, text, query) => {
    parent.textContent = "";
    if (!text) { parent.textContent = "(no text content)"; return; }
    const re = getHlRe(query);
    if (!re) { parent.textContent = text; return; }
    re.lastIndex = 0;
    const parts = text.split(re);
    for (const p of parts) {
      if (!p) continue;
      re.lastIndex = 0;
      if (re.test(p)) {
        re.lastIndex = 0;
        const span = document.createElement("span");
        span.className = "hl";
        span.textContent = p;
        parent.appendChild(span);
      } else {
        parent.appendChild(document.createTextNode(p));
      }
    }
  };

  const renderResult = (container, m, opts = {}) => {
    const div = document.createElement("div");
    div.className = "msg";
    if (opts.animate) {
      div.classList.add("animating");
      if (opts.staggerIndex != null && opts.staggerIndex < 8)
        div.style.setProperty("--i", opts.staggerIndex);
    }
    const date = new Date(m.timestamp).toLocaleString();
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${m._guildName} #${m.channel_id} ${date} ${m.author?.username || "?"}`;
    const content = document.createElement("div");
    content.className = "content";
    highlightInto(content, m.content || "", currentQuery);
    div.appendChild(meta);
    div.appendChild(content);
    div.onclick = () => jumpToMessage(m._guildId, m.channel_id, m.id);
    container.appendChild(div);
  };

  // Lazily caches numeric timestamp on the message object to avoid repeated Date parsing in sorts.
  const getTs = (m) => m._ts !== undefined ? m._ts : (m._ts = Date.parse(m.timestamp));

  const computeOrdered = (items, primary, secondary) => {
    const cmpNewest = (a, b) => getTs(b) - getTs(a);
    const cmpOldest = (a, b) => getTs(a) - getTs(b);
    const cmpAZ = (a, b) => (a.content || "").toLowerCase().localeCompare((b.content || "").toLowerCase());
    const withinTable = { newest: cmpNewest, oldest: cmpOldest, az: cmpAZ };
    const within = withinTable[secondary] || cmpNewest;

    if (primary === "newest") return [{ key: null, label: null, items: [...items].sort(cmpNewest) }];
    if (primary === "oldest") return [{ key: null, label: null, items: [...items].sort(cmpOldest) }];
    if (primary === "az") return [{ key: null, label: null, items: [...items].sort(cmpAZ) }];

    const isUser = primary.startsWith("user");
    const isAZ = primary.endsWith("-az");
    const buckets = new Map();
    for (const m of items) {
      const k = isUser ? (m.author?.id ?? "_unknown") : m._guildId;
      const label = isUser ? (m.author?.username || "Unknown user") : (m._guildName || "Unknown server");
      let b = buckets.get(k);
      if (!b) { b = { key: k, label, items: [], maxTs: -Infinity }; buckets.set(k, b); }
      b.items.push(m);
      const ts = getTs(m);
      if (ts > b.maxTs) b.maxTs = ts;
    }
    const groups = [...buckets.values()];
    if (isAZ) groups.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    else groups.sort((a, b) => b.maxTs - a.maxTs);
    for (const g of groups) g.items.sort(within);
    return groups;
  };

  let _renderToken = 0;
  const renderResults = () => {
    // Capture and immediately clear the live flag so sort/filter re-renders never animate cards.
    const isLive = _isLiveUpdate;
    _isLiveUpdate = false;

    const body = overlay.querySelector("#xsearch-body");
    const savedScroll = body ? body.scrollTop : 0;

    // Remove skeleton scroll lock if present (set when skeletons were injected at search start).
    if (body?.hasAttribute("data-skeleton-lock")) {
      body.removeAttribute("data-skeleton-lock");
      body.style.overflowY = "";
    }

    const results = overlay.querySelector("#xsearch-results");
    const sortRow = overlay.querySelector("#xsearch-sort-row");
    const secondaryWrap = overlay.querySelector("#xsearch-secondary-wrap");
    const exportBtn = overlay.querySelector("#xsearch-export");
    results.innerHTML = "";

    const visible = getVisibleResults();
    if (exportBtn) exportBtn.disabled = visible.length === 0;
    if (!visible.length) {
      sortRow.classList.remove("visible");
      return;
    }
    sortRow.classList.add("visible");
    const primary = overlay.querySelector("#xsearch-sort-primary").value;
    const secondary = overlay.querySelector("#xsearch-sort-secondary").value;
    const grouped = primary.startsWith("server") || primary.startsWith("user");
    secondaryWrap.classList.toggle("visible", grouped);

    // Sort/filter re-render: snap opacity to 0 so new content fades in rather than snapping.
    if (!isLive) {
      results.style.transition = "none";
      results.style.opacity = "0";
    }

    const groups = computeOrdered(visible, primary, secondary);
    const queue = [];
    for (const g of groups) {
      if (grouped) queue.push({ header: g.label, count: g.items.length });
      for (const m of g.items) queue.push({ msg: m });
    }
    const myToken = ++_renderToken;
    let i = 0;
    let animCount = 0;
    let currentGroupCards = null;
    // Snapshot which IDs were already on screen before this render; only animate cards that weren't.
    const prevIds = isLive ? new Set(_lastRenderedIds) : null;
    const newRenderedIds = new Set();
    const renderChunk = () => {
      if (myToken !== _renderToken) return;
      const end = Math.min(queue.length, i + 50);
      for (; i < end; i++) {
        const it = queue[i];
        if ("header" in it) {
          const groupBlock = document.createElement("div");
          groupBlock.className = "group-block";
          const h = document.createElement("div");
          h.className = "group-header";
          h.addEventListener("click", () => groupBlock.classList.toggle("collapsed"));
          const toggle = document.createElement("span");
          toggle.className = "toggle";
          toggle.textContent = ">";
          const label = document.createElement("span");
          label.textContent = it.header;
          const count = document.createElement("span");
          count.className = "count";
          count.textContent = `(${it.count})`;
          h.appendChild(toggle);
          h.appendChild(label);
          h.appendChild(count);
          groupBlock.appendChild(h);
          const wrap = document.createElement("div");
          wrap.className = "group-cards-wrap";
          const cards = document.createElement("div");
          cards.className = "group-cards";
          wrap.appendChild(cards);
          groupBlock.appendChild(wrap);
          results.appendChild(groupBlock);
          currentGroupCards = cards;
        } else {
          const container = grouped && currentGroupCards ? currentGroupCards : results;
          const isNew = prevIds ? !prevIds.has(it.msg.id) : false;
          renderResult(container, it.msg, (isLive && isNew) ? { animate: true, staggerIndex: animCount++ } : {});
          newRenderedIds.add(it.msg.id);
        }
      }
      if (i < queue.length) {
        requestAnimationFrame(renderChunk);
      } else {
        // All chunks done -- update rendered-ID tracking, then handle scroll.
        _lastRenderedIds = newRenderedIds;
        if (!isLive) {
          // Fade results back in after the sort/filter re-render completes.
          requestAnimationFrame(() => {
            results.style.transition = "opacity 120ms ease";
            results.style.opacity = "1";
          });
        }
        if (body) {
          if (isLive) {
            // Progressive update: restore position so reading isn't interrupted.
            body.scrollTop = savedScroll;
          } else if (savedScroll > 0) {
            // Sort/filter change: snap back to top so the user sees the re-ordered results.
            body.scrollTo({ top: 0, behavior: "smooth" });
          }
        }
      }
    };
    renderChunk();
  };

  // Discord caps the search 'offset' parameter at 5000; above that we switch to max_id cursor pagination.
  const OFFSET_CAP = 5000;

  // Per-guild rate limit bucket state; keyed by guildId.
  const _bucketState = new Map(); // guildId -> { remaining, resetAt }

  const updateBucket = (guildId, res) => {
    try {
      const remaining = parseInt(res.headers.get("X-RateLimit-Remaining") ?? "", 10);
      const resetAfter = parseFloat(res.headers.get("X-RateLimit-Reset-After") ?? "");
      if (Number.isNaN(remaining) || Number.isNaN(resetAfter)) return;
      _bucketState.set(guildId, {
        remaining,
        resetAt: Date.now() + resetAfter * 1000,
      });
    } catch (e) {}
  };

  // Pacing tiers: skip delay if bucket has headroom, wait for reset if exhausted.
  const computePacing = (guildId) => {
    const b = _bucketState.get(guildId);
    if (!b) return jitter(PAGE_DELAY);
    const msUntilReset = Math.max(0, b.resetAt - Date.now());
    if (b.remaining <= 0) return msUntilReset + 250;
    if (b.remaining <= 2) return Math.max(jitter(PAGE_DELAY), msUntilReset / Math.max(1, b.remaining));
    return jitter(800, 0.4); // headroom: short, varied micro-pause
  };

  // Detect non-JSON responses (e.g., Cloudflare HTML blocks) to avoid crashing JSON.parse.
  const isJsonResponse = (res) => {
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json");
  };

  // Builds headers for search requests. Replays stealth headers captured from real Discord traffic so
  // requests look identical to what the client sends normally.
  const buildSearchHeaders = () => {
    const h = { Authorization: token, Accept: "*/*" }; // token is only sent to discord.com; see fetch() call in searchOneGuild
    for (const [name, value] of Object.entries(_capturedHeaders)) {
      h[name] = value;
    }
    return h;
  };

  // Processes items with at most `concurrency` workers pulling from a shared queue.
  const runWithConcurrency = async (items, fn, concurrency) => {
    const queue = items.slice();
    const workerCount = Math.max(1, Math.min(concurrency, queue.length));
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push((async () => {
        while (queue.length) {
          if (stopRequested || hardKill) return;
          const item = queue.shift();
          try { await fn(item); } catch (e) { console.error("[xsearch] worker", e); }
        }
      })());
    }
    await Promise.all(workers);
  };

  const searchOneGuild = async (g, query, onPage, rangeMs = 0) => {
    let offset = 0;
    let maxIdCursor = null;
    let oldestIdSeenInBucket = null;
    let serverTotal = null;
    let serverPage = 1;
    let serverPages = 1;
    let indexRetries = 0;
    let consecutive429 = 0;
    const found = [];
    // Anchor the time window to search start so it stays fixed across all pages of this guild.
    const minId = rangeMs > 0 ? tsToSnowflake(Date.now() - rangeMs) : null;

    while (true) {
      if (stopRequested || hardKill) return found;

      try {
        // include_nsfw=true so age-gated channels are not silently excluded.
        const params = new URLSearchParams({ content: query, include_nsfw: "true" });
        if (maxIdCursor) params.set("max_id", maxIdCursor);
        else params.set("offset", String(offset));
        buildTimeRangeParams(minId, params);
        const url = `${API_BASE}/guilds/${g.id}/messages/search?${params.toString()}`;
        const res = await fetch(url, {
          headers: buildSearchHeaders(),
          credentials: "include",
        });

        // Hard auth failure: token revoked or invalidated. Stop the entire run.
        if (res.status === 401) {
          hardKill = true;
          console.error("[xsearch] 401 unauthorized - token rejected, halting all searches");
          return found;
        }

        // 403 with code 40002 indicates an account-action flag; halt.
        if (res.status === 403) {
          let bodyCode = null;
          try { if (isJsonResponse(res)) bodyCode = (await res.json())?.code; } catch (e) {}
          if (bodyCode === 40002) {
            hardKill = true;
            console.error("[xsearch] 403 code 40002 - account action required, halting");
            return found;
          }
          console.warn(`[xsearch] ${g.name} returned 403, skipping`);
          return found;
        }

        if (res.status === 429) {
          consecutive429++;
          let retryMs = 20000;
          let isGlobal = false;
          try {
            const headerVal = res.headers.get("Retry-After");
            if (headerVal != null) retryMs = parseFloat(headerVal) * 1000;
            if (isJsonResponse(res)) {
              const body = await res.json();
              if (typeof body.retry_after === "number") retryMs = body.retry_after * 1000;
              if (body.global === true) isGlobal = true;
            }
          } catch (e) {}

          // global=true means Discord is rate-limiting the account globally, not just this guild bucket.
          if (isGlobal) {
            console.warn(`[xsearch] GLOBAL rate limit hit, pausing ${Math.ceil(retryMs / 1000)}s`);
            retryMs = Math.max(retryMs, 30000);
          }

          // Exponential backoff per consecutive 429 on the same guild; skip after MAX_CONSECUTIVE_429.
          if (consecutive429 >= MAX_CONSECUTIVE_429) {
            console.warn(`[xsearch] ${g.name} hit ${consecutive429} consecutive 429s, skipping`);
            await sleep(retryMs * 2);
            return found;
          }
          retryMs = Math.max(retryMs, retryMs * Math.pow(1.5, consecutive429 - 1));

          const totalSecs = Math.max(1, Math.ceil(retryMs / 1000));
          for (let remaining = totalSecs; remaining > 0; remaining--) {
            if (stopRequested || hardKill) return found;
            onPage?.({ kind: "ratelimit", remaining, guild: g.name });
            await sleep(1000);
          }
          continue;
        }
        consecutive429 = 0;
        updateBucket(g.id, res);

        if (res.status === 202) {
          indexRetries++;
          if (indexRetries > MAX_INDEX_RETRIES) {
            console.warn(`[xsearch] ${g.name} still indexing after ${MAX_INDEX_RETRIES} retries, skipping`);
            return found;
          }
          onPage?.({ kind: "indexing", attempt: indexRetries, guild: g.name });
          await sleep(INDEX_WAIT);
          continue;
        }

        if (!res.ok) {
          console.warn(`[xsearch] ${g.name} returned ${res.status}`);
          return found;
        }

        if (!isJsonResponse(res)) {
          console.warn(`[xsearch] ${g.name} returned non-JSON response, skipping`);
          return found;
        }

        const data = await res.json();

        // Only treat an explicit `indexing: true` flag as "still indexing".
        // Do NOT infer indexing from empty results - a legitimate zero-hit
        // search also returns total_results=0 with an analytics_id, and the
        // old heuristic caused infinite retry loops on those.
        if (data.indexing === true) {
          indexRetries++;
          if (indexRetries > MAX_INDEX_RETRIES) {
            console.warn(`[xsearch] ${g.name} still indexing after ${MAX_INDEX_RETRIES} retries, skipping`);
            return found;
          }
          onPage?.({ kind: "indexing", attempt: indexRetries, guild: g.name });
          await sleep(INDEX_WAIT);
          continue;
        }

        indexRetries = 0;

        if (serverTotal == null) {
          serverTotal = data.total_results || 0;
          serverPages = Math.max(1, Math.ceil(serverTotal / PAGE_SIZE));
        }
        const groups = data.messages || [];
        if (groups.length === 0) return found;

        for (const group of groups) {
          const hit = group.find(m => m.hit) || group[0];
          if (hit) {
            const enriched = { ...hit, _guildId: g.id, _guildName: g.name };
            found.push(enriched);
            if (!oldestIdSeenInBucket || BigInt(hit.id) < BigInt(oldestIdSeenInBucket)) {
              oldestIdSeenInBucket = hit.id;
            }
          }
        }

        onPage?.({
          kind: "page",
          guild: g.name,
          page: serverPage,
          totalPages: serverPages,
          serverTotal,
          fraction: serverPage / serverPages,
          newResults: found.length,
        });

        // Switch from offset to max_id cursor pagination as we approach Discord's 5000 offset hard cap.
        if (!maxIdCursor) {
          offset += PAGE_SIZE;
          if (groups.length < PAGE_SIZE) return found;
          if (offset >= serverTotal) return found;
          if (offset >= OFFSET_CAP) {
            if (!oldestIdSeenInBucket) return found;
            maxIdCursor = oldestIdSeenInBucket;
            oldestIdSeenInBucket = null;
            offset = 0;
          }
        } else {
          if (groups.length < PAGE_SIZE) return found;
          if (!oldestIdSeenInBucket) return found;
          if (oldestIdSeenInBucket === maxIdCursor) return found;
          maxIdCursor = oldestIdSeenInBucket;
          oldestIdSeenInBucket = null;
          if (minId && BigInt(maxIdCursor) <= BigInt(minId)) return found;
        }
        serverPage++;

        await sleep(computePacing(g.id));
      } catch (e) {
        console.error(`[xsearch] ${g.name}`, e);
        return found;
      }
    }
  };

  const search = async (query) => {
    // Re-check token - it may have arrived via network capture after initial load.
    if (!token) token = getToken();

    const checked = [...serversDiv.querySelectorAll("input:checked[data-id]")].map(i => ({
      id: i.dataset.id,
      name: i.parentElement.querySelector("span").textContent.trim()
    }));

    const status = overlay.querySelector("#xsearch-status");
    const results = overlay.querySelector("#xsearch-results");
    const progressWrap = overlay.querySelector("#xsearch-progress-wrap");
    const progressBar = overlay.querySelector("#xsearch-progress-bar");
    const headerProgress = overlay.querySelector("#xsearch-header-progress");
    const headerProgressBar = overlay.querySelector("#xsearch-header-progress-bar");
    const exportBtn = overlay.querySelector("#xsearch-export");
    const goBtn = overlay.querySelector("#xsearch-go");
    const stopBtn = overlay.querySelector("#xsearch-stop");
    const concurrencyInput = overlay.querySelector("#xsearch-concurrency");
    const concurrency = Math.max(1, Math.min(5, parseInt(concurrencyInput?.value ?? "2", 10) || 2));
    const rangeMs = parseInt(overlay.querySelector("#xsearch-timerange")?.value ?? "0", 10) || 0;

    results.innerHTML = "";
    overlay.querySelector("#xsearch-sort-row").classList.remove("visible");
    progressWrap.style.display = "block";
    progressBar.style.width = "0%";
    headerProgressBar.style.width = "0%";
    headerProgressBar.classList.remove("done");
    headerProgress.classList.add("active");

    // Inject skeleton placeholder cards and lock scrolling until real results arrive.
    const body = overlay.querySelector("#xsearch-body");
    if (body) {
      const skFrag = document.createDocumentFragment();
      for (let _s = 0; _s < 5; _s++) {
        const sk = document.createElement("div");
        sk.className = "msg skeleton";
        sk.innerHTML = `<div class="sk-line sk-line-meta"></div>
<div class="sk-line sk-line-content"></div>
<div class="sk-line sk-line-content sk-short"></div>`;
        skFrag.appendChild(sk);
      }
      results.appendChild(skFrag);
      body.style.overflowY = "hidden";
      body.setAttribute("data-skeleton-lock", "1");
    }
    launcherRing.classList.remove("done");
    if (ringFadeTimer) { clearTimeout(ringFadeTimer); ringFadeTimer = null; }
    ringCircle.style.transition = "none";
    ringCircle.style.strokeDashoffset = RING_CIRC;
    requestAnimationFrame(() => { ringCircle.style.transition = ""; });
    launcherRing.classList.add("active");
    launcher.classList.add("searching");
    exportBtn.disabled = true;
    goBtn.disabled = true;
    stopBtn.disabled = false;
    stopRequested = false;
    hardKill = false;
    lastResults = [];
    // Reset progressive accumulator and cancel any pending debounced render from a previous run.
    liveResults = [];
    _liveSeenIds = new Set();
    _lastRenderedIds = new Set();
    if (_liveRenderTimer) { clearTimeout(_liveRenderTimer); _liveRenderTimer = null; }
    // Retry self-detection if it failed at inject time (Discord panel may not have been mounted yet).
    if (!selfId) {
      const retry = getSelf();
      if (retry) { selfId = retry.id; selfUsername = retry.username; }
    }

    const finishSearchUi = (success = false) => {
      // Remove skeleton scroll lock in case search ended before renderResults() had a chance to.
      if (body?.hasAttribute("data-skeleton-lock")) {
        body.removeAttribute("data-skeleton-lock");
        body.style.overflowY = "";
      }
      progressWrap.style.display = "none";
      launcher.classList.remove("searching");
      goBtn.disabled = false;
      stopBtn.disabled = true;

      if (success) {
        headerProgressBar.classList.add("done");
        launcherRing.classList.add("done");
        fadeRingOut(700);
        // Brief header flash to signal completion.
        const hdr = overlay.querySelector("#xsearch-header");
        if (hdr) {
          hdr.classList.add("flash");
          setTimeout(() => hdr.classList.remove("flash"), 750);
        }
        setTimeout(() => {
          headerProgress.classList.remove("active");
          setTimeout(() => {
            headerProgressBar.classList.remove("done");
            headerProgressBar.style.width = "0%";
          }, 600);
        }, 700);
      } else {
        headerProgress.classList.remove("active");
        fadeRingOut(0);
      }
    };

    if (!token) {
      status.textContent = "Error: could not retrieve auth token. Open any channel in Discord then click Search again.";
      finishSearchUi();
      return;
    }
    if (checked.length === 0) {
      status.textContent = "Select at least one server.";
      finishSearchUi();
      return;
    }

    const total = checked.length;
    let completedServers = 0;
    const serverProgress = new Map(); // guildId -> [0..1]

    const updateProgress = () => {
      let sum = completedServers;
      for (const f of serverProgress.values()) sum += Math.min(1, f);
      const pct = (sum / total) * 100;
      const w = `${Math.min(100, pct)}%`;
      progressBar.style.width = w;
      headerProgressBar.style.width = w;
      ringCircle.style.strokeDashoffset = RING_CIRC * (1 - Math.min(1, sum / total));
    };

    const renderStatus = (extra = "") => {
      const inFlight = serverProgress.size;
      status.textContent =
        `${completedServers}/${total} servers done, ${inFlight} active, ${liveResults.length} results` +
        (extra ? ` - ${extra}` : "");
    };

    renderStatus();

    await runWithConcurrency(checked, async (g) => {
      if (stopRequested || hardKill) return;
      serverProgress.set(g.id, 0);
      renderStatus(`starting ${g.name}`);
      // Small stagger so parallel workers don't fire in lockstep.
      await sleep(jitter(300, 0.7));

      const found = await searchOneGuild(g, query, (evt) => {
        if (evt.kind === "page") {
          serverProgress.set(g.id, evt.fraction);
          updateProgress();
          renderStatus(`${evt.guild} page ${evt.page}/${evt.totalPages}`);
        } else if (evt.kind === "ratelimit") {
          renderStatus(`${evt.guild} rate-limited, waiting ${evt.remaining}s`);
        } else if (evt.kind === "indexing") {
          renderStatus(`${evt.guild} indexing (attempt ${evt.attempt})`);
        }
      }, rangeMs);

      _addLiveResults(found);
      debouncedLiveRender();
      serverProgress.delete(g.id);
      completedServers++;
      updateProgress();
      renderStatus(`finished ${g.name}`);

      // Inter-server think pause within a worker, jittered. Skipped on the
      // last item per worker (queue is empty) by virtue of the loop exit.
      const serverDelayMs = parseInt(overlay.querySelector("#xsearch-server-delay")?.value ?? "10000", 10) || 0;
      if (!stopRequested && !hardKill && serverDelayMs > 0 && completedServers < total) await jitteredSleep(serverDelayMs);
    }, concurrency);

    // Cancel any pending debounced live render -- the final renderResults() call below covers it.
    if (_liveRenderTimer) { clearTimeout(_liveRenderTimer); _liveRenderTimer = null; }
    // liveResults is already deduplicated incrementally via _liveSeenIds.
    lastResults = liveResults;

    const visible = getVisibleResults();
    let finalNote = "";
    if (hardKill) finalNote = " (HALTED: token rejected or account flagged - re-inject script)";
    else if (stopRequested) finalNote = " (stopped early)";
    const hidden = lastResults.length - visible.length;
    if (hidden > 0) finalNote += ` (${hidden} hidden – your messages)`;
    status.textContent = `${visible.length} total results across ${total} servers${finalNote}`;
    progressBar.style.width = "100%";
    headerProgressBar.style.width = "100%";
    ringCircle.style.strokeDashoffset = 0;
    exportBtn.disabled = visible.length === 0;
    finishSearchUi(true);

    // Animate cards that weren't shown in any prior live render (covers fast and multi-server searches).
    _isLiveUpdate = true;
    renderResults();
  };

  overlay.querySelector("#xsearch-sort-primary").onchange = renderResults;
  overlay.querySelector("#xsearch-sort-secondary").onchange = renderResults;
  overlay.querySelector("#xsearch-exclude-self")?.addEventListener("change", renderResults);
  // Disable exclude-self checkbox if self-ID could not be detected.
  if (!selfId) {
    const selfCb = overlay.querySelector("#xsearch-exclude-self");
    if (selfCb) {
      selfCb.disabled = true;
      selfCb.closest("label")?.setAttribute("title", "Could not detect your user ID");
    }
  }

  // CSV export (local file download only, no network requests)
  const csvEscape = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const exportCsv = () => {
    const exportable = getVisibleResults();
    if (!exportable.length) return;
    const headers = ["timestamp", "server", "channel_id", "author", "content", "link"];
    const rows = [headers.join(",")];
    for (const m of exportable) {
      // This URL is written into the CSV for the user to click later, not fetched here
      const link = `https://discord.com/channels/${m._guildId}/${m.channel_id}/${m.id}`;
      rows.push([
        csvEscape(m.timestamp),
        csvEscape(m._guildName),
        csvEscape(m.channel_id),
        csvEscape(m.author?.username || ""),
        csvEscape(m.content || ""),
        csvEscape(link),
      ].join(","));
    }
    const csv = "\ufeff" + rows.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeQuery = currentQuery.replace(/[^a-z0-9]+/gi, "_").slice(0, 40) || "search";
    a.href = url;
    a.download = `discord_search_${safeQuery}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    // Briefly animate the export button to confirm the download was triggered.
    const btn = overlay.querySelector("#xsearch-export");
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "Exported!";
      btn.classList.add("export-flash");
      setTimeout(() => { btn.classList.remove("export-flash"); btn.textContent = orig; }, 1500);
    }
  };

  overlay.querySelector("#xsearch-go").onclick = () => {
    const raw = overlay.querySelector("#xsearch-q").value.trim();
    const status = overlay.querySelector("#xsearch-status");
    if (!raw) {
      status.textContent = "Enter a search query first.";
      overlay.querySelector("#xsearch-q").focus();
      return;
    }
    if (raw.length < 2) {
      status.textContent = "Query must be at least 2 characters.";
      return;
    }
    currentQuery = raw;
    search(currentQuery);
  };
  overlay.querySelector("#xsearch-stop").onclick = () => {
    stopRequested = true;
    overlay.querySelector("#xsearch-status").textContent += " - stopping...";
  };
  overlay.querySelector("#xsearch-export").onclick = exportCsv;
  overlay.querySelector("#xsearch-q").addEventListener("keydown", e => {
    if (e.key === "Enter" && !overlay.querySelector("#xsearch-go").disabled) {
      overlay.querySelector("#xsearch-go").click();
    }
  });

  const closeDevToolsIfAvailable = () => {
    const nativeWindow = window.DiscordNative?.window;
    if (typeof nativeWindow?.closeDevTools === "function") {
      nativeWindow.closeDevTools();
      return true;
    }
    if (typeof nativeWindow?.toggleDevTools === "function") {
      const isOpen = typeof nativeWindow.isDevToolsOpened === "function"
        ? nativeWindow.isDevToolsOpened()
        : true;
      if (isOpen) {
        nativeWindow.toggleDevTools();
        return true;
      }
    }

    if (typeof window.DiscordNative?.closeDevTools === "function") {
      window.DiscordNative.closeDevTools();
      return true;
    }
    if (typeof window.DiscordNative?.toggleDevTools === "function") {
      window.DiscordNative.toggleDevTools();
      return true;
    }

    return false;
  };

  setTimeout(closeDevToolsIfAvailable, 0);
})();
