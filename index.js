/**
 * st-rpg-hud v2.0 — Single-file consolidated entry
 * Using minimal imports — same pattern as ST-Outfits (the working reference)
 */

console.log("[st-rpg-hud] Starting module load v4.0.0...");


import { extension_settings, getContext } from "../../../extensions.js";

let eventSource, event_types;

// Hardcoded ST constants to prevent import-graph failures
const IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;

const EXT = "st-rpg-hud";
const SCHEMA_V = 6;
const TAB_STORE = `${EXT}-tab`;
const COLLAPSED_STORE = `${EXT}-collapsed`;

// Session-only vital history for sparklines (not persisted)
const _vitalHistory = {};
// Previous vital values for delta indicators
const _prevVitals = {};

// Build a mini SVG sparkline from an array of values
function buildSparkline(values, max) {
    if (!values || values.length < 2) return '';
    const W = 44, H = 12;
    const peak = max || Math.max(...values, 1);
    const pts = values.map((v, i) => `${Math.round((i / (values.length - 1)) * W)},${Math.round(H - Math.max(0, Math.min(1, v / peak)) * H)}`).join(' ');
    return `<svg class="rpg-sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// We use a getter to always retrieve the live settings object from ST
function getCFG() {
    if (!extension_settings[EXT]) {
        extension_settings[EXT] = {
            enabledChatIds: [],
            chatStates: {},
            opts: { depth: 4, budget: "standard", gmEdit: false, sfx: false }
        };
    }
    const cfg = extension_settings[EXT];
    // Ensure sub-objects always exist (handles partially-saved settings from older versions)
    if (!cfg.opts) cfg.opts = { depth: 4, budget: "standard", gmEdit: false, sfx: false };
    if (!cfg.enabledChatIds) cfg.enabledChatIds = [];
    if (!cfg.chatStates) cfg.chatStates = {};

    // ── Persistence + JSON-repair toggles ───────────────────────────────────
    if (cfg.opts.keepDeceasedInRoster === undefined) cfg.opts.keepDeceasedInRoster = true;
    if (cfg.opts.aggressiveJsonRepair === undefined) cfg.opts.aggressiveJsonRepair = true;

    // ── v4 token-saver toggles (see rpg-hud-v4-plan.md) ────────────────────
    if (cfg.opts.deltaOnly === undefined)          cfg.opts.deltaOnly = true;        // A.1
    if (cfg.opts.tieredInjection === undefined)    cfg.opts.tieredInjection = true;  // A.2
    if (cfg.opts.adaptiveReminder === undefined)   cfg.opts.adaptiveReminder = true; // A.3
    if (cfg.opts.offSceneToLorebook === undefined) cfg.opts.offSceneToLorebook = true; // A.5
    if (cfg.opts.compactPersona === undefined)     cfg.opts.compactPersona = true;   // B.5
    if (cfg.opts.heartbeatInterval === undefined)  cfg.opts.heartbeatInterval = 10;  // B.3
    if (cfg.opts.virMode === undefined)            cfg.opts.virMode = 'self';        // B.1: 'self'|'bridge'|'off'

    return cfg;
}

// ── VIR Extension detection (B.1) ────────────────────────────────────────────
// Checks for ff4-vir-lorebook-sync presence. Bridge mode only activates when
// the extension is actually loaded; falls back to self-contained silently.
function virExtensionActive() {
    try {
        if (typeof window !== 'undefined' && window.FF4_VIR_API) return true;
        if (extension_settings && extension_settings['ff4-vir-lorebook-sync']) {
            const v = extension_settings['ff4-vir-lorebook-sync'];
            // ff4-vir stores per-chat enable; we just check the settings node exists
            return !!v && (v.enabled !== false);
        }
    } catch(e) { /* ignore */ }
    return false;
}

// Resolved VIR mode: opts setting + actual availability
function resolvedVirMode() {
    const mode = getCFG().opts.virMode || 'self';
    if (mode === 'bridge' && !virExtensionActive()) return 'self'; // fallback
    return mode;
}

// ── State helpers ─────────────────────────────────────────────
// ── deepMerge helper (ported from rpg-hud) ───────────────────
function deepMerge(target, src) {
    if (!src || typeof src !== 'object') return target;
    const out = Object.assign({}, target);
    for (const k of Object.keys(src)) {
        if (src[k] !== null && typeof src[k] === 'object' && !Array.isArray(src[k])) {
            out[k] = deepMerge(out[k] || {}, src[k]);
        } else {
            out[k] = src[k];
        }
    }
    return out;
}

function emptyState() {
    return {
        _v: SCHEMA_V, initialized: false,
        vitals: {}, attributes: {}, resources: {}, statuses: [], skills: [],
        inventory: [], party: {}, npcs: [], quests: [], notes: [],
        location: "Unknown",
        map: { currentLocation: "Unknown", region: "Unknown", landmarks: [], travelLog: [], peopleHere: [] },
        combat: { active: false, turn: 0, ap: 0, ap_max: 3, enemy: "" },
        outfits: [], outfitPresets: {}, factions: {},
        time: { day: 1, hour: 12, season: "Unknown", period: "day", dateStr: "" },
        flags: {}, npcRelations: [],
        // ── v4 fields ──
        vir: {}, charInner: {}, charExternal: {}, charDev: {},
        mindset: {}, relationships: {}, secrets: [], open_threats: [],
        vad: {}, topics: null, world_flags: {},
        // ── v5 accuracy fields ──
        facts: [],          // [{id, text, priority:'critical|high|normal'}] — pinned truths AI must not contradict
        active_goal: "",   // current scene objective (required every turn)
        personas: {},       // {CharName: {voice, core_belief, fears, goals, quirks, forbidden, speech_example}}
        scene_objects: [],  // [{id, name, desc, location}] — persistent props in current scene
        keyMoments: [],     // [{turn, text, characters:[]}] — crystallized story beats
        // ── v6 preset-aligned fields (Phase 3) ──
        scene_state: {      // mutable per-turn state separate from locked VIR
            perCharacter: {},  // {<name>:{hair_state,exertion_state,injuries,outfit_damage,hand_contents,makeup_state,gaze_target,body_state}}
            sceneWide: {}      // {key_light,rim_light,ambient,palette,atmosphere,camera_baseline}
        },
        // ── internal tracking ──
        _turnCount: 0,      // incremented on each AI message processed
        _stateChangelog: [],// [{turn, field, from, to}] — last 200 mutations
        _contradictions: [],// [{turn, type, message}] — drift/violation log
        _parseMisses: 0,    // count of turns with no rpg block found
        _summaries: [],     // [{turns:'1-15', text:'...'}] — compressed old-message summaries
        // ── v4 token-saver tracking ──
        _lastFullEchoTurn: 0,  // turn of last full-echo rpg block (B.3 heartbeat)
        _seenPersonas: {},     // {name:true} — personas already shown in full this chat (B.5)
        _lorebookOffscene: {}, // {npcName: {worldName, uid}} — A.5 lorebook bookkeeping
        // ── v4.1 immersion tracking ──
        _npcLastSeenTurn: {},  // {name: turn} — when each NPC was last in scene (for return callback)
        _goalStartedTurn: 0,   // turn when current active_goal was set (stagnation nudge)
        _lastLocation: '',     // detect location-change for scene transition cue
        _lastTimeSnapshot: null, // {day,hour} from prior turn (time-skip detection)
        _milestonesHit: {},    // {`${name}|${field}|${tier}`: turn} — relationship milestones already announced
        _lastSummaryTurn: 0,   // last turn we ran summarisation (A.6)
        _lastSummaryLocation: '', // location at last summary (location-change trigger)
        _ruleOverlay: '',      // per-chat extra rules (C.6)
    };
}

function getChatId() { return getContext().chatId || "global"; }

function getState() {
    const id = getChatId();
    const cfg = getCFG();
    if (!cfg.chatStates[id]) cfg.chatStates[id] = emptyState();
    return migrate(cfg.chatStates[id]);
}

function saveState() {
    const s = getState();
    if (s.notes?.length > 100) s.notes = s.notes.slice(-100);
    getContext().saveSettingsDebounced();
}

function migrate(s) {
    if (!s._v) { s._v = 0; }
    if (s._v < 2) {
        s.vitals = s.vitals || {}; s.attributes = s.attributes || {};
        s.resources = s.resources || {}; s.statuses = s.statuses || [];
        s.skills = s.skills || []; s.inventory = s.inventory || [];
        s.party = Array.isArray(s.party) ? {} : (s.party || {});
        s.npcs = s.npcs || s.connections || []; s.quests = s.quests || [];
        s.notes = s.notes || []; s.combat = s.combat || { active: false, turn: 0, ap: 0, ap_max: 3 };
        s.location = s.location || "Unknown";
        s.map = { currentLocation: s.location, region: "Unknown", landmarks: [], travelLog: [] };
        s._v = 2;
        getContext().saveSettingsDebounced();
    }
    if (s._v < 3) {
        s.outfits = s.outfits || [];
        s.outfitPresets = s.outfitPresets || {};
        s.factions = s.factions || {};
        s.time = s.time || { day: 1, hour: 12, season: "Unknown", period: "day", dateStr: "" };
        s.flags = s.flags || {};
        s.npcRelations = s.npcRelations || [];
        s._v = 3;
        getContext().saveSettingsDebounced();
    }
    if (s._v < 4) {
        s.vir = s.vir || {};
        s.charInner = s.charInner || {};
        s.charExternal = s.charExternal || {};
        s.charDev = s.charDev || {};
        s.mindset = s.mindset || {};
        s.relationships = s.relationships || {};
        s.secrets = s.secrets || [];
        s.open_threats = s.open_threats || [];
        s.vad = s.vad || {};
        s.topics = s.topics || null;
        s.world_flags = s.world_flags || {};
        s._v = 4;
        getContext().saveSettingsDebounced();
    }
    if (s._v < 5) {
        s.facts         = s.facts         || [];
        s.active_goal   = s.active_goal   || "";
        s.personas      = s.personas      || {};
        s.scene_objects = s.scene_objects || [];
        s.keyMoments    = s.keyMoments    || [];
        s._turnCount     = s._turnCount    || 0;
        s._stateChangelog= s._stateChangelog || [];
        s._contradictions= s._contradictions || [];
        s._parseMisses   = s._parseMisses  || 0;
        s._summaries     = s._summaries    || [];
        // ensure map.peopleHere exists
        if (s.map && !s.map.peopleHere) s.map.peopleHere = [];
        s._v = 5;
        getContext().saveSettingsDebounced();
    }
    // ── v6 → v7 (v4-plan token saver internal fields) ──────────────────────
    if (s._v >= 6 && (s._lastFullEchoTurn === undefined || s._seenPersonas === undefined || s._lorebookOffscene === undefined)) {
        if (s._lastFullEchoTurn === undefined) s._lastFullEchoTurn = 0;
        if (s._seenPersonas === undefined)     s._seenPersonas = {};
        if (s._lorebookOffscene === undefined) s._lorebookOffscene = {};
        getContext().saveSettingsDebounced();
    }
    // ── v4.1 immersion tracking fields ─────────────────────────────────────
    if (s._npcLastSeenTurn === undefined)    s._npcLastSeenTurn = {};
    if (s._goalStartedTurn === undefined)    s._goalStartedTurn = 0;
    if (s._lastLocation === undefined)       s._lastLocation = '';
    if (s._lastTimeSnapshot === undefined)   s._lastTimeSnapshot = null;
    if (s._milestonesHit === undefined)      s._milestonesHit = {};
    if (s._lastSummaryTurn === undefined)    s._lastSummaryTurn = 0;
    if (s._lastSummaryLocation === undefined) s._lastSummaryLocation = '';
    if (s._ruleOverlay === undefined)        s._ruleOverlay = '';
    // ── v5 → v6 (preset-aligned roster persistence + scene_state) ──────────
    if (s._v < 6) {
        // scene_state ledger — split per-character (mutable) from sceneWide (lighting)
        if (!s.scene_state || typeof s.scene_state !== 'object') {
            s.scene_state = { perCharacter: {}, sceneWide: {} };
        } else {
            if (!s.scene_state.perCharacter) s.scene_state.perCharacter = {};
            if (!s.scene_state.sceneWide) s.scene_state.sceneWide = {};
        }
        // Promote existing legacy v4 vir entries — ensure each has active/status flags.
        if (s.vir && typeof s.vir === 'object') {
            for (const [name, entry] of Object.entries(s.vir)) {
                if (!entry || typeof entry !== 'object') continue;
                if (entry.active === undefined) entry.active = true;
                if (entry.status === undefined) entry.status = 'alive';
            }
        }
        s._v = 6;
        getContext().saveSettingsDebounced();
        console.log('[st-rpg-hud] Migrated state to v6 (preset-aligned VIR roster + scene_state)');
    }
    // Always deduplicate quest steps
    for (const q of (s.quests||[])) {
        if (q.steps?.length > 1) q.steps = [...new Set(q.steps)];
    }
    // Rotate stateChangelog: keep last 200
    if (s._stateChangelog?.length > 200) s._stateChangelog = s._stateChangelog.slice(-200);
    return s;
}

function isEnabled() { return (getCFG().enabledChatIds || []).includes(getChatId()); }

// ── Parser ────────────────────────────────────────────────────
function extractAttrs(str) {
    const r = {}, re = /(\w[\w-]*)\s*=\s*"([^"]*)"/g; let m;
    while ((m = re.exec(str))) r[m[1].toLowerCase()] = m[2];
    return r;
}

function scanTags(tag, xml) {
    const t = tag.toUpperCase(), out = [];
    // self-closing
    const sc = new RegExp(`<${t}([^>]*?)\\s*\\/?>`, "gi"); let m;
    while ((m = sc.exec(xml))) out.push({ a: extractAttrs(m[1] || ""), inner: "" });
    // paired
    const pr = new RegExp(`<${t}([^>]*)>([\\s\\S]*?)<\\/${t}>`, "gi");
    while ((m = pr.exec(xml))) out.push({ a: extractAttrs(m[1] || ""), inner: (m[2] || "").trim() });
    return out;
}

// ── Block detection (primary: ```rpg JSON fence; fallback: <RPG-HUD> XML) ──────
// Returns { type: 'json'|'xml', content: string } or null
function hudBlock(text) {
    // Primary: ```rpg ... ``` code fence (most reliable across all LLMs)
    const fenceM = text.match(/```rpg\s*\n([\s\S]*?)```/i);
    if (fenceM) return { type: 'json', content: fenceM[1].trim() };
    // Legacy fallback: <RPG-HUD>...</RPG-HUD> XML
    const tail = text.length > 2000 ? text.slice(-2000) : text;
    const oi = tail.search(/<RPG-HUD\s*>/i);
    if (oi === -1) return null;
    const rest = tail.slice(oi);
    const openTag = rest.match(/<RPG-HUD\s*>/i);
    if (!openTag) return null;
    const inner = rest.slice(openTag[0].length);
    const close = inner.match(/<\/RPG-HUD>/i);
    return { type: 'xml', content: close ? inner.slice(0, close.index) : inner };
}

function stripHud(text) {
    return text
        // Preset wraps the rpg block in <details><summary>📊 RPG State Update</summary>...```rpg...```...</details>.
        // Strip the entire wrapper when it contains a ```rpg fence (matches both closed and unclosed).
        .replace(/<details[^>]*>\s*<summary[^>]*>[^<]*RPG\s*State[^<]*<\/summary>[\s\S]*?<\/details>/gi, "")
        .replace(/<details[^>]*>\s*<summary[^>]*>[^<]*📊[^<]*<\/summary>[\s\S]*?<\/details>/gi, "")
        .replace(/```rpg[\s\S]*?```/gi, "")                          // JSON fences (new format)
        .replace(/\[RPG_UPDATE_BLOCK:[^\]]*\]/gi, "")                // Old compact bracket format
        .replace(/<RPG-HUD\s*>[\s\S]*?<\/RPG-HUD>/gi, "")           // XML wrapped
        .replace(/<RPG-HUD\s*>[\s\S]*/gi, "").trimEnd();             // unclosed XML
}

// Strip all RPG data from a DOM element (handles ST's rendered HTML forms)
function stripHudFromDom(el) {
    // Preset wraps the rpg block in <details><summary>📊 RPG State Update</summary>...</details>.
    // First pass: walk every <details> whose summary identifies it as the RPG state wrapper, and remove it whole.
    el.querySelectorAll('details').forEach(d => {
        const sum = d.querySelector('summary');
        if (!sum) return;
        const summaryText = sum.textContent || '';
        if (/RPG\s*State\s*Update/i.test(summaryText) || summaryText.includes('📊')) {
            d.remove();
        }
    });
    // Second pass: ST renders ```rpg as <pre><code class="language-rpg">. Remove any standalone fences.
    el.querySelectorAll('pre:has(code.language-rpg), code.language-rpg').forEach(node => {
        const pre = node.closest('pre') || node;
        // If the <pre> sits inside a <details>, also remove the parent details if it now has no real content.
        const parentDetails = pre.parentElement?.closest('details');
        pre.remove();
        if (parentDetails) {
            // Re-check: if the details now has only summary + whitespace, remove the whole thing.
            const survivors = Array.from(parentDetails.children).filter(c => c.tagName !== 'SUMMARY');
            const hasNonEmptyText = survivors.some(c => (c.textContent || '').trim().length > 0);
            if (!hasNonEmptyText) parentDetails.remove();
        }
    });
    // Old compact bracket format visible as text
    if (/\[RPG_UPDATE_BLOCK:/i.test(el.innerHTML)) {
        el.innerHTML = el.innerHTML.replace(/\[RPG_UPDATE_BLOCK:[^\]]*\]/gi, '');
    }
    // Legacy XML wrapper
    if (/<RPG-HUD/i.test(el.innerHTML)) {
        el.innerHTML = el.innerHTML.replace(/<RPG-HUD\s*>[\s\S]*?(?:<\/RPG-HUD>|$)/gi, '');
    } else if (BARE_TAG_RE.test(el.innerHTML)) {
        for (const tag of BARE_TAG_NAMES) {
            el.innerHTML = el.innerHTML.replace(new RegExp(`<${tag}[^>]*?(?:\\s*/>|>[\\s\\S]*?<\\/${tag}>)`, 'gi'), '');
        }
    }
}

// Legacy bare XML tags (AI skipping <RPG-HUD> wrapper entirely)
const BARE_TAG_NAMES = ["STAT","SKILL","STATUS","ITEM","OUTFIT","PARTY","QUEST","NPC_REL","NPC","LOC","FACTION","TIME","FLAG","COMBAT","NOTE","CHECK"];
const BARE_TAG_RE = new RegExp(`<(?:${BARE_TAG_NAMES.join('|')})[\\s/>]`, "i");

// ── Phase 1: robust JSON parser ─────────────────────────────────────────────
// The preset (Freaky Frankenstein 4 MAX - Natural PIC) emits ```rpg blocks whose
// reference examples include /* ... */ and // ... comments. Standard JSON.parse
// rejects them. This helper strips comments + trailing commas + unwraps stray
// ```json fences, then falls back to a truncate-at-last-balanced-brace repair.
//
// Returns { data, recovered: bool, repairAttempts: number } on success,
// or throws (just like JSON.parse) only after all repair attempts fail.
function robustJsonParse(rawContent) {
    let attempts = 0;
    let lastErr = null;

    // Strip ```json wrapper if AI mistakenly nested code fences
    let content = rawContent.replace(/^```(?:json|rpg)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

    // Pass 1: strict
    try {
        attempts++;
        return { data: JSON.parse(content), recovered: false, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    // Pass 2: strip comments + trailing commas
    try {
        attempts++;
        const cleaned = content
            .replace(/\/\*[\s\S]*?\*\//g, '')          // /* block comments */
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')  // // line comments (avoid http://)
            .replace(/,\s*([\}\]])/g, '$1');           // trailing commas
        return { data: JSON.parse(cleaned), recovered: true, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    // Pass 3: repair common AI mistakes — escape literal newlines inside strings + previous fixes
    try {
        attempts++;
        const repaired = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
            .replace(/,\s*([\}\]])/g, '$1')
            .replace(/(?<="[^"\n]*)\n(?=[^"\n]*")/g, '\\n');
        return { data: JSON.parse(repaired), recovered: true, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    // Pass 4: truncate-at-last-balanced-brace and try again
    try {
        attempts++;
        const cleaned = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
            .replace(/,\s*([\}\]])/g, '$1');
        let depth = 0, lastBalanced = -1, inStr = false, strCh = null, escape = false;
        for (let i = 0; i < cleaned.length; i++) {
            const c = cleaned[i];
            if (escape) { escape = false; continue; }
            if (inStr) {
                if (c === '\\') escape = true;
                else if (c === strCh) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
            if (c === '{' || c === '[') depth++;
            else if (c === '}' || c === ']') { depth--; if (depth === 0) lastBalanced = i; }
        }
        if (lastBalanced > 0) {
            const truncated = cleaned.slice(0, lastBalanced + 1);
            return { data: JSON.parse(truncated), recovered: true, repairAttempts: attempts };
        }
    } catch (e) { lastErr = e; }

    throw lastErr || new Error('robustJsonParse: all repair attempts failed');
}

// Returns { type, content } or null
function hudContent(text) {
    const block = hudBlock(text);
    if (block !== null) return block;
    // Legacy: bare XML tags without any wrapper
    if (BARE_TAG_RE.test(text)) return { type: 'xml', content: text };
    return null;
}

// Strip bare XML tags from text
function stripBareTags(text) {
    let result = text;
    for (const tag of BARE_TAG_NAMES) {
        result = result.replace(new RegExp(`<${tag}[^>]*?\\s*/?>`, "gi"), "");
        result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    }
    return result.trimEnd();
}

function clamp(n, lo, hi) { return Math.max(lo, hi != null ? Math.min(hi, n) : n); }

function applyTag(tags, state) {
    let changed = false;
    for (const { a } of tags) {
        const id = (a.id || a.name || a.stat || "").toLowerCase().trim();
        if (!id) continue;
        // find or create
        let obj = state.vitals[id] || state.attributes[id] || state.resources[id];
        if (!obj) {
            const vitals = ["hp","mp","ap","sta","fp","sp","health","mana","energy","stamina"];
            const attrs  = ["str","dex","con","int","wis","cha","spd","lck","per","end"];
            const nm = a.name || id.toUpperCase();
            if (vitals.includes(id)) state.vitals[id] = { name: nm, value: 0, max: undefined, color: "#e05252" };
            else if (attrs.includes(id)) state.attributes[id] = { name: nm, value: 10 };
            else state.resources[id] = { name: nm, value: 0 };
            obj = state.vitals[id] || state.attributes[id] || state.resources[id];
            changed = true;
        }
        if (a.name && obj.name !== a.name) { obj.name = a.name; changed = true; }
        if (a.color) obj.color = a.color;
        if (a.max !== undefined) { obj.max = parseFloat(a.max); changed = true; }
        const abs = a.value ?? a.set ?? a.abs;
        if (abs !== undefined) {
            obj.value = clamp(parseFloat(abs) || 0, 0, obj.max);
            changed = true;
        } else if (a.delta !== undefined) {
            const d = clamp(parseFloat(a.delta) || 0, -9999, 9999);
            obj.value = clamp((obj.value || 0) + d, 0, obj.max);
            changed = true;
        }
    }
    return changed;
}

function applySkills(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const id = (a.id || a.name || "").trim(); if (!id) continue;
        const act = (a.action || "add").toLowerCase();
        const idx = state.skills.findIndex(s => s.id === id || s.name === id);
        if (act === "add" && idx === -1) { state.skills.push({ id, name:a.name||id, desc:a.desc||"", level:a.level||a.rank||"1", type:a.type||"active", category:a.category||"general", cost:a.cost||"", cooldown:parseInt(a.cooldown||"0"), cd_remaining:0 }); ch=true; }
        else if (act === "level" && idx !== -1) { state.skills[idx].level=a.level||a.rank||state.skills[idx].level; if(a.cost)state.skills[idx].cost=a.cost; if(a.cooldown)state.skills[idx].cooldown=parseInt(a.cooldown); ch=true; }
        else if (act === "cooldown" && idx !== -1) { state.skills[idx].cd_remaining=parseInt(a.turns||"0"); ch=true; }
        else if (act === "remove" && idx !== -1) { state.skills.splice(idx,1); ch=true; }
    }
    return ch;
}

function applyStatuses(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const id = (a.id || a.name || "").trim(); if (!id) continue;
        const act = (a.action || "add").toLowerCase();
        const idx = state.statuses.findIndex(s => s.id === id || s.name === id);
        if (act === "add" && idx === -1) { state.statuses.push({ id, name: a.name||id, desc: a.desc||"", turns: a.turns?parseInt(a.turns):undefined, type: a.type||"debuff" }); ch=true; }
        else if (act === "remove" && idx !== -1) { state.statuses.splice(idx,1); ch=true; }
    }
    return ch;
}

function applyItems(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const nm = (a.name || "").trim(); if (!nm) continue;
        const act = (a.action || "add").toLowerCase();
        const idx = state.inventory.findIndex(i => i.name.toLowerCase() === nm.toLowerCase());
        if ((act === "add") && idx === -1) { state.inventory.push({ name: nm, slot: a.slot||"backpack", type: a.type||"item", desc: a.desc||"", qty: parseInt(a.qty||"1")||1, equipped: false }); ch=true; }
        else if ((act === "add") && idx !== -1) { state.inventory[idx].qty = (state.inventory[idx].qty||1)+(parseInt(a.qty||"1")||1); ch=true; }
        else if ((act === "remove"||act==="use"||act==="consume") && idx !== -1) { if (act!=="remove" && state.inventory[idx].qty>1) state.inventory[idx].qty--; else state.inventory.splice(idx,1); ch=true; }
        else if (act === "equip" && idx !== -1) { const sl=a.slot||state.inventory[idx].slot; state.inventory.forEach(i=>{if(i.equipped&&i.slot===sl&&i.name!==nm)i.equipped=false;}); state.inventory[idx].equipped=true; state.inventory[idx].slot=sl; ch=true; }
        else if (act === "unequip" && idx !== -1) { state.inventory[idx].equipped=false; ch=true; }
    }
    return ch;
}

// Relationship fields live in npcs[] only — party only stores combat stats
const PARTY_REL_FIELDS = ["affection","trust","desire","lust","fear","respect","rivalry","connection","hostility","gratitude"];
const PARTY_STAT_FIELDS = ["hp","hp_max","mp","mp_max"];

function syncRelToNpc(nm, relUpdates, state) {
    // Find or create matching NPC, then apply relationship values to it
    let idx = state.npcs.findIndex(n => n.name.toLowerCase() === nm.toLowerCase());
    if (idx === -1) {
        state.npcs.push({name:nm,role:"party member",note:"",outfit:"",disposition:"friendly",location:state.location||"Unknown",trust:0,affection:0,fear:0,respect:0,hostility:0,gratitude:0});
        idx = state.npcs.length - 1;
    }
    for (const [f, v] of Object.entries(relUpdates)) {
        state.npcs[idx][f] = clamp(v, -100, 100);
    }
}

function applyParty(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const nm = (a.char || a.name || "").trim(); if (!nm) continue;
        const act = (a.action || "").toLowerCase();
        if (!state.party[nm]) state.party[nm] = {};
        if (act === "remove") { delete state.party[nm]; ch=true; continue; }
        // Relationship fields → sync to NPC store (single source of truth)
        const relUpdates = {};
        if (a.relation) {
            const f = a.relation.toLowerCase();
            if (PARTY_REL_FIELDS.includes(f)) {
                const npc = state.npcs.find(n => n.name.toLowerCase() === nm.toLowerCase());
                const cur = npc?.[f] || 0;
                relUpdates[f] = a.delta !== undefined ? cur + (parseFloat(a.delta)||0) : parseFloat(a.value||"0")||0;
            }
        }
        for (const f of PARTY_REL_FIELDS) {
            if (a[f] !== undefined) relUpdates[f] = parseFloat(a[f])||0;
        }
        if (Object.keys(relUpdates).length) { syncRelToNpc(nm, relUpdates, state); ch=true; }
        // Combat stats stay in party store
        for (const f of PARTY_STAT_FIELDS) {
            if (a[f] !== undefined) {
                state.party[nm][f] = clamp(parseFloat(a[f])||0, 0, f==="hp"?(state.party[nm].hp_max||9999):f==="mp"?(state.party[nm].mp_max||9999):9999);
                ch=true;
            }
        }
        if (a.status) { state.party[nm].status = a.status; ch=true; }
    }
    return ch;
}

function applyQuests(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const id = (a.id || a.name || "").trim(); if (!id) continue;
        const act = (a.action || "add").toLowerCase();
        const idx = state.quests.findIndex(q => q.id===id||q.title===id);
        if (act==="add" && idx===-1) { state.quests.push({ id, title:a.title||a.name||id, desc:a.desc||"", steps:[], status:"active", category:a.category||"main" }); ch=true; }
        else if (act==="step" && idx!==-1) { const s=a.desc||a.step||a.text; if(s&&!state.quests[idx].steps.includes(s)){state.quests[idx].steps.push(s);ch=true;} }
        else if ((act==="complete"||act==="finish") && idx!==-1) { state.quests[idx].status="completed"; ch=true; }
        else if (act==="fail" && idx!==-1) { state.quests[idx].status="failed"; ch=true; }
    }
    return ch;
}

function applyLoc(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        // Shorthand: <LOC add="Landmark Name"/> — attribute name IS the action
        if (a.add) {
            const lm = a.add.trim();
            if (lm && !state.map.landmarks.some(l=>l.name===lm)) {
                state.map.landmarks.push({ name:lm, type:a.type||"landmark", discovered:true, note:a.note||a.desc||"" });
                ch=true;
            }
            continue;
        }
        const nm = (a.name || "").trim();
        const act = (a.action || (nm ? "set" : "")).toLowerCase();
        if (act==="set" && nm) {
            if (state.location && state.location!==nm && state.location!=="Unknown") {
                state.map.travelLog.unshift(state.location);
                if (state.map.travelLog.length>15) state.map.travelLog.pop();
            }
            state.location = nm; state.map.currentLocation = nm;
            if (a.region) state.map.region = a.region;
            ch=true;
        } else if (act==="add" && nm) {
            if (!state.map.landmarks.some(l=>l.name===nm)) { state.map.landmarks.push({ name:nm, type:a.type||"landmark", discovered:true, note:a.note||a.desc||"" }); ch=true; }
        } else if (act==="region" && nm) { state.map.region=nm; ch=true; }
    }
    return ch;
}

function applyNpcs(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const nm=(a.name||"").trim(); if(!nm) continue;
        const act=(a.action||"add").toLowerCase();
        const idx=state.npcs.findIndex(n=>n.name.toLowerCase()===nm.toLowerCase());
        if (act==="add" && idx===-1) { state.npcs.push({name:nm,role:a.role||"unknown",note:a.note||a.desc||"",outfit:a.outfit||"",disposition:a.disposition||"neutral",location:a.location||state.location||"Unknown",trust:0,affection:0,fear:0,respect:0,hostility:0,gratitude:0}); ch=true; }
        else if ((act==="update"||act==="add") && idx!==-1) { if(a.role)state.npcs[idx].role=a.role; if(a.note||a.desc)state.npcs[idx].note=a.note||a.desc; if(a.disposition)state.npcs[idx].disposition=a.disposition; if(a.outfit)state.npcs[idx].outfit=a.outfit; ch=true; }
        else if (act==="remove" && idx!==-1) { state.npcs.splice(idx,1); ch=true; }
        // Apply relationship stats + outfit to any existing NPC regardless of action
        const NPC_REL_FIELDS = ["trust","affection","fear","respect","hostility","gratitude"];
        const npcIdx = state.npcs.findIndex(n=>n.name.toLowerCase()===nm.toLowerCase());
        if (npcIdx !== -1) {
            for (const f of NPC_REL_FIELDS) {
                if (a[f] !== undefined) { state.npcs[npcIdx][f] = clamp(parseFloat(a[f])||0,-100,100); ch=true; }
            }
            if (a.outfit) { state.npcs[npcIdx].outfit = a.outfit; ch=true; }
        }
    }
    return ch;
}

function applyCombat(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const mode=(a.mode||"").toLowerCase();
        if (mode==="active") { state.combat.active=true; if(a.turn)state.combat.turn=parseInt(a.turn)||0; if(a.ap)state.combat.ap=parseInt(a.ap)||0; if(a.ap_max)state.combat.ap_max=parseInt(a.ap_max)||3; if(a.enemy)state.combat.enemy=a.enemy; ch=true; }
        else if (mode==="idle"||mode==="end"||mode==="off") { state.combat.active=false; state.combat.turn=0; ch=true; }
    }
    return ch;
}

function applyOutfits(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const nm = (a.name || "").trim(); if (!nm) continue;
        const act = (a.action || "wear").toLowerCase();
        const idx = state.outfits.findIndex(o => o.name.toLowerCase() === nm.toLowerCase());
        if ((act==="wear"||act==="add") && idx===-1) {
            if (a.slot) state.outfits.forEach(o => { if(o.slot===a.slot&&o.active) o.active=false; });
            state.outfits.push({ name:nm, desc:a.desc||"", slot:a.slot||"body", active:true, rarity:a.rarity||"common" }); ch=true;
        } else if ((act==="wear"||act==="equip") && idx!==-1) {
            const sl = a.slot||state.outfits[idx].slot;
            state.outfits.forEach(o => { if(o.slot===sl&&o.active) o.active=false; });
            state.outfits[idx].active=true; if(a.desc)state.outfits[idx].desc=a.desc; ch=true;
        } else if ((act==="remove"||act==="unequip") && idx!==-1) {
            state.outfits[idx].active=false; ch=true;
        } else if (act==="update" && idx!==-1) {
            if(a.desc)state.outfits[idx].desc=a.desc; if(a.rarity)state.outfits[idx].rarity=a.rarity; ch=true;
        }
    }
    return ch;
}

function applyFactions(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const nm = (a.name || "").trim(); if (!nm) continue;
        const key = nm.toLowerCase().replace(/\s+/g,'_');
        if (!state.factions[key]) { state.factions[key] = { name:nm, rep:0, status:"neutral", note:"" }; ch=true; }
        if (a.rep !== undefined) { state.factions[key].rep = clamp(parseFloat(a.rep)||0,-100,100); ch=true; }
        if (a.delta !== undefined) { state.factions[key].rep = clamp((state.factions[key].rep||0)+(parseFloat(a.delta)||0),-100,100); ch=true; }
        if (a.status) { state.factions[key].status = a.status; ch=true; }
        if (a.note) { state.factions[key].note = a.note; ch=true; }
    }
    return ch;
}

function applyTime(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        if (a.day !== undefined) { state.time.day = parseInt(a.day)||state.time.day; ch=true; }
        if (a.hour !== undefined) { state.time.hour = parseFloat(a.hour)||state.time.hour; ch=true; }
        if (a.season) { state.time.season = a.season; ch=true; }
        if (a.period) { state.time.period = a.period; ch=true; }
        if (a.dateStr) { state.time.dateStr = a.dateStr; ch=true; }
        if (a.date) { state.time.dateStr = a.date; ch=true; }
    }
    return ch;
}

function applyFlags(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const id = (a.id||a.name||"").trim(); if (!id) continue;
        state.flags[id] = { label: a.label||id, value: a.value!==undefined?a.value:"true" }; ch=true;
    }
    return ch;
}

function applyNpcRels(tags, state) {
    let ch = false;
    for (const { a } of tags) {
        const from=(a.from||"").trim(), to=(a.to||"").trim(); if(!from||!to) continue;
        const idx = state.npcRelations.findIndex(r=>r.from===from&&r.to===to);
        const rel = { from, to, type:a.type||"knows", strength:a.strength||"neutral", note:a.note||"" };
        if (idx===-1) { state.npcRelations.push(rel); ch=true; }
        else { state.npcRelations[idx]=rel; ch=true; }
    }
    return ch;
}

// Fallback: parse the AI's backtick status line format
// e.g. `[ 🕰️ Time 04:32 PM | 🗓️ Thursday, 17th of Harvest Moon, 1247 AE | 📍 Dankmire Dungeon - Storage Room ]`
function parseStatusLine(text, state) {
    let ch = false;
    const lines = text.split('\n');
    for (const line of lines) {
        const stripped = line.trim();
        const m = stripped.match(/^`\[\s*(.+?)\s*\]`$/);
        if (!m) continue;
        const parts = m[1].split('|').map(p => p.trim());
        for (const part of parts) {
            // Location: emoji 📍
            const locM = part.match(/📍\s*(.+)/);
            if (locM) {
                const loc = locM[1].trim();
                if (loc && loc !== (state.map?.currentLocation||state.location)) {
                    if (state.location && state.location !== "Unknown") {
                        state.map.travelLog.unshift(state.location);
                        if (state.map.travelLog.length > 15) state.map.travelLog.pop();
                    }
                    state.location = loc; state.map.currentLocation = loc; ch=true;
                }
            }
            // Time: 🕰️ Time HH:MM AM/PM
            const timeM = part.match(/🕰️\s*Time\s+(\d+):(\d+)\s*(AM|PM)/i);
            if (timeM) {
                let h = parseInt(timeM[1]), m2 = parseInt(timeM[2]);
                const pm = timeM[3].toUpperCase()==='PM';
                if (pm && h!==12) h+=12; if (!pm && h===12) h=0;
                state.time.hour = h + m2/60;
                state.time.period = h<6?'night':h<12?'morning':h<18?'afternoon':'evening';
                ch=true;
            }
            // Date: 🗓️
            const dateM = part.match(/🗓️\s*(.+)/);
            if (dateM) { state.time.dateStr = dateM[1].trim(); ch=true; }
        }
    }
    return ch;
}

// ── C.2: State Changelog helper ───────────────────────────────
function logChange(s, field, from, to) {
    if (!s._stateChangelog) s._stateChangelog = [];
    const turn = s._turnCount || 0;
    s._stateChangelog.push({ turn, field, from, to, reason: 'rpg-block' });
    if (s._stateChangelog.length > 200) s._stateChangelog = s._stateChangelog.slice(-200);
}

// ── JSON block parser (primary format: ```rpg {...} ```) ──────────────────────
function applyJsonBlock(data, s) {
    let ch = false;

    // vitals: {"hp": [100,100]} or {"hp": {"value":100,"max":100}} or {"hp": {"v":100,"max":100}}
    if (data.vitals && typeof data.vitals === 'object') {
        for (const [id, val] of Object.entries(data.vitals)) {
            const lo = id.toLowerCase();
            if (!s.vitals[lo]) {
                const vitNames = {hp:"HP",mp:"MP",ap:"AP",sp:"SP",fp:"FP",sta:"STA",health:"Health",mana:"Mana",energy:"Energy",stamina:"Stamina"};
                s.vitals[lo] = { name: vitNames[lo]||id.toUpperCase(), value:0, max:undefined, color:"#e05252" }; ch=true;
            }
            if (Array.isArray(val)) {
                s.vitals[lo].value = parseFloat(val[0])||0;
                if (val[1] != null) s.vitals[lo].max = parseFloat(val[1]);
                ch=true;
            } else if (typeof val === 'number') {
                s.vitals[lo].value = val; ch=true;
            } else if (val && typeof val === 'object') {
                const v = val.v ?? val.value; const mx = val.max;
                if (v != null) { s.vitals[lo].value = parseFloat(v)||0; ch=true; }
                if (mx != null) { s.vitals[lo].max = parseFloat(mx); ch=true; }
                if (val.name) { s.vitals[lo].name = val.name; ch=true; }
            }
        }
    }

    // attrs / attributes: {"str": 12} or {"str": {"value":12}}
    const attrsData = data.attrs || data.attributes;
    if (attrsData && typeof attrsData === 'object') {
        for (const [id, val] of Object.entries(attrsData)) {
            const lo = id.toLowerCase();
            if (!s.attributes[lo]) { s.attributes[lo] = { name: id.toUpperCase(), value: 10 }; ch=true; }
            if (typeof val === 'number') { s.attributes[lo].value = val; ch=true; }
            else if (val && typeof val === 'object') { const v = val.v ?? val.value; if (v!=null){s.attributes[lo].value=parseFloat(v)||0;ch=true;} if(val.name)s.attributes[lo].name=val.name; }
        }
    }

    // resources: {"gold": 50} or {"gold": {"v":50}}
    if (data.resources && typeof data.resources === 'object') {
        for (const [id, val] of Object.entries(data.resources)) {
            const lo = id.toLowerCase();
            if (!s.resources[lo]) { s.resources[lo] = { name: id, value: 0 }; ch=true; }
            if (typeof val === 'number') { s.resources[lo].value = val; ch=true; }
            else if (val && typeof val === 'object') { const v = val.v ?? val.value; if(v!=null){s.resources[lo].value=parseFloat(v)||0;ch=true;} }
        }
    }

    // location: "Place | Region" or {name:"Place", region:"Region"}
    if (data.location) {
        let name, region;
        if (typeof data.location === 'string') {
            const parts = data.location.split('|').map(p => p.trim());
            name = parts[0]; region = parts[1];
        } else if (typeof data.location === 'object') {
            name = data.location.name; region = data.location.region;
        }
        if (name && name !== s.map.currentLocation) {
            const oldLoc = s.map.currentLocation || s.location;
            if (oldLoc && oldLoc !== "Unknown") { s.map.travelLog.unshift(oldLoc); if (s.map.travelLog.length>15) s.map.travelLog.pop(); }
            // ── D.1: Snapshot NPC emotional state on scene change ──
            const turn = s._turnCount || 0;
            for (const npc of (s.npcs||[])) {
                if (npc.location && npc.location.toLowerCase() === (oldLoc||"").toLowerCase()) {
                    npc.lastSeenAt = oldLoc;
                    npc.lastSeenTurn = turn;
                    npc.exitState = npc._exitNote || `${npc.disposition||'neutral'}`;
                }
            }
            logChange(s, 'location', oldLoc, name);
            s.location = name; s.map.currentLocation = name; ch=true;
        }
        if (region) { s.map.region = region; ch=true; }
    }

    // landmarks: [{name:"...", type:"...", note:"..."}]
    if (Array.isArray(data.landmarks)) {
        for (const lm of data.landmarks) {
            const nm = (lm.name||"").trim(); if (!nm) continue;
            if (!s.map.landmarks.some(x=>x.name===nm)) {
                s.map.landmarks.push({name:nm, type:lm.type||"landmark", discovered:true, note:lm.note||lm.desc||""});
                ch=true;
            }
        }
    }

    // time: {day:1, hour:16, period:"afternoon", season:"...", date:"..."}
    if (data.time && typeof data.time === 'object') {
        const t = data.time;
        if (t.day != null) { s.time.day = parseInt(t.day)||s.time.day; ch=true; }
        if (t.hour != null) { s.time.hour = parseFloat(t.hour)||s.time.hour; ch=true; }
        if (t.period) { s.time.period = t.period; ch=true; }
        if (t.season) { s.time.season = t.season; ch=true; }
        if (t.date || t.dateStr) { s.time.dateStr = t.date || t.dateStr; ch=true; }
    }

    // outfit: [{name, slot, action, desc}] or {name, slot}
    if (data.outfit) {
        const arr = Array.isArray(data.outfit) ? data.outfit : [data.outfit];
        for (const o of arr) {
            const nm = (o.name||"").trim(); if (!nm) continue;
            const act = (o.action||"wear").toLowerCase();
            const idx = s.outfits.findIndex(x => x.name.toLowerCase()===nm.toLowerCase());
            if ((act==="wear"||act==="add") && idx===-1) {
                if (o.slot) s.outfits.forEach(x=>{if(x.slot===o.slot&&x.active)x.active=false;});
                s.outfits.push({name:nm,desc:o.desc||"",slot:o.slot||"body",active:true,rarity:o.rarity||"common"}); ch=true;
            } else if ((act==="wear"||act==="equip") && idx!==-1) {
                const sl=o.slot||s.outfits[idx].slot;
                s.outfits.forEach(x=>{if(x.slot===sl&&x.active)x.active=false;});
                s.outfits[idx].active=true; if(o.desc)s.outfits[idx].desc=o.desc; ch=true;
            } else if ((act==="remove"||act==="unequip") && idx!==-1) { s.outfits[idx].active=false; ch=true; }
        }
    }

    // statuses: [{id, name, type, turns, action}]
    if (Array.isArray(data.statuses)) {
        for (const st of data.statuses) {
            const id=(st.id||st.name||"").trim(); if(!id) continue;
            const act=(st.action||"add").toLowerCase();
            const idx=s.statuses.findIndex(x=>x.id===id||x.name===id);
            if (act==="add"&&idx===-1) { s.statuses.push({id,name:st.name||id,desc:st.desc||"",turns:st.turns,type:st.type||"debuff"}); ch=true; }
            else if (act==="remove"&&idx!==-1) { s.statuses.splice(idx,1); ch=true; }
        }
    }

    // skills: [{id, name, action, level, type, category, cost, cooldown}]
    if (Array.isArray(data.skills)) {
        for (const sk of data.skills) {
            const id=(sk.id||sk.name||"").trim(); if(!id) continue;
            const act=(sk.action||"add").toLowerCase();
            const idx=s.skills.findIndex(x=>x.id===id||x.name===id);
            if (act==="add"&&idx===-1) { s.skills.push({id,name:sk.name||id,desc:sk.desc||"",level:String(sk.level||"1"),type:sk.type||"active",category:sk.category||"general",cost:sk.cost||"",cooldown:parseInt(sk.cooldown||"0"),cd_remaining:0}); ch=true; }
            else if (act==="level"&&idx!==-1) { if(sk.level)s.skills[idx].level=String(sk.level); ch=true; }
            else if (act==="remove"&&idx!==-1) { s.skills.splice(idx,1); ch=true; }
        }
    }

    // inventory: [{name, qty, rarity, slot, equipped, action}]
    if (Array.isArray(data.inventory)) {
        for (const item of data.inventory) {
            const nm=(item.name||"").trim(); if(!nm) continue;
            const act=(item.action||"add").toLowerCase();
            const idx=s.inventory.findIndex(i=>i.name.toLowerCase()===nm.toLowerCase());
            if (act==="add"&&idx===-1) { s.inventory.push({name:nm,slot:item.slot||"backpack",type:item.type||"item",desc:item.desc||"",qty:item.qty||1,equipped:item.equipped||false,rarity:item.rarity||"common"}); ch=true; }
            else if (act==="add"&&idx!==-1) { s.inventory[idx].qty=(s.inventory[idx].qty||1)+(item.qty||1); ch=true; }
            else if ((act==="remove"||act==="use"||act==="consume")&&idx!==-1) { if(act!=="remove"&&s.inventory[idx].qty>1)s.inventory[idx].qty--; else s.inventory.splice(idx,1); ch=true; }
            else if (act==="equip"&&idx!==-1) { const sl=item.slot||s.inventory[idx].slot; s.inventory.forEach(i=>{if(i.equipped&&i.slot===sl&&i.name!==nm)i.equipped=false;}); s.inventory[idx].equipped=true; s.inventory[idx].slot=sl; ch=true; }
            else if (act==="unequip"&&idx!==-1) { s.inventory[idx].equipped=false; ch=true; }
            else if (act==="update"&&idx!==-1) { if(item.qty!=null)s.inventory[idx].qty=item.qty; if(item.rarity)s.inventory[idx].rarity=item.rarity; if(item.desc)s.inventory[idx].desc=item.desc; ch=true; }
        }
    }

    // party: [{name, hp, hp_max, trust, affection, ...}] or {Name: {trust:10}}
    // Relationship fields → NPC store. Party store = combat stats only.
    if (data.party) {
        const arr = Array.isArray(data.party) ? data.party
            : Object.entries(data.party).map(([name,v])=>({name,...(typeof v==='object'?v:{})}));
        for (const p of arr) {
            const nm=(p.name||p.char||"").trim(); if(!nm) continue;
            if (p.action==="remove") { delete s.party[nm]; ch=true; continue; }
            if (!s.party[nm]) { s.party[nm]={}; ch=true; }
            // Combat stats → party store
            for (const f of PARTY_STAT_FIELDS) { if(p[f]!=null){s.party[nm][f]=parseFloat(p[f])||0;ch=true;} }
            if (p.status){s.party[nm].status=p.status;ch=true;}
            // Relationship values → NPC store (single source of truth)
            const relUpdates={};
            for (const f of PARTY_REL_FIELDS) { if(p[f]!=null) relUpdates[f]=parseFloat(p[f])||0; }
            if (Object.keys(relUpdates).length) { syncRelToNpc(nm, relUpdates, s); ch=true; }
        }
    }

    // npcs: [{name, role, disposition, trust, affection, fear, note, action}]
    if (Array.isArray(data.npcs)) {
        const NPC_REL_FIELDS=["trust","affection","fear","respect","hostility","gratitude"];
        for (const n of data.npcs) {
            const nm=(n.name||"").trim(); if(!nm) continue;
            const act=(n.action||"add").toLowerCase();
            let idx=s.npcs.findIndex(x=>x.name.toLowerCase()===nm.toLowerCase());
            if (act==="remove"&&idx!==-1) { s.npcs.splice(idx,1); ch=true; continue; }
            if (idx===-1) { s.npcs.push({name:nm,role:n.role||"unknown",note:n.note||n.desc||"",outfit:n.outfit||"",disposition:n.disposition||"neutral",location:n.location||s.location||"Unknown",trust:0,affection:0,fear:0,respect:0,hostility:0,gratitude:0}); ch=true; idx=s.npcs.length-1; }
            else { if(n.role)s.npcs[idx].role=n.role; if(n.note||n.desc)s.npcs[idx].note=n.note||n.desc; if(n.disposition)s.npcs[idx].disposition=n.disposition; if(n.outfit)s.npcs[idx].outfit=n.outfit; ch=true; }
            for (const f of NPC_REL_FIELDS) {
                if(n[f]!=null){
                    const prev = s.npcs[idx][f];
                    s.npcs[idx][f]=clamp(parseFloat(n[f])||0,-100,100);
                    if (Math.abs((s.npcs[idx][f]||0)-(prev||0)) > 5) logChange(s,`npcs.${nm}.${f}`,prev,s.npcs[idx][f]);
                    ch=true;
                }
            }
            // ── D.2: NPC goals & motivation ──
            if (n.current_goal !== undefined) { s.npcs[idx].current_goal = n.current_goal; ch=true; }
            if (n.hidden_agenda !== undefined) { s.npcs[idx].hidden_agenda = n.hidden_agenda; ch=true; }
            if (n.loyalty_threshold !== undefined) { s.npcs[idx].loyalty_threshold = parseInt(n.loyalty_threshold)||60; ch=true; }
            if (n.exit_note !== undefined) { s.npcs[idx]._exitNote = n.exit_note; ch=true; }
            // ── E.3: NPC name anchors ──
            if (Array.isArray(n.aliases)) { s.npcs[idx].aliases = n.aliases; ch=true; }
            if (Array.isArray(n.forbidden_names)) { s.npcs[idx].forbidden_names = n.forbidden_names; ch=true; }
        }
    }

    // quests: [{id, action, title, desc, step}]
    if (Array.isArray(data.quests)) {
        for (const q of data.quests) {
            const id=(q.id||q.title||"").trim(); if(!id) continue;
            const act=(q.action||"add").toLowerCase();
            const idx=s.quests.findIndex(x=>x.id===id||x.title===id);
            if (act==="add"&&idx===-1) { s.quests.push({id,title:q.title||id,desc:q.desc||"",steps:[],status:"active",category:q.category||"main"}); logChange(s,'quest.'+id,null,'active'); ch=true; }
            else if (act==="step"&&idx!==-1) { const step=q.step||q.desc; if(step&&!s.quests[idx].steps.includes(step)){s.quests[idx].steps.push(step);ch=true;} }
            else if ((act==="complete"||act==="finish")&&idx!==-1) { logChange(s,'quest.'+id,s.quests[idx].status,'completed'); s.quests[idx].status="completed"; ch=true; }
            else if (act==="fail"&&idx!==-1) { logChange(s,'quest.'+id,s.quests[idx].status,'failed'); s.quests[idx].status="failed"; ch=true; }
            else if (act==="reopen"&&idx!==-1) { logChange(s,'quest.'+id,s.quests[idx].status,'active'); s.quests[idx].status="active"; ch=true; }
            else if ((act==="active"||act==="add")&&idx!==-1&&s.quests[idx].status==="completed") {
                console.warn(`[st-rpg-hud] B.3: Quest "${id}" is completed — use action:"reopen" to reactivate. Ignored.`);
            }
        }
    }

    // factions: [{name, rep, status, note}] or {key:{name,rep,status}}
    if (data.factions) {
        const arr=Array.isArray(data.factions)?data.factions:Object.values(data.factions);
        for (const f of arr) {
            const nm=(f.name||"").trim(); if(!nm) continue;
            const key=nm.toLowerCase().replace(/\s+/g,'_');
            if(!s.factions[key]){s.factions[key]={name:nm,rep:0,status:"neutral",note:""};ch=true;}
            if(f.rep!=null){s.factions[key].rep=clamp(parseFloat(f.rep)||0,-100,100);ch=true;}
            if(f.status){s.factions[key].status=f.status;ch=true;}
            if(f.note){s.factions[key].note=f.note;ch=true;}
        }
    }

    // flags: {"flag_id": true} or {"flag_id": {label:"...", value:true}}
    if (data.flags && typeof data.flags === 'object') {
        for (const [id, val] of Object.entries(data.flags)) {
            const prev = s.flags[id]?.value;
            if (typeof val==='boolean'||typeof val==='string'||typeof val==='number') {
                s.flags[id]={label:id,value:val}; if(val!==prev) logChange(s,'flag.'+id,prev,val); ch=true;
            } else if (val&&typeof val==='object') {
                const nv=val.value!=null?val.value:true; s.flags[id]={label:val.label||id,value:nv}; if(nv!==prev) logChange(s,'flag.'+id,prev,nv); ch=true;
            }
        }
    }

    // npc_relations: [{from, to, type, strength, note}]
    if (Array.isArray(data.npc_relations)) {
        for (const r of data.npc_relations) {
            const from=(r.from||"").trim(),to=(r.to||"").trim(); if(!from||!to) continue;
            const idx=s.npcRelations.findIndex(x=>x.from===from&&x.to===to);
            const rel={from,to,type:r.type||"knows",strength:r.strength||"neutral",note:r.note||""};
            if(idx===-1){s.npcRelations.push(rel);}else{s.npcRelations[idx]=rel;}ch=true;
        }
    }

    // combat: {active:true, turn:1, ap:3, enemy:"Name"} or {active:false}
    if (data.combat&&typeof data.combat==='object') {
        const c=data.combat;
        if (c.active===true) { s.combat.active=true; if(c.turn!=null)s.combat.turn=c.turn; if(c.ap!=null)s.combat.ap=c.ap; if(c.ap_max!=null)s.combat.ap_max=c.ap_max; if(c.enemy)s.combat.enemy=c.enemy; ch=true; }
        else if (c.active===false&&s.combat.active) { s.combat.active=false; s.combat.turn=0; ch=true; }
    }

    // note: "text" — journal entry (stamp with turn for C.1 summarizer)
    if (typeof data.note==='string'&&data.note.trim()) { s.notes.push({text:data.note.trim(),ts:Date.now(),turn:s._turnCount||0}); ch=true; }

    // ── v6: VIR Roster (Phase 2) — preset's persistent campaign roster ──
    // Schema: vir{<name>: { active, status, species_class, hair{}, facial_hair{},
    //                       eyes{}, skin{}, body{}, limb_config{}, non_human{}, marks{},
    //                       outfit[], accessories[], equipment[], ...}}
    //
    // Rules (kimi_tracking_rules § VIR ROSTER PERSISTENCE):
    //   • Once introduced, NEVER drop from roster.
    //   • Off-scene → active:false. Death → status:"deceased".
    //   • Re-entry → flip active:true, copy verbatim.
    //   • State change → mutate field IN PLACE + emit vir_changes delta.
    const virSrc = data.vir;
    if (virSrc && typeof virSrc === 'object') {
        if (!s.vir) s.vir = {};
        for (const [charName, traits] of Object.entries(virSrc)) {
            if (typeof traits !== 'object' || traits === null) continue;

            // Deep-merge into existing entry (NEVER replace — preserves prior
            // fields the AI may have omitted this turn but that are still locked).
            s.vir[charName] = deepMerge(s.vir[charName] || {}, traits);

            // Default active/status if AI omitted them on a fresh introduction.
            if (s.vir[charName].active === undefined) s.vir[charName].active = true;
            if (s.vir[charName].status === undefined) s.vir[charName].status = 'alive';

            // ROSTER PERSISTENCE: never delete. (Even if AI omits a known character
            // this turn, deepMerge keeps the prior entry — no action needed here.)

            // Back-compat: mirror to npcs[] so existing tabs (NPCs/Party) show
            // them. Conservative — DOES NOT overwrite legacy fields the
            // applyNpcs handler may have just populated this same turn.
            // Only ADDS new entries when missing, and SYNCS active/status onto
            // existing entries (vir is the source of truth for those two only).
            const idx = s.npcs.findIndex(n => n.name && n.name.toLowerCase() === charName.toLowerCase());
            const compactOutfit = Array.isArray(s.vir[charName].outfit)
                ? s.vir[charName].outfit
                    .map(p => `${p.exact_color_shade||''} ${p.material||''} ${p.item_type||''}`.trim())
                    .filter(Boolean).join(', ')
                : '';
            if (idx === -1) {
                // New character — create entry with VIR-derived defaults.
                s.npcs.push({
                    name: charName,
                    role: traits.species_class || 'unknown',
                    disposition: 'neutral',
                    location: traits.location || s.location || 'Unknown',
                    note: '',
                    active: s.vir[charName].active,
                    status: s.vir[charName].status,
                    outfit: compactOutfit || undefined,
                    trust: 0, affection: 0, fear: 0, respect: 0, hostility: 0, gratitude: 0,
                });
            } else {
                // Existing entry — sync active/status only (vir is authoritative
                // for these two). Backfill an outfit summary only if the legacy
                // handler left it empty.
                s.npcs[idx].active = s.vir[charName].active;
                s.npcs[idx].status = s.vir[charName].status;
                if (!s.npcs[idx].outfit && compactOutfit) {
                    s.npcs[idx].outfit = compactOutfit;
                }
            }

            ch = true;
        }
        console.log('[st-rpg-hud] VIR roster updated:', Object.keys(s.vir).length, 'chars (active:',
            Object.values(s.vir).filter(v => v.active).length + ')');
    }

    // ── v6: vir_changes (Phase 2) — delta object listing locked-field mutations ──
    // Schema: vir_changes{<name>: {<dotted.path>: <new value>}}
    // e.g. {"Beril Vance": {"hair.length":"shoulder","hair.style":"blunt-bob"}}
    if (data.vir_changes && typeof data.vir_changes === 'object') {
        if (!s.vir) s.vir = {};
        for (const [charName, deltas] of Object.entries(data.vir_changes)) {
            if (!s.vir[charName]) s.vir[charName] = { active: true, status: 'alive' };
            if (typeof deltas !== 'object' || deltas === null) continue;
            const entry = s.vir[charName];
            for (const [path, newVal] of Object.entries(deltas)) {
                // Walk dotted path and set the leaf; create intermediate objects as needed.
                const segments = String(path).split('.');
                let cursor = entry;
                for (let i = 0; i < segments.length - 1; i++) {
                    const seg = segments[i];
                    if (typeof cursor[seg] !== 'object' || cursor[seg] === null) cursor[seg] = {};
                    cursor = cursor[seg];
                }
                cursor[segments[segments.length - 1]] = newVal;
                ch = true;
            }
            // Append a one-liner to the per-character outfit/state history for the Journal.
            if (!entry._changeHistory) entry._changeHistory = [];
            entry._changeHistory.push({
                turn: s._turnCount || 0,
                paths: Object.keys(deltas),
                ts: Date.now(),
            });
            if (entry._changeHistory.length > 30) entry._changeHistory = entry._changeHistory.slice(-30);
        }
    }

    // ── v6: scene_state (Phase 3) — per-character + scene-wide mutable state ──
    // Schema: scene_state{
    //   perCharacter:{<name>:{hair_state,exertion_state,injuries,outfit_damage,
    //                          hand_contents,makeup_state,gaze_target,body_state}},
    //   sceneWide:{key_light,rim_light,ambient,palette,atmosphere,camera_baseline}
    // }
    if (data.scene_state && typeof data.scene_state === 'object') {
        if (!s.scene_state) s.scene_state = { perCharacter: {}, sceneWide: {} };
        if (data.scene_state.perCharacter && typeof data.scene_state.perCharacter === 'object') {
            for (const [name, fields] of Object.entries(data.scene_state.perCharacter)) {
                if (typeof fields !== 'object' || fields === null) continue;
                s.scene_state.perCharacter[name] = deepMerge(s.scene_state.perCharacter[name] || {}, fields);
                ch = true;
            }
        }
        if (data.scene_state.sceneWide && typeof data.scene_state.sceneWide === 'object') {
            s.scene_state.sceneWide = deepMerge(s.scene_state.sceneWide || {}, data.scene_state.sceneWide);
            ch = true;
        }
        // Back-compat: also accept flat scene_state where keys aren't grouped.
        const FLAT_SCENE_KEYS = ['key_light','rim_light','ambient','palette','atmosphere','camera_baseline'];
        for (const k of FLAT_SCENE_KEYS) {
            if (data.scene_state[k] !== undefined) {
                s.scene_state.sceneWide[k] = data.scene_state[k];
                ch = true;
            }
        }
    }

    // ── v6: outfit_change (Phase 4) — piece removal/addition deltas ──────────
    // Schema: outfit_change{<name>: {removed:[{slot,item_type}], added:[<full piece>]}}
    if (data.outfit_change && typeof data.outfit_change === 'object') {
        if (!s.vir) s.vir = {};
        for (const [charName, ocData] of Object.entries(data.outfit_change)) {
            if (typeof ocData !== 'object' || ocData === null) continue;
            if (!s.vir[charName]) s.vir[charName] = { active: true, status: 'alive', outfit: [] };
            const entry = s.vir[charName];
            if (!Array.isArray(entry.outfit)) entry.outfit = [];
            if (!Array.isArray(entry._outfit_history)) entry._outfit_history = [];

            // Removals: match by slot+item_type (slot alone if item_type missing)
            if (Array.isArray(ocData.removed)) {
                for (const rem of ocData.removed) {
                    if (!rem || typeof rem !== 'object') continue;
                    const slot = rem.slot;
                    const item = rem.item_type;
                    const before = entry.outfit.length;
                    entry.outfit = entry.outfit.filter(p =>
                        !(p.slot === slot && (!item || p.item_type === item)));
                    if (entry.outfit.length !== before) {
                        entry._outfit_history.push({ turn: s._turnCount || 0, action: 'removed', piece: rem, ts: Date.now() });
                        ch = true;
                    }
                }
            }
            // Additions: push full piece object
            if (Array.isArray(ocData.added)) {
                for (const add of ocData.added) {
                    if (!add || typeof add !== 'object') continue;
                    entry.outfit.push(add);
                    entry._outfit_history.push({ turn: s._turnCount || 0, action: 'added', piece: add, ts: Date.now() });
                    ch = true;
                }
            }
            if (entry._outfit_history.length > 50) entry._outfit_history = entry._outfit_history.slice(-50);
        }
    }

    // ── v4: charInner (psychological/inner stats 0–100) ──
    if (data.charInner && typeof data.charInner === 'object') {
        const INNER_KEYS = ['health','moral','confidence','shame','promiscuity','arousal','dependence','love'];
        const INNER_MAX_DELTA = { health:15, moral:8, confidence:20, shame:20, promiscuity:15, arousal:30, dependence:15, love:10 };
        const cfg = typeof getCFG === 'function' ? getCFG() : {};
        const clampEnabled = cfg.opts?.deltaClamp !== false;
        
        for (const k of INNER_KEYS) {
            if (data.charInner[k] !== undefined) {
                let newVal = Number(data.charInner[k]) || 0;
                let oldVal = s.charInner[k] !== undefined ? s.charInner[k] : newVal;
                
                if (clampEnabled && INNER_MAX_DELTA[k]) {
                    const delta = Math.abs(newVal - oldVal);
                    if (delta > INNER_MAX_DELTA[k]) {
                        newVal = oldVal + Math.sign(newVal - oldVal) * INNER_MAX_DELTA[k];
                        console.warn(`[st-rpg-hud] charInner clamped: ${k} Δ${delta} → ${newVal}`);
                        if (!s._contradictions) s._contradictions = [];
                        s._contradictions.push({ turn: s._turnCount||0, type: 'delta_clamped', message: `charInner.${k} clamped to ${newVal}` });
                    }
                }
                s.charInner[k] = Math.max(0, Math.min(100, newVal));
                ch = true;
            }
        }
    }

    // ── v4: charExternal (appearance text fields) ──
    if (data.charExternal && typeof data.charExternal === 'object') {
        const EXT_KEYS = ['name','hair','makeup','outfit','stateOfDress','postureAndInteraction'];
        for (const k of EXT_KEYS) {
            if (data.charExternal[k] !== undefined) { s.charExternal[k] = data.charExternal[k]; ch = true; }
        }
    }

    // ── v4: charDev (body development stats 0–100) ──
    if (data.charDev && typeof data.charDev === 'object') {
        const DEV_KEYS = ['clitoris','vagina','anus','oral','breasts','nipples','masochism','caressing'];
        for (const k of DEV_KEYS) {
            if (data.charDev[k] !== undefined) {
                s.charDev[k] = Math.max(0, Math.min(100, Number(data.charDev[k]) || 0));
                ch = true;
            }
        }
    }

    // ── v4: mindset {mood, thoughts} ──
    if (data.mindset && typeof data.mindset === 'object') {
        if (data.mindset.mood !== undefined) { s.mindset.mood = data.mindset.mood; ch = true; }
        if (data.mindset.thoughts !== undefined) { s.mindset.thoughts = data.mindset.thoughts; ch = true; }
    }

    // ── v4: relationships — deep-merge per character ──
    if (data.relationships && typeof data.relationships === 'object') {
        s.relationships = deepMerge(s.relationships || {}, data.relationships);
        ch = true;
    }

    // ── v4: secrets [{id, title, text, revealed}] ──
    if (Array.isArray(data.secrets)) { s.secrets = data.secrets; ch = true; }

    // ── v4: open_threats [{source, nature, trigger}] ──
    if (Array.isArray(data.open_threats)) { s.open_threats = data.open_threats; ch = true; }

    // ── v4: vad — deep-merge per character {valence, arousal, dominance} ──
    if (data.vad && typeof data.vad === 'object') {
        s.vad = deepMerge(s.vad || {}, data.vad);
        ch = true;
    }

    // ── v4: topics / scene_topics ──
    const topicsSrc = data.topics || data.scene_topics;
    if (topicsSrc && typeof topicsSrc === 'object') { s.topics = topicsSrc; ch = true; }

    // ── v4: world_flags ──
    if (data.world_flags && typeof data.world_flags === 'object') {
        Object.assign(s.world_flags, data.world_flags); ch = true;
    }

    // ── v4: genre (shorthand top-level field) ──
    if (typeof data.genre === 'string') {
        s.topics = s.topics || {};
        s.topics.genre = data.genre;
        ch = true;
    }

    // ══════════════════════════════════════════════════════════
    // v5: Accuracy & Story Adherence Fields
    // ══════════════════════════════════════════════════════════

    const turn = s._turnCount || 0;

    // ── v5: facts — pinned truths [{id, text, priority} | {id, action:'remove'}] ──
    if (Array.isArray(data.facts)) {
        if (!s.facts) s.facts = [];
        for (const f of data.facts) {
            if (!f.id) continue;
            if (f.action === 'remove') {
                s.facts = s.facts.filter(x => x.id !== f.id);
                console.log(`[st-rpg-hud] Fact removed: ${f.id}`);
            } else if (f.text) {
                const idx = s.facts.findIndex(x => x.id === f.id);
                const fact = { id: f.id, text: f.text, priority: f.priority || 'normal' };
                if (idx === -1) { s.facts.push(fact); console.log(`[st-rpg-hud] Fact added: ${f.id}: ${f.text}`); }
                else s.facts[idx] = fact;
            }
            ch = true;
        }
    }

    // ── v5: active_goal — current scene objective ──
    if (typeof data.active_goal === 'string' && data.active_goal.trim()) {
        const newGoal = data.active_goal.trim();
        // v4.1: track when goal changed for stagnation nudge
        if (newGoal !== s.active_goal) {
            s._goalStartedTurn = s._turnCount || 0;
        }
        s.active_goal = newGoal;
        ch = true;
    }

    // ── v5: key_moment — crystallize a defining story beat ──
    if (typeof data.key_moment === 'string' && data.key_moment.trim()) {
        if (!s.keyMoments) s.keyMoments = [];
        // extract character names mentioned (match against known NPCs)
        const knownNames = (s.npcs||[]).map(n => n.name);
        const mentioned = knownNames.filter(nm => data.key_moment.includes(nm));
        s.keyMoments.push({ turn, text: data.key_moment.trim(), characters: mentioned, ts: Date.now() });
        // keep last 30 key moments
        if (s.keyMoments.length > 30) s.keyMoments = s.keyMoments.slice(-30);
        console.log(`[st-rpg-hud] Key moment crystallized at turn ${turn}: ${data.key_moment}`);
        ch = true;
    }

    // ── v5: personas — deep-merge per character ──
    if (data.personas && typeof data.personas === 'object') {
        if (!s.personas) s.personas = {};
        for (const [nm, p] of Object.entries(data.personas)) {
            s.personas[nm] = deepMerge(s.personas[nm] || {}, p);
            ch = true;
        }
    }

    // ── v5: scene_objects — persistent props [{id, name, desc, location, action:'add|remove'}] ──
    if (Array.isArray(data.scene_objects)) {
        if (!s.scene_objects) s.scene_objects = [];
        for (const obj of data.scene_objects) {
            if (!obj.id) continue;
            if (obj.action === 'remove') {
                s.scene_objects = s.scene_objects.filter(o => o.id !== obj.id);
            } else {
                const idx = s.scene_objects.findIndex(o => o.id === obj.id);
                const o = { id: obj.id, name: obj.name || obj.id, desc: obj.desc || '', location: obj.location || '' };
                if (idx === -1) s.scene_objects.push(o);
                else s.scene_objects[idx] = o;
            }
            ch = true;
        }
    }

    // ── v5: people_here — update map.peopleHere from npcs[].people_here ──
    // (also handled inside applyNpcs, but catch it here from JSON format too)
    if (Array.isArray(data.npcs)) {
        if (!s.map) s.map = { currentLocation: 'Unknown', region: 'Unknown', landmarks: [], travelLog: [], peopleHere: [] };
        if (!s.map.peopleHere) s.map.peopleHere = [];
        if (!s._npcLastSeenTurn) s._npcLastSeenTurn = {};
        const tNow = s._turnCount || 0;
        for (const n of data.npcs) {
            if (!n.name) continue;
            const wasHere = s.map.peopleHere.includes(n.name);
            if (n.people_here === true && !wasHere) {
                s.map.peopleHere.push(n.name);
                // v4.1: record last-seen turn for return callbacks; only set if
                // they were truly absent (not first-ever entry)
                if (s._npcLastSeenTurn[n.name] === undefined) {
                    // first ever — mark zero so return callback won't fire
                    s._npcLastSeenTurn[n.name] = tNow;
                }
            } else if (n.people_here === false && wasHere) {
                s.map.peopleHere = s.map.peopleHere.filter(x => x !== n.name);
                // record the turn they left so a future return knows the gap
                s._npcLastSeenTurn[n.name] = tNow;
            } else if (n.people_here === true && wasHere) {
                // refresh last-seen turn while present (no callback needed yet)
                s._npcLastSeenTurn[n.name] = tNow;
            }
            // Also store current_goal on the NPC object
            if (n.current_goal !== undefined) {
                const npc = s.npcs.find(x => x.name === n.name);
                if (npc) { npc.current_goal = n.current_goal; ch = true; }
            }
        }
    }

    // ── v5: rel_event — log why relationship changed ──
    if (typeof data.rel_event === 'string' && data.rel_event.trim()) {
        // Attach to relationships _history as a standalone event if no specific NPC targeted
        if (!s._relEvents) s._relEvents = [];
        s._relEvents.push({ turn, text: data.rel_event.trim(), ts: Date.now() });
        if (s._relEvents.length > 50) s._relEvents = s._relEvents.slice(-50);
        ch = true;
    }

    // ── v5: Delta validation — clamp relationship changes ──
    // Applied AFTER relationships are merged so we can compare against pre-existing values
    // (Note: clamping was done inline in the NPC applyNpcs handler above for NPC-level trust;
    //  here we clamp the top-level relationships{} object)
    const REL_MAX_DELTA = { trust: 15, affection: 12, fear: 15, respect: 15, hostility: 15 };
    if (data.relationships && typeof data.relationships === 'object') {
        const cfg = getCFG();
        const clampEnabled = cfg.opts?.deltaClamp !== false; // default: on
        if (clampEnabled) {
            for (const [nm, newRel] of Object.entries(data.relationships)) {
                // We need the PRE-merge value — read from state before deepMerge applied it
                // This is a best-effort: compare against what was stored before this call
                // Since deepMerge already ran above, we detect large absolute values instead
                for (const [field, maxDelta] of Object.entries(REL_MAX_DELTA)) {
                    if (newRel[field] !== undefined) {
                        const stored = s.relationships[nm]?.[field];
                        if (stored !== undefined) {
                            const delta = Math.abs(newRel[field] - stored);
                            if (delta > maxDelta) {
                                const clamped = stored + Math.sign(newRel[field] - stored) * maxDelta;
                                console.warn(`[st-rpg-hud] Delta clamped: ${nm}.${field} ${stored}→${newRel[field]} (Δ${delta}) → clamped to ${clamped}`);
                                s._contradictions.push({ turn, type: 'delta_clamped',
                                    message: `${nm}.${field}: ${stored}→${newRel[field]} (Δ${delta} > max ${maxDelta}) → clamped to ${clamped}` });
                                s.relationships[nm][field] = clamped;
                                ch = true;
                            }
                            // Log event to relationship history
                            const delta2 = (newRel[field] - stored);
                            if (Math.abs(delta2) > 3) {
                                if (!s.relationships[nm]._history) s.relationships[nm]._history = [];
                                const reason = data.rel_event || '';
                                s.relationships[nm]._history.push({ turn, field, delta: delta2, reason });
                                if (s.relationships[nm]._history.length > 20) s.relationships[nm]._history = s.relationships[nm]._history.slice(-20);
                            }
                        }
                    }
                }
            }
        }
    }

    // charInner delta clamping moved to assignment block above

    // ── v5: Range validation — clamp vitals to [0, max] ──
    for (const [id, v] of Object.entries(s.vitals || {})) {
        if (v.max != null) {
            if (v.value > v.max) { s.vitals[id].value = v.max; s._contradictions.push({ turn, type: 'range_clamped', message: `vitals.${id} ${v.value} > max ${v.max}` }); ch = true; }
            if (v.value < 0)    { s.vitals[id].value = 0;     s._contradictions.push({ turn, type: 'range_clamped', message: `vitals.${id} ${v.value} < 0` }); ch = true; }
        }
    }

    // ── v5: Increment turn counter ──
    s._turnCount = (s._turnCount || 0) + 1;

    // ── B.3: Detect full-echo and reset heartbeat ──
    // A "full echo" is any rpg block carrying ≥4 distinct top-level state
    // categories — meaning the AI re-emitted the bulk of the state rather
    // than a small delta. Used to confirm the heartbeat checkpoint landed.
    if (data && typeof data === 'object') {
        const echoKeys = ['vitals','location','time','npcs','quests','inventory','vir','facts','charInner','active_goal','statuses','skills'];
        const hits = echoKeys.filter(k => data[k] !== undefined).length;
        if (hits >= 4) {
            s._lastFullEchoTurn = s._turnCount;
            // Clear parse-miss streak — full echo confirms AI is healthy
            if ((s._parseMisses || 0) > 0) {
                s._parseMisses = 0;
            }
        }
    }

    // ── v5: Basic VIR contradiction scan (prose-level) ──
    // Called from processMessage() with full text, not just JSON — skipped here
    // (see runVirScan below)

    return ch;
}

// ── v5: VIR Contradiction Scanner ────────────────────────────
// Scans AI prose for appearance descriptions that contradict stored VIR
const COLOR_WORDS = ['black','dark','blonde','brown','red','white','grey','gray','silver','platinum','golden','auburn','chestnut','cyan','blue','green','violet','purple','pink','orange'];

function runVirScan(text, s) {
    if (!s.vir || !Object.keys(s.vir).length) return;
    const turn = s._turnCount || 0;
    for (const [charName, traits] of Object.entries(s.vir)) {
        if (!traits.hair) continue;
        // Build expected color tokens from stored VIR hair
        const storedHairColors = COLOR_WORDS.filter(c => traits.hair.toLowerCase().includes(c));
        if (!storedHairColors.length) continue;
        // Look for "{charName}'s {color} hair" or "her/his {color} hair" near char name
        const nameMentioned = text.toLowerCase().includes(charName.toLowerCase().split(' ')[0].toLowerCase());
        if (!nameMentioned) continue;
        // Simple scan: find color words adjacent to "hair" in text
        const hairPattern = /(\w+)\s+hair|hair\s+(?:that\s+was\s+)?(\w+)/gi;
        let m;
        while ((m = hairPattern.exec(text)) !== null) {
            const foundColor = (m[1] || m[2] || '').toLowerCase();
            if (!COLOR_WORDS.includes(foundColor)) continue;
            if (!storedHairColors.includes(foundColor)) {
                const msg = `VIR drift: "${charName}" hair — prose says "${foundColor}" but VIR says "${traits.hair}"`;
                console.warn(`[st-rpg-hud] ${msg}`);
                if (!s._contradictions) s._contradictions = [];
                // Deduplicate: don't re-log same message this turn
                const alreadyLogged = s._contradictions.some(c => c.turn === turn && c.message === msg);
                if (!alreadyLogged) s._contradictions.push({ turn, type: 'vir_drift', message: msg });
            }
        }
    }
}

// ── v4.1: B.2 STATS UPDATE bridge to ff4-vir stats tracker ────────────────────
// Parses the visible "─── STATS UPDATE ───" markdown block that the ff4-vir
// extension's VIR_CONTRACT instructs the AI to emit. Each bullet is
// "• StatName old → new — reason". Maps known stat names to RPG HUD state.
// Stores parsed deltas in s._statsUpdate (for the World Sim tab) and applies
// to charInner/vitals/npcs[].trust where field names match.
//
// Rule when both systems run: rpg block wins. This bridge only fills gaps —
// it never overwrites a value already set by the rpg block this turn.

function applyStatsUpdateBlock(text, s) {
    if (!text || typeof text !== 'string') return;
    // Match the section between ─── STATS UPDATE ─── and the next ─── line
    // OR the next ```vir / ```rpg fence, OR end of text.
    const headerRx = /─{3,}\s*STATS UPDATE\s*─{3,}/i;
    const m = text.match(headerRx);
    if (!m) return;
    const start = m.index + m[0].length;
    let end = text.length;
    const tail = text.slice(start);
    const endRx = /(─{3,}|```(?:vir|rpg))/i;
    const em = tail.match(endRx);
    if (em) end = start + em.index;
    const body = text.slice(start, end);

    // Bullet: "• StatName old → new — reason"  OR  "* Stat old -> new - reason"
    const bulletRx = /^\s*(?:[•\*\-]|[•])\s*([A-Za-z][A-Za-z0-9_()/ -]*?)\s*(?:=|:)?\s*([-]?[\d.]+|low|mid|high)?\s*(?:→|->|to)\s*([-]?[\d.]+|low|mid|high)\s*(?:[—\-]\s*(.+))?$/gm;
    // Simpler bullet form: "• StatName: X → Y — reason"
    const lineRx = /^\s*[•\*\-]\s+(.+)$/gm;
    const turn = s._turnCount || 0;
    const events = [];
    let charContext = null; // current **CharacterName** header
    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        // Character header: **Name**
        const headM = line.match(/^\*\*(.+?)\*\*$/);
        if (headM) { charContext = headM[1].trim(); continue; }
        // Italic "no change" marker
        if (/^\*no stats changed/i.test(line)) continue;
        // Bullet
        const bm = line.match(/^[•\*\-]\s*(.+)$/);
        if (!bm) continue;
        const content = bm[1];
        // Parse "Stat old → new — reason"
        const deltaM = content.match(/^([A-Za-z][\w()/ -]*?)\s+([-]?\d+(?:\.\d+)?)\s*(?:→|->)\s*([-]?\d+(?:\.\d+)?)\s*(?:[—\-]\s*(.+))?$/);
        if (deltaM) {
            const stat = deltaM[1].trim();
            const oldV = parseFloat(deltaM[2]);
            const newV = parseFloat(deltaM[3]);
            const reason = (deltaM[4] || '').trim();
            events.push({ character: charContext, stat, oldV, newV, reason, turn });
        }
    }
    if (!events.length) return;

    // Store for the World Sim tab
    if (!s._statsUpdate) s._statsUpdate = [];
    s._statsUpdate.push({ turn, events });
    if (s._statsUpdate.length > 50) s._statsUpdate = s._statsUpdate.slice(-50);

    // Apply gap-filling: only update HUD state when the rpg block didn't
    // already touch this field this turn. We use _stateChangelog as the
    // signal of "rpg block touched X" — anything that wasn't logged is
    // free to fill from the STATS UPDATE block.
    const rpgTouched = new Set((s._stateChangelog || []).filter(c => c.turn === turn).map(c => c.field));

    for (const ev of events) {
        const stat = ev.stat.toLowerCase();
        const tgt = ev.character;

        // Map common stat names → HUD paths
        if (tgt && /^trust\(.+\)$/.test(stat) || stat === 'trust') {
            // Per-NPC trust
            const npc = (s.npcs || []).find(n => n.name === tgt);
            if (npc && !rpgTouched.has(`npc.${tgt}.trust`)) {
                npc.trust = ev.newV;
            }
        } else if (tgt && (stat === 'affection' || stat === 'fear' || stat === 'respect' || stat === 'hostility' || stat === 'gratitude')) {
            const npc = (s.npcs || []).find(n => n.name === tgt);
            if (npc && !rpgTouched.has(`npc.${tgt}.${stat}`)) {
                npc[stat] = ev.newV;
            }
        } else if (stat === 'health' || stat === 'hp') {
            if (s.vitals?.hp && !rpgTouched.has('vitals.hp')) {
                s.vitals.hp.value = Math.max(0, Math.min(s.vitals.hp.max ?? ev.newV, ev.newV));
            } else if (!rpgTouched.has(`charInner.health`)) {
                if (!s.charInner) s.charInner = {};
                s.charInner.health = Math.max(0, Math.min(100, ev.newV));
            }
        } else if (['moral','confidence','shame','promiscuity','arousal','dependence','love'].includes(stat)) {
            if (!rpgTouched.has(`charInner.${stat}`)) {
                if (!s.charInner) s.charInner = {};
                s.charInner[stat] = Math.max(0, Math.min(100, ev.newV));
            }
        } else if (stat === 'stamina' || stat === 'sta') {
            if (s.vitals?.sta && !rpgTouched.has('vitals.sta')) {
                s.vitals.sta.value = Math.max(0, Math.min(s.vitals.sta.max ?? ev.newV, ev.newV));
            }
        }
        // Unknown stats are stored in _statsUpdate but not applied — visible
        // in World Sim tab for GM review.
    }
}

// ── v4.1: Persona drift detector ──────────────────────────────────────────────
// Scans the AI reply prose for actions/dialogue that violate any in-scene
// NPC's persona.forbidden field. Pattern is intentionally conservative —
// only flags when the forbidden phrase appears literally in prose attributed
// to that character (e.g. "Mika cried" when forbidden says "Never cries").
function runPersonaDriftScan(text, s) {
    if (!text || !s.personas) return;
    const peopleHere = s.map?.peopleHere || [];
    const turn = s._turnCount || 0;
    if (!s._contradictions) s._contradictions = [];
    for (const name of peopleHere) {
        const persona = s.personas[name];
        if (!persona?.forbidden) continue;
        // Tokenize forbidden into key phrases
        const phrases = String(persona.forbidden).split(/[.;]+/).map(p => p.trim()).filter(Boolean);
        for (const phrase of phrases) {
            // "Never cries in front of others" → check for "cries" near the name
            const verbM = phrase.match(/\b(?:Never|Won't|Doesn't|Does not|Will not)\s+(\w+)/i);
            if (!verbM) continue;
            const verb = verbM[1].toLowerCase();
            // Conjugate roots: cry → cries/cried/crying
            const verbStems = new Set([verb, verb + 's', verb + 'ed', verb + 'ing', verb.replace(/y$/, 'ies'), verb.replace(/y$/, 'ied')]);
            // Look for `name` and a stem within 60 chars
            const nameRx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b[\\s\\S]{0,60}\\b(${[...verbStems].join('|')})\\b`, 'i');
            if (nameRx.test(text)) {
                const msg = `Persona slip: ${name} did "${verb}" — forbidden by their persona ("${phrase}")`;
                const already = s._contradictions.some(c => c.turn === turn && c.message === msg);
                if (!already) s._contradictions.push({ turn, type: 'persona_drift', message: msg });
            }
        }
    }
}


// ── C.1: Rolling Chat Summarizer ─────────────────────────────
const SUMMARIZE_INTERVAL = 15;

function maybeSummarize(s) {
    const turn = s._turnCount || 0;
    if (!s._summaries) s._summaries = [];
    const lastEndTurn = s._summaries.length ? s._summaries[s._summaries.length - 1].endTurn : 0;
    const turnsSince = turn - lastEndTurn;

    // ── v4.1 A.6: Smart triggers — summarise sooner if scene completed ──
    // Hard floor: don't summarise more than once per 4 turns to avoid spam.
    if (turnsSince < 4) return;
    const curLoc = s.map?.currentLocation || s.location || '';
    const locChanged = curLoc && s._lastSummaryLocation && curLoc !== s._lastSummaryLocation;
    const recentQuestComplete = (s._stateChangelog || []).some(e =>
        e.turn > lastEndTurn && e.field?.startsWith('quest.') && /complete|fail/i.test(String(e.to||''))
    );
    const combatJustEnded = !s.combat?.active && (s._stateChangelog || []).some(e =>
        e.turn > lastEndTurn && e.turn >= turn - 1 && e.field === 'combat.active' && e.from === true
    );
    const smartTrigger = locChanged || recentQuestComplete || combatJustEnded;
    // Fall back to the normal interval if no scene-end signal
    if (!smartTrigger && turnsSince < SUMMARIZE_INTERVAL) return;
    s._lastSummaryLocation = curLoc;
    s._lastSummaryTurn = turn;

    const startTurn = lastEndTurn;
    const endTurn = turn;
    const lines = [];

    // Location travel in this period
    const locChanges = (s._stateChangelog||[]).filter(e => e.field === 'location' && e.turn >= startTurn && e.turn < endTurn);
    if (locChanges.length) {
        const visited = [...new Set(locChanges.map(e => e.to).filter(Boolean))];
        if (visited.length) lines.push(`Visited: ${visited.join(' → ')}`);
    }

    // Quest status changes
    const questChanges = (s._stateChangelog||[]).filter(e => e.field.startsWith('quest.') && e.turn >= startTurn && e.turn < endTurn);
    for (const qc of questChanges) {
        const qid = qc.field.replace('quest.','');
        lines.push(`Quest "${qid}": ${qc.from||'started'} → ${qc.to}`);
    }

    // Significant relationship changes (logged by applyJsonBlock)
    const relChanges = (s._stateChangelog||[]).filter(e => e.field.startsWith('npcs.') && e.turn >= startTurn && e.turn < endTurn);
    for (const rc of relChanges) {
        const delta = (rc.to||0) - (rc.from||0);
        lines.push(`${rc.field.replace('npcs.','').replace('.',' ')}: ${rc.from||0}→${rc.to||0} (${delta>0?'+':''}${delta})`);
    }

    // Flag changes
    const flagChanges = (s._stateChangelog||[]).filter(e => e.field.startsWith('flag.') && e.turn >= startTurn && e.turn < endTurn);
    for (const fc of flagChanges) {
        lines.push(`Flag ${fc.field.replace('flag.','')} → ${fc.to}`);
    }

    // Journal notes from this period
    const notes = (s.notes||[]).filter(n => (n.turn||0) >= startTurn && (n.turn||0) < endTurn && !n.text.startsWith('[Parse'));
    for (const n of notes.slice(0, 5)) lines.push(`• ${n.text}`);

    if (lines.length > 0) {
        s._summaries.push({ startTurn, endTurn, lines });
        if (s._summaries.length > 10) s._summaries = s._summaries.slice(-10);
        console.log(`[st-rpg-hud] C.1: Generated summary for turns ${startTurn}–${endTurn} (${lines.length} entries)`);
    }
}

function processMessage(text) {
    const s = getState();
    let ch = false;

    // Fallback: parse backtick status line
    try { ch = parseStatusLine(text, s) || ch; } catch(e) { console.warn('[st-rpg-hud] statusLine parse error', e); }

    const parsed = hudContent(text);
    if (parsed !== null) {
        const { type, content } = parsed;
        try {
            if (type === 'json') {
                // Primary format: ```rpg {...} ``` — uses robustJsonParse to
                // tolerate comments, trailing commas, escape mistakes, and
                // truncation (streaming cutoff).
                let data, recovered = false, repairAttempts = 0;
                try {
                    const result = robustJsonParse(content);
                    data = result.data;
                    recovered = result.recovered;
                    repairAttempts = result.repairAttempts;
                } catch (err) {
                    // Suppress raw error spam in Journal; log warning + a single
                    // condensed Journal note instead of the full JSON.parse text.
                    s._parseMisses = (s._parseMisses || 0) + 1;
                    s._contradictions = s._contradictions || [];
                    s._contradictions.push({
                        turn: s._turnCount || 0,
                        type: 'parse_error_unrecoverable',
                        message: `rpg block could not be parsed (turn ${s._turnCount||0}): ${String(err.message||err).slice(0, 120)}`
                    });
                    console.warn('[st-rpg-hud] Unrecoverable rpg block parse failure:', err);
                    // No state mutation — just count the miss and move on.
                    ch = true; // persist the contradiction record
                    data = null;
                }

                if (data) {
                    if (recovered) {
                        console.log(`[st-rpg-hud] rpg block recovered after ${repairAttempts} repair pass(es)`);
                    }
                    ch = applyJsonBlock(data, s) || ch;
                }
            } else {
                // Legacy XML format (fallback)
                // IMPORTANT: use `fn() || ch` not `ch || fn()` — avoids short-circuit skipping parsers
                ch = applyTag(scanTags("STAT", content), s) || ch;
                ch = applySkills(scanTags("SKILL", content), s) || ch;
                ch = applyStatuses(scanTags("STATUS", content), s) || ch;
                ch = applyItems(scanTags("ITEM", content), s) || ch;
                ch = applyParty(scanTags("PARTY", content), s) || ch;
                ch = applyQuests(scanTags("QUEST", content), s) || ch;
                ch = applyLoc(scanTags("LOC", content), s) || ch;
                ch = applyNpcs(scanTags("NPC", content), s) || ch;
                ch = applyCombat(scanTags("COMBAT", content), s) || ch;
                ch = applyOutfits(scanTags("OUTFIT", content), s) || ch;
                ch = applyFactions(scanTags("FACTION", content), s) || ch;
                ch = applyTime(scanTags("TIME", content), s) || ch;
                ch = applyFlags(scanTags("FLAG", content), s) || ch;
                ch = applyNpcRels(scanTags("NPC_REL", content), s) || ch;
                for (const { a, inner } of scanTags("NOTE", content)) {
                    const t = a.text || a.content || inner || "";
                    if (t.trim()) { s.notes.push({ text:t.trim(), ts:Date.now() }); ch=true; }
                }
                for (const { a } of scanTags("CHECK", content)) {
                    if (a.stat || a.skill) showDiceOverlay(a.stat||a.skill, parseInt(a.dc||"10"), parseInt(a.modifier||"0"));
                }
            }
        } catch(e) {
            // Phase 1: condensed parse-error logging — no raw error text in Journal.
            console.error("[st-rpg-hud] parse error", e);
            s._parseMisses = (s._parseMisses || 0) + 1;
            s._contradictions = s._contradictions || [];
            s._contradictions.push({
                turn: s._turnCount || 0,
                type: 'parse_error_in_handler',
                message: `Handler error (turn ${s._turnCount||0}): ${String(e.message||e).slice(0, 120)}`
            });
            ch = true;
        }
    }

    // ── v5: VIR contradiction scan on raw prose ──
    try { runVirScan(text, s); } catch(e) { console.warn('[st-rpg-hud] VIR scan error', e); }

    // ── v4.1: B.2 STATS UPDATE bridge ─────────────────────────────────────
    try { applyStatsUpdateBlock(text, getState()); } catch(e) { console.warn('[st-rpg-hud] STATS UPDATE parse error', e); }

    // ── v4.1: Persona drift detection ─────────────────────────────────────
    try { runPersonaDriftScan(text, getState()); } catch(e) { console.warn('[st-rpg-hud] persona drift scan error', e); }

    // ── v5: Format-miss detection ──
    // If message is substantive (>80 words) but produced no parseable rpg block, log it
    if (parsed === null) {
        const wordCount = text.trim().split(/\s+/).length;
        if (wordCount > 80) {
            s._parseMisses = (s._parseMisses || 0) + 1;
            s._contradictions = s._contradictions || [];
            s._contradictions.push({
                turn: s._turnCount || 0,
                type: 'parse_miss',
                message: `No \`\`\`rpg block found in ${wordCount}-word response (miss #${s._parseMisses})`
            });
            console.warn(`[st-rpg-hud] Parse miss #${s._parseMisses} — no rpg block in ${wordCount}-word response`);
            ch = true; // save state so _parseMisses is persisted
        }
    }

    // ── C.1: Maybe generate a rolling summary ──
    try { maybeSummarize(s); } catch(e) { console.warn('[st-rpg-hud] summarize error', e); }

    // ── A.5: Sync off-scene NPCs to keyword-gated lorebook (async, fire-and-forget) ──
    try { syncOffsceneNpcs(s); } catch(e) { console.warn('[st-rpg-hud] A.5: sync error', e); }

    if (ch) { s.initialized = true; saveState(); }
    return !!ch;
}


// ── Context injection ─────────────────────────────────────────
// Single unified reminder. Injected as IN_PROMPT (system prompt level, top of
// system block) so all models see it as authoritative. Covers the V6 preset-
// aligned schema (vir/vir_changes/scene_state/outfit_change with full nested
// objects + roster persistence) PLUS all the v5 fields the HUD's handlers
// consume (facts/charInner/charExternal/charDev/mindset/vad/relationships/
// secrets/open_threats/topics/world_flags/scene_objects/personas/keyMoments/
// active_goal) PLUS the 10 validation rules (VIR LOCK, FACT LOCK, PERSONA,
// DELTA LIMITS, RANGE, CONTINUITY, OUTFIT, rel_event, active_goal, scene_objects).
// ── A.3 + A.1: Three FORMAT_REMINDER sizes for adaptive injection ────────────
// MINIMAL (~30 tokens): steady-state default — delta-only output, no schema
// STANDARD (~150 tokens): condensed field reference — used after parse miss
// FULL (~600 tokens): complete schema — first turn, init, or repeated misses
//
// pickFormatReminder(s) chooses the right size each turn based on:
//   - state.initialized          (first-turn always gets FULL)
//   - state._parseMisses         (escalate when AI keeps skipping the block)
//   - state._lastFullEchoTurn    (every N turns request a full echo)
//   - cfg.opts.adaptiveReminder  (master toggle)
// When adaptiveReminder is off, behaviour matches v3 (FULL every turn).

const FORMAT_REMINDER_MINIMAL = `[RPG STATE TRACKER]
End every reply with a \`\`\`rpg\`\`\` JSON block (no comments, no trailing commas).
DELTA-ONLY MODE: emit ONLY fields that CHANGED this turn. The HUD merges deltas into stored state. Unchanged fields are kept as-is.
ALWAYS include: vitals, location (if changed), active_goal. Use rel_event when trust/affection/fear change by >3.
[END]`.trim();

const FORMAT_REMINDER_STANDARD = `[RPG STATE TRACKER — condensed]
End every reply with a \`\`\`rpg\`\`\` JSON block (valid JSON, NO comments, NO trailing commas).
DELTA-ONLY MODE: emit ONLY fields that CHANGED this turn — the HUD merges deltas into persisted state.

Schema (only the fields you are updating):
  vitals{hp:[v,max],mp:[v,max]} | resources{gold,exp} | location | time{day,hour,period}
  combat{active,turn,ap,ap_max,enemy} | statuses[{id,name,type,turns,action}]
  npcs[{name,role,disposition,trust,affection,fear,outfit,note,current_goal,people_here}]
  quests[{id,action:add|step|complete|fail,title,desc,step}] | inventory[{name,action,qty,slot}]
  vir{<name>:{...nested-object form}} | vir_changes{<name>:{path:value}}
  facts[{id,text,priority}|{id,action:"remove"}] | scene_objects[{id,name,desc,location,action}]
  charInner{health,moral,confidence,shame,promiscuity,arousal,dependence,love}
  mindset{mood,thoughts} | personas{<name>:{voice,core_belief,forbidden,goals,quirks}}
  active_goal:"string"  (REQUIRED every turn)
  rel_event:"string"   (REQUIRED when trust/affection/fear change by >3)
  key_moment:"string"  (only for pivotal beats, max 1/turn)

Limits: trust ±15, affection ±12, love ±10, arousal ±30, fear ±15. charInner 0–100. vitals 0..max.
[END]`.trim();

const FORMAT_REMINDER_FULL = `
[SYSTEM: RPG STATE TRACKER — unified schema, MANDATORY]
EVERY response MUST end with a \`\`\`rpg code block (valid JSON, NO comments, NO trailing commas).

═══ CHARACTER ROSTER (preset-aligned VIR) ═══
vir{<name>: { active, status, species_class, species_subtype, humanoid_ratio, franchise,
              age_appearance, height,
              hair{length,style,texture,color_shade,highlights,parting,bangs,default_accessories[]},
              facial_hair{state,color,length,grooming},
              eyes{color,shape,pupil_type,heterochromia,eyelash_density,eyebrow_style,default_gaze},
              skin{tone,undertone,texture,body_hair,pubic_style},
              body{archetype,silhouette,weight_class,muscle_definition,frame,bust,waist_to_hip,posture,hand_traits,foot_traits},
              limb_config{arm_count,leg_count,missing[],prosthetic[],extra_limbs[],mobility_state},
              non_human{tail,wings,horns,compound_eyes,mandibles,antennae,exoskeleton_zones[],scale_zones[],fur_zones[],feather_zones[],claws,fangs,magical_marks[],augments[]},
              marks{scars[],tattoos[],birthmarks[],freckles{},moles[],piercings[],brands[],ritual_marks[]},
              outfit[{slot,item_type,exact_color_shade,material,cut_or_style,fit,distinguishing_detail,condition}],
              accessories[{type,metal_or_material,stone_or_color,detail}],
              equipment[{type,subparts{},sigil,condition,position}] }}
vir_changes{<name>: {<dotted.path>: <new value>}}        // delta of locked-field mutations this turn
scene_state{ perCharacter:{<name>: {hair_state,exertion_state,injuries,outfit_damage,hand_contents,makeup_state,gaze_target,body_state}},
             sceneWide:{key_light,rim_light,ambient,palette,atmosphere,camera_baseline} }
outfit_change{<name>: {removed:[{slot,item_type}], added:[<full piece object>]}}

ROSTER RULES (strict):
  • Once introduced, every character persists in vir{} forever — NEVER drop.
  • Off-scene → active:false. Death → status:"deceased". Re-entry → flip active:true, copy verbatim.
  • State change (haircut, shave, new scar, outfit replace) → mutate the field IN PLACE in vir AND emit vir_changes delta.
  • Outfit pieces locked across turns. Add/remove only with prose beat + outfit_change delta.
  • The OLD flat-string vir form ({"hair":"brown","outfit":"red dress"}) is FORBIDDEN — always use the nested-object form above.

═══ CORE STATE ═══
vitals{"hp":[v,max], "mp":[v,max], ...}        // numeric resources with caps
attrs{"str":12, "dex":14, ...}                  // attributes
resources{"gold":50, ...}                        // misc named resources
location: "Place | Region"                       // current scene location
time: {day, hour, period, season, date}
combat{"active":bool, "turn":n, "ap":n, "ap_max":n, "enemy":"..."}
inventory: [{"name":"Item", "action":"add|equip|remove|use", "qty":1, "slot":"...", "rarity":"..."}]
party: [{"name":"Ally", "hp":100, "trust":50, ...}]   // combat stats; relationship via npcs[] is preferred
npcs: [{"name":"X","role":"...","disposition":"...","trust":n,"affection":n,"fear":n,"respect":n,"hostility":n,"gratitude":n,"note":"...","outfit":"...","location":"...","current_goal":"...","hidden_agenda":"...","loyalty_threshold":60,"people_here":bool}]
quests: [{"id":"q1","title":"...","desc":"...","action":"add|step|complete|fail","step":"..."}]
factions, npc_relations, flags, statuses, skills, landmarks — as before.
note: "..."                                      // optional Journal entry for this turn

═══ TIER-1 NARRATIVE ANCHORS (REQUIRED EVERY TURN) ═══
active_goal: "string"                            // current scene objective, one sentence
key_moment: "string"                             // ONLY when a defining beat happened (max 1/turn)
rel_event: "string"                              // REQUIRED when trust/affection/fear changes by >3

═══ V5 RICH STATE (use as relevant) ═══
facts: [{"id":"f1","text":"...","priority":"critical|high|normal"} | {"id":"f1","action":"remove"}]
personas: {"Name":{"voice":"..","core_belief":"..","fears":"..","goals":"..","quirks":"..","forbidden":"..","speech_example":".."}}
scene_objects: [{"id":"o1","name":"..","desc":"..","location":"..","action":"add|remove","reason":".."}]
charInner: {"health":80,"moral":60,"confidence":55,"shame":20,"promiscuity":30,"arousal":15,"dependence":10,"love":5}
charExternal: {"name":"..","hair":"..","makeup":"..","outfit":"..","stateOfDress":"..","postureAndInteraction":".."}
charDev: {"oral":0,"breasts":0,"masochism":0,"caressing":0,"vagina":0,"anus":0,"nipples":0,"clitoris":0}
mindset: {"mood":"anxious","thoughts":"..."}
vad: {"CharName":{"valence":40,"arousal":60,"dominance":35}}
relationships: {"CharName":{"trust":65,"flags":["saved_my_life","knows_my_secret"]}}
secrets: [{"id":"s1","title":"..","text":"..","revealed":bool}]
open_threats: [{"source":"..","nature":"..","trigger":".."}]
topics: {"genre":"..","primaryTopic":"..","emotionalTone":"..","interactionTheme":".."}
world_flags: {"flagName":{value:bool,label:".."}}

═══ VALIDATION RULES (enforced) ═══
1. VIR LOCK — Never describe appearance differently from the established vir{} entry. Mutate ONLY via vir{} (full re-emit) or vir_changes{} (delta path). The roster never shrinks.
2. FACT LOCK — Never contradict critical/high facts. Remove via facts:[{"id":"f1","action":"remove"}].
3. PERSONA — Follow [PERSONA] blocks exactly. The 'forbidden' field is a hard limit. Update only on narrated story growth.
4. DELTA LIMITS (per turn — auto-clamped):
   trust ±15 | affection ±12 | love ±10 | moral ±8 | confidence ±20 | arousal ±30 | shame ±20 | fear ±15 | other charInner ±15
5. RANGE — charInner: 0–100. charDev: 0–100. Vitals: 0..max only. Relationship fields: -100..+100.
6. CONTINUITY — keyMoments are crystallized; do not contradict them.
7. OUTFIT GRANULARITY — Every outfit piece needs COLOR+MATERIAL+CUT+DETAIL+CONDITION (preset's pic_rpg_format_hooks rule). Use the structured outfit[] array form, not free-text.
8. rel_event — Required when trust/affection/fear changes by >3.
9. active_goal — Required EVERY turn; one sentence, current scene objective.
10. scene_objects — Persist all props until explicitly removed.

═══ JSON HYGIENE ═══
DO NOT include /* block comments */ or // line comments inside the JSON — strict parsers reject them.
DO NOT include trailing commas after the last array/object element.
DO escape literal newlines inside strings (use \\n).
[END SYSTEM]`.trim();

// ── A.3: Choose the right FORMAT_REMINDER size for this turn ─────────────────
function pickFormatReminder(s) {
    const cfg = getCFG();
    if (!cfg.opts.adaptiveReminder) return FORMAT_REMINDER_FULL;       // legacy

    const tc      = s._turnCount || 0;
    const misses  = s._parseMisses || 0;
    const initd   = !!s.initialized;

    // First turn of chat OR not yet initialized → full schema
    if (!initd || tc === 0) return FORMAT_REMINDER_FULL;
    // 3+ misses in a row → full reminder to recover
    if (misses >= 3) return FORMAT_REMINDER_FULL;
    // 1–2 misses → condensed schema
    if (misses >= 1) return FORMAT_REMINDER_STANDARD;
    // Steady state → minimal
    return FORMAT_REMINDER_MINIMAL;
}

// ── B.3: Heartbeat / full-echo gate ──────────────────────────────────────────
// Returns true when the AI should be asked to emit the full state echo this
// turn (not a delta). Triggers every `heartbeatInterval` turns, after any
// parse miss, or when state was reset/loaded.
function shouldRequestFullEcho(s) {
    const cfg = getCFG();
    if (!cfg.opts.deltaOnly) return true; // delta-only off → always full
    const tc       = s._turnCount || 0;
    const lastEcho = s._lastFullEchoTurn || 0;
    const misses   = s._parseMisses || 0;
    const interval = Math.max(2, cfg.opts.heartbeatInterval || 10);
    if (!s.initialized) return true;
    if (misses > 0) return true;
    if (tc - lastEcho >= interval) return true;
    return false;
}

function buildContext(s) {
    const cfg = getCFG();
    const budget = cfg.opts?.budget || "standard";

    // A.3: Adaptive reminder + A.1: delta-only / full-echo signalling
    const reminder = pickFormatReminder(s);
    const fullEchoRequested = shouldRequestFullEcho(s);

    const lines = [reminder, ""];
    if (cfg.opts.deltaOnly && !fullEchoRequested) {
        lines.push("=== STATE SNAPSHOT (delta-only mode — emit ONLY changed fields in your ```rpg block) ===");
    } else {
        lines.push("=== CURRENT RPG STATE (FULL ECHO requested this turn — reproduce ALL fields in your ```rpg block) ===");
        if (cfg.opts.deltaOnly && fullEchoRequested) {
            lines.push("FULL_ECHO_REQUESTED: true   // heartbeat checkpoint — emit complete state once, then return to delta-only");
        }
    }
    if (!s.initialized) {
        lines.push("STATUS: Not yet initialized. On your FIRST response, establish the complete starting state.");
    }

    // ── B.4: Active goal as SCENE ANCHOR — top of TIER 1, before vitals ──
    // Recency-anchor the current scene objective so it's the freshest piece of
    // state context the model sees when planning the next reply.
    if (s.active_goal) {
        lines.push(`[ACTIVE GOAL → ${s.active_goal}]`);
    }

    // Always include vitals (AI must echo these every response for consistency)
    const vArr = Object.entries(s.vitals||{}).map(([id,v])=>`${v.name||id}=${v.value}${v.max!=null?"/"+v.max:""}`);
    if (vArr.length) lines.push("Vitals: "+vArr.join(" | "));

    if (s.combat?.active) lines.push(`⚔ COMBAT: Turn ${s.combat.turn}, AP ${s.combat.ap}/${s.combat.ap_max}${s.combat.enemy?", vs "+s.combat.enemy:""}`);

    // A.2: Determine if we should suppress heavy sections this turn.
    // When tiered + delta-only + not full-echo: emit only TIER 1 + scene TIER 2.
    // Heavy sections (relationship history, charDev/charInner detail, story
    // summaries, VAD, key moments overflow) skipped — they're rebuilt from
    // persisted state, the AI doesn't need to re-see them every turn.
    const tieredLight = cfg.opts.tieredInjection && cfg.opts.deltaOnly && !fullEchoRequested;

    // Location — always include
    const loc = s.map?.currentLocation||s.location||"Unknown";
    const reg = s.map?.region&&s.map.region!=="Unknown"?" ("+s.map.region+")":"";
    lines.push("Location: "+loc+reg);
    if (s.map?.landmarks?.length) lines.push("Known Landmarks: "+s.map.landmarks.map(l=>l.name+(l.note?" — "+l.note:"")).join("; "));

    // Time
    if (s.time?.dateStr) lines.push("Time: "+s.time.dateStr);
    else if (s.time?.season&&s.time.season!=="Unknown") lines.push(`Time: Day ${s.time.day}, ${s.time.period} (${s.time.season})`);

    // Outfit
    const activeOutfits = (s.outfits||[]).filter(o=>o.active);
    if (activeOutfits.length) lines.push("Wearing: "+activeOutfits.map(o=>o.name+(o.desc?" — "+o.desc:"")).join("; "));

    // Equipped items
    const eq = (s.inventory||[]).filter(i=>i.equipped).map(i=>`${i.slot}:${i.name}`);
    if (eq.length) lines.push("Equipped: "+eq.join(", "));

    // Status effects
    if (s.statuses?.length) lines.push("Status Effects: "+s.statuses.map(x=>x.name||x.id).join(", "));

    // Active quests
    const aq = (s.quests||[]).filter(q=>q.status==="active");
    if (aq.length) lines.push("Active Quests: "+aq.map(q=>`[${q.id||q.title}] ${q.title}`).join(" | "));

    // All known NPCs — scene NPCs get full detail; off-scene get one line
    if (s.npcs?.length) {
        const peopleHere = s.map?.peopleHere || [];
        const sceneNpcs = peopleHere.length
            ? s.npcs.filter(n => peopleHere.includes(n.name))
            : s.npcs;
        const offSceneNpcs = peopleHere.length
            ? s.npcs.filter(n => !peopleHere.includes(n.name))
            : [];

        lines.push("Known NPCs (re-output these with current values):");
        for (const n of sceneNpcs) {
            const relParts = ["trust","affection","fear","respect","hostility"].filter(f=>n[f]!==undefined&&n[f]!==0).map(f=>`${f}=${n[f]}`);
            const outfitPart = n.outfit ? ` | wearing: ${n.outfit}` : "";
            const goalPart = n.current_goal ? ` | GOAL: ${n.current_goal}` : "";
            const lastSeenPart = n.lastSeenAt && n.lastSeenAt !== s.map?.currentLocation
                ? ` [last seen: ${n.lastSeenAt} T${n.lastSeenTurn||"?"}${n.exitState?", "+n.exitState:""}]` : "";
            // D.2: Reveal hidden_agenda when trust meets threshold
            const trustVal = n.trust ?? 0;
            const threshold = n.loyalty_threshold ?? 60;
            const agendaPart = n.hidden_agenda && trustVal >= threshold
                ? ` | REVEALED AGENDA: ${n.hidden_agenda}` : "";
            lines.push(`  - ${n.name} (${n.role||"?"}, ${n.disposition||"neutral"})${relParts.length?" ["+relParts.join(", ")+"]":""}${outfitPart}${goalPart}${agendaPart}${lastSeenPart}: ${n.note||""}`);
        }
        // A.5: When offSceneToLorebook is enabled, off-scene NPCs are written
        // to keyword-gated lorebook entries instead of injected here. Skip the
        // inline list entirely. When the toggle is off, fall back to v3 behaviour.
        if (offSceneNpcs.length && budget !== "compact" && !cfg.opts.offSceneToLorebook) {
            lines.push("  Off-scene: "+offSceneNpcs.map(n=>`${n.name}(${n.disposition||"neutral"}, trust=${n.trust||0})`).join(", "));
        }
    }

    // ── E.3: NPC Name Anchors ──
    const anchors = (s.npcs||[]).filter(n => n.aliases?.length || n.forbidden_names?.length);
    if (anchors.length) {
        lines.push('\n[NAME ANCHORS — Always use these exact names in prose and rpg block]');
        for (const n of anchors) {
            const also = n.aliases?.length ? ` — also called: ${n.aliases.join(", ")}` : "";
            const forbidden = n.forbidden_names?.length ? ` — NEVER call them: "${n.forbidden_names.join('", "')}"` : "";
            lines.push(`  • "${n.name}"${also}${forbidden}`);
        }
    }

    if (budget !== "compact") {
        const atArr = Object.entries(s.attributes||{}).map(([id,a])=>`${a.name||id}:${a.value}`);
        if (atArr.length) lines.push("Attributes: "+atArr.join(", "));
        const pArr = Object.entries(s.party||{}).map(([nm,p])=>`${nm}${p.hp!=null&&p.hp_max?` HP:${p.hp}/${p.hp_max}`:''}`);
        if (pArr.length) lines.push("Party (combat stats): "+pArr.join(", ")+" — relationships are in Known NPCs above");
        const facArr = Object.values(s.factions||{}).filter(f=>f.status!=="neutral");
        if (facArr.length) lines.push("Factions: "+facArr.map(f=>`${f.name}(${f.status}:${f.rep})`).join(", "));
    }
    if (s.skills?.length) lines.push("Skills: "+s.skills.map(x=>x.name||x.id+(x.level&&x.level!=="1"?" Lv"+x.level:"")).join(", "));
    const resArr = Object.entries(s.resources||{}).map(([id,r])=>`${r.name||id}:${r.value}`);
    if (resArr.length) lines.push("Resources: "+resArr.join(", "));
    const trueFlags = Object.entries(s.flags||{}).filter(([,f])=>f.value==="true"||f.value===true);
    if (trueFlags.length) lines.push("Story Flags: "+trueFlags.map(([,f])=>f.label||"?").join(", "));

    // ── v4: charInner key stats ──
    if (s.charInner && Object.keys(s.charInner).length) {
        const ci = s.charInner;
        const INNER_LABELS = {health:'HP',moral:'Moral',confidence:'Confidence',shame:'Shame',promiscuity:'Promiscuity',arousal:'Arousal',dependence:'Dependence',love:'Love'};
        const ciParts = Object.entries(INNER_LABELS).filter(([k])=>ci[k]!==undefined).map(([k,l])=>`${l}:${ci[k]}`);
        if (ciParts.length) lines.push("Inner Stats: "+ciParts.join(" | "));
    }

    // ── v4: mindset ──
    if (s.mindset?.mood) lines.push(`Mindset → Mood: ${s.mindset.mood}${s.mindset.thoughts?' | Thoughts: '+s.mindset.thoughts:''}`);

    // ── v4: charExternal (current appearance) ──
    if (s.charExternal && Object.keys(s.charExternal).length) {
        const ce = s.charExternal;
        const parts = [];
        if (ce.outfit) parts.push(`Outfit: ${ce.outfit}`);
        if (ce.stateOfDress) parts.push(`State: ${ce.stateOfDress}`);
        if (ce.hair) parts.push(`Hair: ${ce.hair}`);
        if (parts.length) lines.push("Appearance: "+parts.join(" | "));
    }

    // ── v4: topics / scene info ──
    if (s.topics) {
        const t = s.topics;
        const topicParts = [];
        if (t.genre) topicParts.push(`Genre:${t.genre}`);
        if (t.primaryTopic) topicParts.push(`Topic:${t.primaryTopic}`);
        if (t.emotionalTone) topicParts.push(`Tone:${t.emotionalTone}`);
        if (topicParts.length) lines.push("Scene: "+topicParts.join(" | "));
    }

    // ── v4: revealed secrets ──
    const revealedSecrets = (s.secrets||[]).filter(sec=>sec.revealed);
    if (revealedSecrets.length) lines.push("Revealed Secrets: "+revealedSecrets.map(sec=>sec.title||sec.id||"Secret").join(", "));

    // ── v4: open threats ──
    if (s.open_threats?.length) lines.push("Open Threats: "+s.open_threats.map(t=>`[${t.source||"?"}] ${t.nature||""}`).join(" | "));

    // ── v4: VIR Registry — B.1: gated by virMode ──
    // 'self'   → inject the full registry (legacy, default)
    // 'bridge' → skip injection, ff4-vir-lorebook-sync handles VIR entries
    // 'off'    → skip injection entirely (user has external system or none)
    // In tieredLight, even self-contained mode injects only scene characters'
    // VIR data — off-scene VIR lives in the lorebook (A.5).
    const virMode = resolvedVirMode();
    if (virMode === 'self' && s.vir && Object.keys(s.vir).length) {
        const peopleHere = s.map?.peopleHere || [];
        const virEntries = Object.entries(s.vir).filter(([name, traits]) => {
            if (!traits || traits.active === false) return false;
            // Light mode: only inject characters in current scene
            if (tieredLight && peopleHere.length && !peopleHere.includes(name)) return false;
            return true;
        });
        if (virEntries.length) {
            const virBlock = virEntries.map(([name, traits]) => {
                const fields = Object.entries(traits)
                    .filter(([k]) => k !== 'active' && k !== 'status' && !k.startsWith('_'))
                    .map(([k, v]) => `    ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join('\n');
                return `  [${name}]\n${fields}`;
            }).join('\n');
            lines.push(
                `\n[ACTIVE VIR REGISTRY — Authoritative visual traits. LOCKED against drift.` +
                ` Copy EXACTLY into every <pic prompt>. Only update via narrated story event + vir delta.]\n${virBlock}`
            );
        }
    }

    // ══ v5 ACCURACY INJECTIONS ══════════════════════════════════

    // ── v5: Adaptive urgency header — A.2: only in non-light mode ──
    // The minimal/standard FORMAT_REMINDER variants already cover the rules;
    // this extra header was a v3 reinforcement. Skip in tieredLight to save
    // tokens; restore on parse miss (which forces full-echo mode anyway).
    const tc = s._turnCount || 0;
    if (!tieredLight) {
        if (tc >= 30) {
            lines.push(`\n⚠️ CRITICAL REMINDER (Turn ${tc}): This is a long chat. Re-read [ACTIVE VIR REGISTRY], [ESTABLISHED FACTS], and all [PERSONA] blocks before writing. Do not drift from established traits.`);
        } else if (tc >= 10) {
            lines.push(`\n📌 Reminder (Turn ${tc}): Follow [PERSONA], [VIR], and [ESTABLISHED FACTS] exactly.`);
        }
    }

    // (B.4: active_goal moved to top of TIER 1 — see earlier in this function)

    // ── v5: Established Facts (pinned truths — never contradict) ──
    // Critical/high facts ALWAYS injected; normal facts gated by tieredLight.
    if (s.facts?.length) {
        const critFacts = s.facts.filter(f => f.priority === 'critical');
        const highFacts = s.facts.filter(f => f.priority === 'high');
        const normFacts = s.facts.filter(f => !f.priority || f.priority === 'normal');
        lines.push('\n[ESTABLISHED FACTS — LOCKED. Never contradict. Never reveal hidden facts prematurely.]');
        critFacts.forEach(f => lines.push(`  ⚠️ CRITICAL: ${f.text}`));
        highFacts.forEach(f => lines.push(`  📌 HIGH: ${f.text}`));
        if (!tieredLight) {
            normFacts.forEach(f => lines.push(`  • ${f.text}`));
        }
    }

    // ── v5: Persona cards — B.5: compact mode after first appearance ──
    // Strategy:
    //   - First time we see an NPC's persona in this chat → emit FULL card
    //     (voice + belief + forbidden + quirks + speech_example) and mark
    //     them in s._seenPersonas so future turns shrink to compact.
    //   - Subsequent turns → emit compact card (voice + forbidden ONLY).
    //   - After a parse miss (or compactPersona toggle off) → full again.
    if (s.personas && Object.keys(s.personas).length) {
        const peopleHere = s.map?.peopleHere || [];
        const personasToShow = Object.entries(s.personas).filter(([nm]) =>
            peopleHere.length === 0 || peopleHere.includes(nm)
        );
        if (personasToShow.length) {
            if (!s._seenPersonas) s._seenPersonas = {};
            const useCompact = cfg.opts.compactPersona && (s._parseMisses || 0) === 0;
            for (const [nm, p] of personasToShow) {
                const seen = s._seenPersonas[nm];
                const parts = [];
                if (useCompact && seen) {
                    // Compact form — just the dialogue/limit anchors
                    if (p.voice)     parts.push(`Voice: ${p.voice}`);
                    if (p.forbidden) parts.push(`FORBIDDEN: ${p.forbidden}`);
                } else {
                    // Full form — first appearance or recovery turn
                    if (p.voice)          parts.push(`Voice: ${p.voice}`);
                    if (p.core_belief)    parts.push(`Belief: ${p.core_belief}`);
                    if (p.forbidden)      parts.push(`FORBIDDEN: ${p.forbidden}`);
                    if (p.quirks)         parts.push(`Quirks: ${p.quirks}`);
                    if (p.speech_example) parts.push(`Example: "${p.speech_example}"`);
                    s._seenPersonas[nm] = true;
                }
                if (parts.length) lines.push(`\n[PERSONA: ${nm}]\n  ${parts.join('\n  ')}`);
            }
        }
    }

    // ── v5: Key moments (for characters in scene) — A.2: TIER-light skips ──
    // In light mode only the last 2 moments are injected; full mode keeps 5.
    if (s.keyMoments?.length) {
        const peopleHere = s.map?.peopleHere || [];
        const relevant = peopleHere.length
            ? s.keyMoments.filter(m => !m.characters?.length || m.characters.some(c => peopleHere.includes(c)))
            : s.keyMoments;
        const sliceN = tieredLight ? 2 : 5;
        const recent = relevant.slice(-sliceN);
        if (recent.length) {
            lines.push('\n[KEY MOMENTS — These have already happened. Do not contradict them.]');
            recent.forEach(m => lines.push(`  • (Turn ${m.turn}) ${m.text}`));
        }
    }

    // ── v5: Relationship history — A.2: skip history detail in light mode ──
    // In tieredLight: emit only current scores (no _history events).
    if (s.relationships && Object.keys(s.relationships).length) {
        const peopleHere = s.map?.peopleHere || [];
        const relEntries = Object.entries(s.relationships).filter(([nm]) =>
            peopleHere.length === 0 || peopleHere.includes(nm)
        );
        if (relEntries.length) {
            lines.push('\n[RELATIONSHIP CONTEXT]');
            for (const [nm, rel] of relEntries) {
                const scores = ['trust','affection','fear'].filter(f => rel[f] !== undefined).map(f => `${f}:${rel[f]}`).join(', ');
                const hist = tieredLight ? ''
                    : (rel._history || []).slice(-3).map(h => `${h.delta > 0 ? '+' : ''}${h.delta} ${h.field}${h.reason ? ` (${h.reason})` : ''}`).join(' | ');
                if (scores) lines.push(`  ${nm}: ${scores}${hist ? ' — History: ' + hist : ''}`);
            }
        }
    }

    // ── v5: Scene objects ──
    if (s.scene_objects?.length) {
        lines.push('\n[OBJECTS IN SCENE — These exist until explicitly removed via scene_objects action:"remove"]');
        s.scene_objects.forEach(o => lines.push(`  • ${o.name}${o.desc ? ' (' + o.desc + ')' : ''}${o.location ? ' — ' + o.location : ''}`));
    }

    // ── v5: Genre accuracy overlay ──
    const genre = s.topics?.genre;
    if (genre) {
        const GENRE_RULES = {
            horror:   `HORROR ACCURACY: Maintain dread tone. Track what characters know vs what player knows (info asymmetry). Established monster rules are LOCKED.`,
            romance:  `ROMANCE ACCURACY: Relationship progression must feel earned. Trust/love scores reflect real emotional intimacy. Never advance them without commensurate story moments.`,
            tactical: `TACTICAL ACCURACY: Combat outcomes must reflect stat values. HP changes must be tracked precisely. Enemy behavior must be consistent with their threat level.`,
            fantasy:  `FANTASY ACCURACY: Magic system rules once established are LOCKED facts. Track spell components and range limits.`,
            scifi:    `SCIFI ACCURACY: Technology rules once established are LOCKED. Track resource consumption and mechanical constraints.`,
        };
        if (GENRE_RULES[genre]) lines.push(`\n[${genre.toUpperCase()} ACCURACY RULE]\n${GENRE_RULES[genre]}`);
    }

    // ── v5: Parse-miss warning ──
    if (s._parseMisses > 0) {
        lines.push(`\n⚠️ PARSE MISS WARNING: In the last ${tc} turns, ${s._parseMisses} response(s) had no \`\`\`rpg block. This is an error. Every response MUST end with a \`\`\`rpg block.`);
    }

    // ── C.1: Story summaries — A.2: gated by tieredLight ──
    // In tieredLight, skip — summary is only useful when AI needs full context
    // for a fresh-start kind of turn (parse miss recovery, init).
    if (!tieredLight) {
        if (s._summaries?.length && budget === 'full') {
            lines.push('\n[STORY SO FAR — Compressed history of earlier events]');
            for (const sum of s._summaries) {
                lines.push(`  [Turns ${sum.startTurn}–${sum.endTurn}]`);
                sum.lines.forEach(l => lines.push(`    ${l}`));
            }
        } else if (s._summaries?.length && budget === 'standard') {
            const last = s._summaries[s._summaries.length - 1];
            lines.push(`\n[STORY SO FAR — Turns ${last.startTurn}–${last.endTurn}]`);
            last.lines.slice(0, 5).forEach(l => lines.push(`  ${l}`));
        }
    }

    // ══ v4.1 TIER 4 DYNAMIC CUES (immersion injections) ════════════════════
    // Small, situational, recency-anchored cues that fire only when the state
    // crosses a meaningful threshold. Each is ≤30 tokens. Together they keep
    // the AI's voice responsive to story shape without bloating context.

    // ── Tonal cue: time + genre + tone in one line ──
    const tonalBits = [];
    if (s.time?.period) tonalBits.push(s.time.period);
    if (s.combat?.active) tonalBits.push('combat imminent');
    if (s.topics?.emotionalTone) tonalBits.push(s.topics.emotionalTone);
    else if (s.mindset?.mood) tonalBits.push(`mood: ${s.mindset.mood}`);
    if (tonalBits.length) lines.push(`\n[TONE] ${tonalBits.join(' | ')}`);

    // ── NPC return callback: an NPC has just rejoined the scene after N+ turns away ──
    const peopleHere = s.map?.peopleHere || [];
    const returnCallbacks = [];
    for (const name of peopleHere) {
        const npc = (s.npcs||[]).find(n => n.name === name);
        if (!npc) continue;
        const lastSeen = s._npcLastSeenTurn?.[name];
        if (lastSeen === undefined) continue;
        const gap = (s._turnCount || 0) - lastSeen;
        if (gap >= 4) {
            const trustNote = npc.trust !== undefined ? ` trust=${npc.trust}` : '';
            const lastMoment = (s.keyMoments || []).filter(m => m.characters?.includes(name)).slice(-1)[0];
            const momentStr = lastMoment ? ` Last beat: "${lastMoment.text.slice(0,80)}"` : '';
            returnCallbacks.push(`  • ${name} returns after ${gap} turns away.${trustNote}.${momentStr}`);
        }
    }
    if (returnCallbacks.length) {
        lines.push('\n[NPC RETURN — re-establish their continuity in your reply]');
        returnCallbacks.forEach(l => lines.push(l));
    }

    // ── Stagnation nudge: active_goal hasn't changed in 5+ turns ──
    if (s.active_goal && s._goalStartedTurn) {
        const stale = (s._turnCount || 0) - s._goalStartedTurn;
        if (stale >= 5) {
            lines.push(`\n[PACING] Goal "${s.active_goal.slice(0,80)}" has been active for ${stale} turns. Consider an event that advances, complicates, or replaces it this turn.`);
        }
    }

    // ── Time-skip detection: large jump in time vs last turn ──
    if (s._lastTimeSnapshot && s.time) {
        const prevH = (s._lastTimeSnapshot.day || 0) * 24 + (s._lastTimeSnapshot.hour || 0);
        const nowH  = (s.time.day || 0) * 24 + (s.time.hour || 0);
        const gapH  = nowH - prevH;
        if (gapH >= 6) {
            const desc = gapH >= 48 ? `${Math.floor(gapH/24)} days` : `${gapH} hours`;
            lines.push(`\n[TIME ELAPSED: ${desc}] Off-scene NPCs progressed during the gap — untreated wounds worsened, training advanced, supplies dwindled. Reflect this in the reply if relevant.`);
        }
    }

    // ── Relationship milestone callbacks: trust/affection crossed a tier ──
    const MILESTONE_TIERS = [25, 50, 75, 90];
    const MILESTONE_LABELS = {
        25: 'tolerated', 50: 'trusted companion', 75: 'close ally', 90: 'devoted bond'
    };
    if (!s._milestonesHit) s._milestonesHit = {};
    const milestoneLines = [];
    for (const npc of (s.npcs || [])) {
        for (const field of ['trust','affection']) {
            const v = npc[field];
            if (typeof v !== 'number') continue;
            for (const tier of MILESTONE_TIERS) {
                const key = `${npc.name}|${field}|${tier}`;
                if (v >= tier && !s._milestonesHit[key]) {
                    s._milestonesHit[key] = s._turnCount || 0;
                    milestoneLines.push(`  • ${npc.name}'s ${field} crossed ${tier} — they are now ${MILESTONE_LABELS[tier]}. Their behaviour should shift visibly.`);
                }
            }
        }
    }
    if (milestoneLines.length) {
        lines.push('\n[MILESTONE — relationship threshold crossed this turn]');
        milestoneLines.forEach(l => lines.push(l));
    }

    // ── Scene transition cue: location just changed ──
    const curLoc = s.map?.currentLocation || s.location;
    if (curLoc && s._lastLocation && curLoc !== s._lastLocation) {
        lines.push(`\n[NEW SCENE: ${curLoc}] Open the scene with sensory detail — sight, smell, sound, temperature. Establish the place before action.`);
    }

    // ── NPC initiative reminder (always-on, very short) ──
    if (peopleHere.length) {
        lines.push(`\n[NPC INITIATIVE] NPCs in scene pursue their current_goal proactively. They act on their own agenda; they don't wait to be addressed.`);
    }

    // ── C.6: Per-chat rule overlay ──
    if (s._ruleOverlay && s._ruleOverlay.trim()) {
        lines.push(`\n[CHAT RULE OVERLAY]\n${s._ruleOverlay.trim()}`);
    }

    // ══════════════════════════════════════════════════════════════════════

    lines.push("\n=== END STATE ===");

    // ── Update tracking snapshots for next turn's cues ──
    // (Done here so we capture this turn's state for next-turn comparison)
    s._lastLocation = curLoc || s._lastLocation;
    if (s.time) s._lastTimeSnapshot = { day: s.time.day, hour: s.time.hour };

    return lines.join("\n");
}

// ── A.5: Off-scene NPC keyword-gated lorebook entries ────────────────────────
// Lazily imports world-info.js. Writes one lorebook entry per off-scene NPC,
// keyed on their name (case-insensitive). Entries cost zero tokens until the
// AI or the player mentions the NPC by name — same model as ff4-vir's
// OFFSCREEN tier. Returns silently if the world-info module can't be loaded.

let _wiAPI = null;            // cached world-info module exports
let _wiLoadFailed = false;    // true once we've tried and failed
const OFFSCENE_WORLD_PREFIX = 'RPG-HUD-Offscene-';

async function loadWorldInfoAPI() {
    if (_wiAPI || _wiLoadFailed) return _wiAPI;
    try {
        const mod = await import('../../../world-info.js');
        if (mod && typeof mod.loadWorldInfo === 'function' && typeof mod.saveWorldInfo === 'function') {
            _wiAPI = mod;
        } else {
            _wiLoadFailed = true;
        }
    } catch (e) {
        console.warn('[st-rpg-hud] A.5: world-info.js import failed — offscene NPC lorebook disabled.', e);
        _wiLoadFailed = true;
    }
    return _wiAPI;
}

function offsceneWorldName() {
    const chatId = getChatId();
    return OFFSCENE_WORLD_PREFIX + String(chatId).replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
}

function buildOffsceneNpcEntry(name, npc) {
    const parts = [];
    parts.push(`[NPC: ${name}] — currently off-scene`);
    if (npc.role)         parts.push(`Role: ${npc.role}`);
    if (npc.disposition)  parts.push(`Disposition: ${npc.disposition}`);
    const relParts = ['trust','affection','fear','respect','hostility'].filter(f => npc[f] !== undefined && npc[f] !== 0).map(f => `${f}=${npc[f]}`);
    if (relParts.length)  parts.push(`Relationship: ${relParts.join(', ')}`);
    if (npc.outfit)       parts.push(`Wearing: ${npc.outfit}`);
    if (npc.current_goal) parts.push(`Goal: ${npc.current_goal}`);
    if (npc.lastSeenAt)   parts.push(`Last seen: ${npc.lastSeenAt}${npc.lastSeenTurn ? ' (turn '+npc.lastSeenTurn+')' : ''}`);
    if (npc.note)         parts.push(`Note: ${npc.note}`);
    return parts.join('\n');
}

async function syncOffsceneNpcs(s) {
    const cfg = getCFG();
    if (!cfg.opts.offSceneToLorebook) return;
    if (!isEnabled()) return;
    if (!Array.isArray(s.npcs) || !s.npcs.length) return;

    const wi = await loadWorldInfoAPI();
    if (!wi) return;

    const worldName = offsceneWorldName();
    const peopleHere = s.map?.peopleHere || [];
    const offSceneNpcs = peopleHere.length
        ? s.npcs.filter(n => n.name && !peopleHere.includes(n.name))
        : [];

    // Skip when nothing changed since last sync (light heuristic)
    if (!s._lorebookOffscene) s._lorebookOffscene = {};
    const currentOffscene = new Set(offSceneNpcs.map(n => n.name));
    const tracked = new Set(Object.keys(s._lorebookOffscene));
    const noChange = currentOffscene.size === tracked.size
        && [...currentOffscene].every(n => tracked.has(n));
    if (noChange && offSceneNpcs.every(n => {
        const meta = s._lorebookOffscene[n.name];
        return meta && meta.lastTurn === (s._turnCount || 0);
    })) {
        return;
    }

    let data;
    try {
        data = await wi.loadWorldInfo(worldName);
    } catch(e) { data = null; }

    if (!data || !data.entries) {
        // Create a fresh world; world-info will lazily persist when we save
        data = { entries: {} };
    }

    // Build a name → entry index from existing entries
    const byName = {};
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (!entry || !entry.comment) continue;
        const m = entry.comment.match(/^NPC:\s*(.+)/i);
        if (m) byName[m[1].trim().toLowerCase()] = { uid, entry };
    }

    let dirty = false;

    // Upsert off-scene NPC entries
    for (const npc of offSceneNpcs) {
        if (!npc.name) continue;
        const key = npc.name.toLowerCase();
        const content = buildOffsceneNpcEntry(npc.name, npc);
        const existing = byName[key];
        if (existing) {
            if (existing.entry.content !== content) {
                existing.entry.content = content;
                existing.entry.key = [npc.name, ...(npc.aliases || [])];
                existing.entry.disable = false;
                dirty = true;
            }
            s._lorebookOffscene[npc.name] = { uid: existing.uid, lastTurn: s._turnCount || 0 };
        } else if (typeof wi.createWorldInfoEntry === 'function') {
            const entry = wi.createWorldInfoEntry(worldName, data);
            if (entry) {
                entry.comment = `NPC: ${npc.name}`;
                entry.content = content;
                entry.key = [npc.name, ...(npc.aliases || [])];
                entry.constant = false; // keyword-gated
                entry.disable = false;
                dirty = true;
                s._lorebookOffscene[npc.name] = { uid: entry.uid, lastTurn: s._turnCount || 0 };
            }
        }
    }

    // Disable entries for NPCs no longer off-scene (they're either in scene
    // now, or no longer tracked). Disabling rather than deleting preserves
    // history if they leave again.
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (!entry || !entry.comment) continue;
        const m = entry.comment.match(/^NPC:\s*(.+)/i);
        if (!m) continue;
        const name = m[1].trim();
        if (!currentOffscene.has(name) && !entry.disable) {
            entry.disable = true;
            dirty = true;
            delete s._lorebookOffscene[name];
        }
    }

    if (dirty) {
        try {
            await wi.saveWorldInfo(worldName, data, true);
            // Make sure ST is using this world for the current chat. We only
            // need to do this once per chat — check world_names cache.
            if (Array.isArray(wi.world_names) && !wi.world_names.includes(worldName)) {
                if (typeof wi.updateWorldInfoList === 'function') {
                    try { await wi.updateWorldInfoList(); } catch(e) {}
                }
            }
        } catch(e) {
            console.warn('[st-rpg-hud] A.5: saveWorldInfo failed', e);
        }
    }
}

// ── v4.1 A.4: Export system prompt as keyword-gated lorebook ─────────────────
// Splits system-prompt.md into 6 sections, writes each as a separate lorebook
// entry: one constant (~350 tokens) + 5 keyword-gated (~0 tokens until topic
// is mentioned in chat). Replaces the need to paste the full 3000-token system
// prompt as a constant lorebook entry.
//
// Sections:
//   RPG-RULES-CORE        — constant (always on): format + output order + first response init
//   RPG-RULES-COMBAT      — keyword: combat, fight, attack, hp, ap, enemy
//   RPG-RULES-QUEST       — keyword: quest, objective, mission, task, complete
//   RPG-RULES-RELATIONSHIPS — keyword: trust, affection, fear, love, relationship
//   RPG-RULES-VIR         — keyword: vir, outfit, appearance, hair, look
//   RPG-RULES-WORLD       — keyword: faction, secret, threat, world, lore
async function exportSystemPromptToLorebook() {
    const wi = await loadWorldInfoAPI();
    if (!wi) {
        toastr?.error('world-info.js unavailable — cannot export.');
        return;
    }

    const worldName = 'RPG-HUD-Rules';
    const sections = [
        {
            name: 'CORE',
            keys: [],
            constant: true,
            content: `[RPG STATE TRACKER — CORE]
Every reply MUST end with exactly one \`\`\`rpg\`\`\` JSON block as the absolute last thing (after prose, after any <pic> tags).
The block is valid JSON: NO comments, NO trailing commas, escape \\n inside strings.

DELTA-ONLY MODE (default): emit ONLY fields that CHANGED this turn. The HUD merges deltas into stored state — unchanged fields stay as-is. If literally nothing changed, emit {}.
When FULL_ECHO_REQUESTED appears in injected state: emit the complete state once.

ALWAYS include when relevant: vitals, location (on change), active_goal, rel_event (when trust/affection/fear changes by >3).
NEVER omit the \`\`\`rpg\`\`\` block — a substantive reply without it is malformed.

[OUTPUT ORDER]
1. Prose and dialogue
2. Any <pic> image tags
3. Any visible markdown blocks (e.g. ─── STATS UPDATE ───)
4. The \`\`\`rpg\`\`\` block — ALWAYS LAST`
        },
        {
            name: 'COMBAT',
            keys: ['combat', 'fight', 'attack', 'hp', 'mp', 'ap', 'enemy', 'damage', 'weapon', 'spell'],
            constant: false,
            content: `[RPG COMBAT FIELDS]
combat{"active":bool, "turn":n, "ap":n, "ap_max":n, "enemy":"Name"}
vitals{"hp":[v,max], "mp":[v,max], "sta":[v,max]} — value cannot exceed max, cannot go below 0
statuses[{"id":"poisoned","name":"Poisoned","type":"debuff","turns":3,"action":"add|remove"}]
party[{"name":"AllyName","hp":100,"hp_max":100}]
inventory[{"name":"...","action":"equip|use|remove","slot":"weapon|body|head"}]
Outcomes proportional to stats and encounter scale.`
        },
        {
            name: 'QUEST',
            keys: ['quest', 'objective', 'mission', 'task', 'complete', 'fail', 'step', 'goal'],
            constant: false,
            content: `[RPG QUEST FIELDS]
quests[{"id":"q1","action":"add|step|complete|fail","title":"...","desc":"...","step":"current step text"}]
active_goal:"string"  — REQUIRED every turn; current scene objective in one sentence
flags{"flag_id":{"label":"Human label","value":true}}  — persistent story flags
scene_objects[{"id":"o1","name":"...","desc":"...","location":"...","action":"add|remove"}]  — props in scene; persist until explicitly removed`
        },
        {
            name: 'RELATIONSHIPS',
            keys: ['trust', 'affection', 'fear', 'love', 'relationship', 'romance', 'intimate', 'feelings'],
            constant: false,
            content: `[RPG RELATIONSHIP FIELDS]
npcs[{"name":"X","disposition":"friendly|wary|neutral|hostile","trust":n,"affection":n,"fear":n,"respect":n,"hostility":n,"gratitude":n,"current_goal":"...","people_here":bool}]
relationships{"Name":{"trust":65,"flags":["saved_my_life","knows_my_secret"]}}
rel_event:"why this changed"  — REQUIRED when trust/affection/fear changes by >3

DELTA LIMITS per turn: trust ±15 | affection ±12 | love ±10 | confidence ±20 | arousal ±30 | shame ±20 | fear ±15 | moral ±8
RANGE: charInner 0–100. Vitals 0..max. Relationship fields -100..+100.

charInner{"health":80,"moral":60,"confidence":55,"shame":20,"promiscuity":30,"arousal":15,"dependence":10,"love":5}
charDev{"oral":0,"breasts":0,"masochism":0,"caressing":0}
mindset{"mood":"anxious","thoughts":"..."}
vad{"Name":{"valence":40,"arousal":60,"dominance":35}}`
        },
        {
            name: 'VIR',
            keys: ['vir', 'outfit', 'appearance', 'hair', 'look', 'wears', 'wearing', 'eyes', 'scars'],
            constant: false,
            content: `[RPG VIR FIELDS — Visual Identity Registry]
vir{<name>:{species_class,age_appearance,height,hair{length,style,color_shade,bangs,default_accessories[]},eyes{color,shape},skin{tone,texture},body{archetype,build,bust,waist_to_hip},non_human{tail,wings,horns,ears},marks{scars[],tattoos[],moles[],piercings[]},outfit[{slot,item_type,color,material,cut,detail,condition}],accessories[{type,material,detail}]}}
vir_changes{<name>:{<dotted.path>:<new value>}}  — for surgical updates without rewriting full nested object
outfit_change{<name>:{removed:[{slot,item_type}], added:[<full piece object>]}}

VIR LOCK: once introduced, a character persists in vir{} forever. Never drop, never contradict their stored appearance.
Off-scene → active:false. Death → status:"deceased". Re-entry → flip active:true, copy verbatim.
Appearance change requires a narrated story event (haircut, injury, dye job) AND a vir/vir_changes delta.`
        },
        {
            name: 'WORLD',
            keys: ['faction', 'secret', 'threat', 'world', 'lore', 'kingdom', 'guild', 'history'],
            constant: false,
            content: `[RPG WORLD FIELDS]
factions[{"name":"The Guild","rep":50,"status":"friendly|neutral|hostile"}]
npc_relations[{"from":"Mika","to":"Lord Shen","type":"rivals|enemies|allies|lovers|mentor"}]
secrets[{"id":"s1","title":"...","text":"...","revealed":bool}]
open_threats[{"source":"...","nature":"...","trigger":"..."}]
facts[{"id":"f1","text":"...","priority":"critical|high|normal"}]  — pinned truths AI must never contradict
topics{"genre":"fantasy|romance|horror|tactical|scifi","primaryTopic":"...","emotionalTone":"...","interactionTheme":"..."}
key_moment:"defining story beat"  — max one per response, only when something pivotal happens`
        },
    ];

    let data;
    try { data = await wi.loadWorldInfo(worldName); } catch(e) { data = null; }
    if (!data || !data.entries) data = { entries: {} };

    // Clear out old RPG-RULES-* entries by name (idempotent re-export)
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (entry?.comment?.startsWith('RPG-RULES-')) {
            entry.disable = true; // soft-clear so old entries don't fire
        }
    }

    let count = 0;
    for (const sec of sections) {
        if (typeof wi.createWorldInfoEntry !== 'function') continue;
        const entry = wi.createWorldInfoEntry(worldName, data);
        if (!entry) continue;
        entry.comment = `RPG-RULES-${sec.name}`;
        entry.content = sec.content;
        entry.key = sec.keys;
        entry.constant = sec.constant;
        entry.disable = false;
        count++;
    }

    try {
        await wi.saveWorldInfo(worldName, data, true);
        if (typeof wi.updateWorldInfoList === 'function') {
            try { await wi.updateWorldInfoList(); } catch(e) {}
        }
        toastr?.success(`Exported ${count} rule sections to lorebook "${worldName}". Enable it in World Info → ${worldName}.`, 'RPG HUD A.4', { timeOut: 6000 });
        return worldName;
    } catch(e) {
        toastr?.error('Save failed: ' + e.message);
        console.warn('[st-rpg-hud] A.4 export failed', e);
    }
}

// ── v4.1 C.3: Slash command registration ─────────────────────────────────────
// Power-user GM tools. Registered lazily because the slash-command API may
// not be available in all ST versions; failures degrade silently.
let _slashRegistered = false;
async function registerSlashCommands() {
    if (_slashRegistered) return;
    try {
        const SP = await import('../../../slash-commands/SlashCommandParser.js');
        const SC = await import('../../../slash-commands/SlashCommand.js');
        const SCA = await import('../../../slash-commands/SlashCommandArgument.js');
        const { SlashCommandParser } = SP;
        const { SlashCommand } = SC;
        const { SlashCommandArgument, ARGUMENT_TYPE } = SCA;

        const add = (props) => {
            try { SlashCommandParser.addCommandObject(SlashCommand.fromProps(props)); }
            catch(e) { console.warn('[st-rpg-hud] slash command failed', props.name, e); }
        };

        add({
            name: 'rpg-status',
            callback: () => {
                if (!isEnabled()) return 'RPG HUD not enabled for this chat.';
                const s = getState();
                const npcCount = (s.npcs||[]).length;
                const hereCount = (s.map?.peopleHere||[]).length;
                const lines = [
                    `Turn: ${s._turnCount||0} | Location: ${s.map?.currentLocation||s.location||'?'}`,
                    `Goal: ${s.active_goal || '(none)'}`,
                    `NPCs tracked: ${npcCount} (${hereCount} in scene)`,
                    `Quests active: ${(s.quests||[]).filter(q=>q.status==='active').length}`,
                    `Parse misses: ${s._parseMisses||0} | Last full echo: turn ${s._lastFullEchoTurn||0}`,
                ];
                return lines.join(' | ');
            },
            helpString: 'Show a one-line RPG HUD state summary.',
        });

        add({
            name: 'rpg-goal',
            callback: (_args, value) => {
                if (!isEnabled()) return '';
                const s = getState();
                const newGoal = String(value || '').trim();
                if (!newGoal) return `Current goal: ${s.active_goal || '(none)'}`;
                if (newGoal !== s.active_goal) s._goalStartedTurn = s._turnCount || 0;
                s.active_goal = newGoal;
                saveState();
                updatePrompt();
                scheduleRender?.();
                return `Goal set: ${newGoal}`;
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'new active_goal text', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
            helpString: 'Set the active_goal directly. Without args, prints the current goal.',
        });

        add({
            name: 'rpg-fact',
            callback: (_args, value) => {
                if (!isEnabled()) return '';
                const s = getState();
                if (!s.facts) s.facts = [];
                const arg = String(value || '').trim();
                if (arg.toLowerCase().startsWith('remove ')) {
                    const id = arg.slice(7).trim();
                    s.facts = s.facts.filter(f => f.id !== id);
                    saveState(); updatePrompt();
                    return `Removed fact "${id}".`;
                }
                if (arg.toLowerCase().startsWith('add ')) {
                    const text = arg.slice(4).trim();
                    const id = 'f' + Date.now().toString(36);
                    s.facts.push({ id, text, priority: 'normal' });
                    saveState(); updatePrompt();
                    return `Added fact ${id}: ${text}`;
                }
                if (!arg) return `${s.facts.length} facts tracked.`;
                return `Use: /rpg-fact add <text> | /rpg-fact remove <id>`;
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: '"add <text>" or "remove <id>"', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
            helpString: 'Add or remove pinned facts. "/rpg-fact add She is the queen\'s daughter" or "/rpg-fact remove f1".',
        });

        add({
            name: 'rpg-echo',
            callback: () => {
                if (!isEnabled()) return '';
                const s = getState();
                s._parseMisses = (s._parseMisses || 0) + 1; // forces full reminder + full echo
                s._lastFullEchoTurn = 0;
                saveState(); updatePrompt();
                return 'Next generation will request a FULL ECHO of state.';
            },
            helpString: 'Force the next AI turn to emit a complete state echo (for drift recovery).',
        });

        add({
            name: 'rpg-recall',
            callback: (_args, value) => {
                if (!isEnabled()) return '';
                const s = getState();
                const name = String(value || '').trim();
                if (!name) return `Tracked: ${(s.npcs||[]).map(n=>n.name).join(', ')||'(none)'}`;
                const npc = (s.npcs||[]).find(n => n.name.toLowerCase() === name.toLowerCase());
                if (!npc) return `No NPC named "${name}" tracked.`;
                const lastSeen = s._npcLastSeenTurn?.[npc.name];
                const gap = lastSeen !== undefined ? (s._turnCount || 0) - lastSeen : '?';
                const moments = (s.keyMoments||[]).filter(m => m.characters?.includes(npc.name)).slice(-3);
                const lines = [
                    `${npc.name} (${npc.role||'?'}, ${npc.disposition||'neutral'})`,
                    `Trust=${npc.trust??0} Affection=${npc.affection??0} Fear=${npc.fear??0}`,
                    `Last seen: turn ${lastSeen??'?'} (${gap} turns ago)`,
                    npc.note ? `Note: ${npc.note}` : '',
                    npc.current_goal ? `Goal: ${npc.current_goal}` : '',
                    moments.length ? `Recent beats:\n${moments.map(m => `  • T${m.turn}: ${m.text}`).join('\n')}` : '',
                ].filter(Boolean);
                return lines.join('\n');
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'NPC name', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
            helpString: 'Show a quick recall card for an NPC: stats, last seen, last beats.',
        });

        add({
            name: 'rpg-skip',
            callback: (_args, value) => {
                if (!isEnabled()) return '';
                const s = getState();
                const arg = String(value || '').trim();
                const m = arg.match(/^(\d+)\s*(h|hours?|d|days?)$/i);
                if (!m) return 'Use: /rpg-skip 3h  OR  /rpg-skip 2 days';
                const n = parseInt(m[1]);
                const unit = m[2][0].toLowerCase();
                if (!s.time) s.time = { day: 1, hour: 12, period: 'day' };
                if (unit === 'h') {
                    let h = (s.time.hour || 0) + n;
                    s.time.day = (s.time.day || 1) + Math.floor(h / 24);
                    s.time.hour = h % 24;
                } else {
                    s.time.day = (s.time.day || 1) + n;
                }
                // Force a time-skip cue next turn by clearing the snapshot
                s._lastTimeSnapshot = null;
                saveState(); updatePrompt();
                return `Time advanced by ${n}${unit === 'h' ? 'h' : 'd'}. Next turn will include a TIME ELAPSED cue.`;
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'amount + unit (e.g. "3h" or "2 days")', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
            helpString: 'Skip in-world time. Triggers off-screen progression on next generation.',
        });

        add({
            name: 'rpg-pin',
            callback: (_args, value) => {
                if (!isEnabled()) return '';
                const s = getState();
                const text = String(value || '').trim();
                if (!text) return 'Use: /rpg-pin <text to remember>';
                const id = 'p' + Date.now().toString(36);
                s.facts = s.facts || [];
                s.facts.push({ id, text, priority: 'high' });
                saveState(); updatePrompt();
                return `Pinned (high priority): ${text}`;
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'text to pin', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
            helpString: 'Pin a high-priority fact. Quick alternative to /rpg-fact add.',
        });

        _slashRegistered = true;
        console.log('[st-rpg-hud] Slash commands registered: /rpg-status /rpg-goal /rpg-fact /rpg-echo /rpg-recall /rpg-skip /rpg-pin');
    } catch (e) {
        console.warn('[st-rpg-hud] Slash commands unavailable in this ST version', e);
    }
}

function updatePrompt() {
    const ctx = getContext();
    if (!isEnabled()) {
        // Clear both injection points
        try { ctx.setExtensionPrompt(EXT, "", IN_CHAT, 0); } catch(e) {}
        try { ctx.setExtensionPrompt(EXT + '_prompt', "", IN_CHAT, 0); } catch(e) {}
        return;
    }
    const text = buildContext(getState());
    const depth = getCFG().opts?.depth ?? 4;
    // IN_CHAT at user-configured depth (default 4 from end). System role.
    // Sits inside the chat stream as a system reminder — doesn't disturb the
    // preset's main system block, world info, or character description. The
    // depth slider in the HUD config UI controls how fresh the HUD context
    // is relative to the user input.
    try {
        ctx.setExtensionPrompt(EXT, text, IN_CHAT, depth, false, PROMPT_ROLE_SYSTEM);
    } catch(e) {
        console.warn('[st-rpg-hud] setExtensionPrompt failed', e);
    }
}

// ── HUD Renderer ──────────────────────────────────────────────
let _hudTemplate = "";
let _renderFrame = null;

function scheduleRender() {
    if (!_renderFrame) _renderFrame = requestAnimationFrame(() => { _renderFrame = null; doRender(); });
}

function esc(s) { return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ── Phase 6: render the rich VIR roster entry into HTML ──────────────────────
// Used inside NPCs tab click-to-expand and in the Identity panel for {{user}}.
// Tolerates missing fields gracefully — only renders sub-sections that exist.
function renderVirCard(v) {
    if (!v || typeof v !== 'object') return '';
    const sec = (label, body) => body
        ? `<div class="rpg-vir-section"><div class="rpg-vir-label">${label}</div>${body}</div>`
        : '';
    const kv = (obj, fields) => {
        if (!obj || typeof obj !== 'object') return '';
        const parts = fields.filter(f => obj[f] !== undefined && obj[f] !== null && obj[f] !== '')
                            .map(f => `<span class="rpg-vir-kv"><b>${f.replace(/_/g, ' ')}:</b> ${esc(obj[f])}</span>`);
        return parts.length ? '<div class="rpg-vir-kv-row">' + parts.join('') + '</div>' : '';
    };
    const arr = (a) => Array.isArray(a) ? a : [];

    // Identity line
    const identity = [
        v.species_class && esc(v.species_class),
        v.species_subtype && `(${esc(v.species_subtype)})`,
        v.humanoid_ratio && `[${esc(v.humanoid_ratio)}]`,
        v.age_appearance && esc(v.age_appearance),
        v.height && esc(v.height),
        v.franchise && `<i>${esc(v.franchise)}</i>`,
    ].filter(Boolean).join(' · ');

    // Hair / facial hair / eyes / skin / body
    const hair = kv(v.hair, ['length','style','texture','color_shade','highlights','parting','bangs']);
    const fh = kv(v.facial_hair, ['state','color','length','grooming']);
    const eyes = kv(v.eyes, ['color','shape','pupil_type','heterochromia','eyelash_density','eyebrow_style','default_gaze']);
    const skin = kv(v.skin, ['tone','undertone','texture','body_hair','pubic_style']);
    const body = kv(v.body, ['archetype','silhouette','weight_class','muscle_definition','frame','bust','waist_to_hip','posture','hand_traits','foot_traits']);

    // Limb config (only if non-default)
    let limbHtml = '';
    if (v.limb_config) {
        const lc = v.limb_config;
        const isDefault = lc.arm_count===2 && lc.leg_count===2 && !arr(lc.missing).length && !arr(lc.prosthetic).length && !arr(lc.extra_limbs).length && (!lc.mobility_state || lc.mobility_state==='able-bodied');
        if (!isDefault) {
            const parts = [];
            if (lc.arm_count !== 2) parts.push(`<b>arms:</b> ${esc(lc.arm_count)}`);
            if (lc.leg_count !== 2) parts.push(`<b>legs:</b> ${esc(lc.leg_count)}`);
            if (arr(lc.missing).length) parts.push(`<b>missing:</b> ${arr(lc.missing).map(esc).join(', ')}`);
            if (arr(lc.prosthetic).length) parts.push(`<b>prosthetic:</b> ${arr(lc.prosthetic).map(esc).join(', ')}`);
            if (arr(lc.extra_limbs).length) parts.push(`<b>extra:</b> ${arr(lc.extra_limbs).map(esc).join(', ')}`);
            if (lc.mobility_state && lc.mobility_state !== 'able-bodied') parts.push(`<b>mobility:</b> ${esc(lc.mobility_state)}`);
            limbHtml = `<div class="rpg-vir-kv-row rpg-vir-warn">${parts.join(' · ')}</div>`;
        }
    }

    // Non-human features
    let nhHtml = '';
    if (v.non_human && typeof v.non_human === 'object') {
        const nh = v.non_human;
        const nhParts = [];
        if (nh.tail) nhParts.push(`<b>tail:</b> ${nh.tail.count? nh.tail.count+' ':''}${esc(nh.tail.type||'')} ${esc(nh.tail.color||'')} ${esc(nh.tail.length||'')}`);
        if (nh.wings) nhParts.push(`<b>wings:</b> ${nh.wings.count? nh.wings.count+' ':''}${esc(nh.wings.type||'')} ${esc(nh.wings.color||'')} ${esc(nh.wings.span||'')}`);
        if (nh.horns) nhParts.push(`<b>horns:</b> ${nh.horns.count? nh.horns.count+' ':''}${esc(nh.horns.shape||'')} ${esc(nh.horns.color||'')}`);
        if (nh.compound_eyes) nhParts.push('<b>compound eyes</b>');
        if (nh.mandibles) nhParts.push(`<b>mandibles:</b> ${esc(nh.mandibles)}`);
        if (nh.antennae) nhParts.push(`<b>antennae:</b> ${esc(nh.antennae)}`);
        if (arr(nh.exoskeleton_zones).length) nhParts.push(`<b>chitin:</b> ${arr(nh.exoskeleton_zones).map(esc).join(', ')}`);
        if (arr(nh.scale_zones).length) nhParts.push(`<b>scales:</b> ${arr(nh.scale_zones).map(esc).join(', ')}`);
        if (arr(nh.fur_zones).length) nhParts.push(`<b>fur:</b> ${arr(nh.fur_zones).map(esc).join(', ')}`);
        if (arr(nh.feather_zones).length) nhParts.push(`<b>feathers:</b> ${arr(nh.feather_zones).map(esc).join(', ')}`);
        if (nh.claws) nhParts.push(`<b>claws:</b> ${esc(nh.claws)}`);
        if (nh.fangs) nhParts.push(`<b>fangs:</b> ${esc(nh.fangs)}`);
        if (arr(nh.magical_marks).length) nhParts.push(`<b>magical marks:</b> ${arr(nh.magical_marks).map(esc).join('; ')}`);
        if (arr(nh.augments).length) nhParts.push(`<b>augments:</b> ${arr(nh.augments).map(esc).join('; ')}`);
        if (nhParts.length) nhHtml = '<div class="rpg-vir-kv-row">' + nhParts.join(' · ') + '</div>';
    }

    // Marks
    let marksHtml = '';
    if (v.marks && typeof v.marks === 'object') {
        const m = v.marks;
        const mParts = [];
        const formatMarkArray = (label, list, keyOrder) => {
            if (!arr(list).length) return null;
            const items = list.map(x => {
                if (typeof x !== 'object') return esc(String(x));
                const ks = keyOrder.filter(k => x[k] !== undefined && x[k] !== null && x[k] !== '');
                return ks.map(k => esc(x[k])).join(' ');
            }).filter(Boolean).join('; ');
            return items ? `<b>${label}:</b> ${items}` : null;
        };
        const t = formatMarkArray('tattoos', m.tattoos, ['design','style','color','location']); if (t) mParts.push(t);
        const sc = formatMarkArray('scars', m.scars, ['size','shape','location','cause-implied']); if (sc) mParts.push(sc);
        const bm = formatMarkArray('birthmarks', m.birthmarks, ['shape','color','location']); if (bm) mParts.push(bm);
        const br = formatMarkArray('brands', m.brands, ['design','location']); if (br) mParts.push(br);
        const rm = formatMarkArray('ritual', m.ritual_marks, ['design','location']); if (rm) mParts.push(rm);
        if (m.freckles && m.freckles.density && m.freckles.density !== 'none') {
            mParts.push(`<b>freckles:</b> ${esc(m.freckles.density)}${arr(m.freckles.zones).length?' ('+arr(m.freckles.zones).map(esc).join(', ')+')':''}`);
        }
        const mo = formatMarkArray('moles', m.moles, ['color','location']); if (mo) mParts.push(mo);
        const pi = formatMarkArray('piercings', m.piercings, ['jewelry-type','metal','location']); if (pi) mParts.push(pi);
        if (mParts.length) marksHtml = '<div class="rpg-vir-kv-row">' + mParts.join(' · ') + '</div>';
    }

    // Outfit pieces
    let outfitHtml = '';
    if (Array.isArray(v.outfit) && v.outfit.length) {
        const items = v.outfit.map(p => {
            if (!p || typeof p !== 'object') return '';
            const cond = p.condition && p.condition !== 'pristine' ? ` <span class="rpg-vir-cond">[${esc(p.condition)}]</span>` : '';
            return `<li><b>${esc(p.slot||'?')}</b> — ${esc(p.fit||'')} ${esc(p.exact_color_shade||'')} ${esc(p.material||'')} ${esc(p.item_type||'')} <i>${esc(p.cut_or_style||'')}</i>${p.distinguishing_detail?', '+esc(p.distinguishing_detail):''}${cond}</li>`;
        }).filter(Boolean).join('');
        if (items) outfitHtml = `<ul class="rpg-vir-outfit">${items}</ul>`;
    }

    // Accessories
    let accHtml = '';
    if (Array.isArray(v.accessories) && v.accessories.length) {
        const items = v.accessories.map(a => {
            if (!a || typeof a !== 'object') return '';
            return `<li>${esc(a.type||'?')} — ${esc(a.metal_or_material||'')} ${esc(a.stone_or_color||'')}${a.detail?' ('+esc(a.detail)+')':''}</li>`;
        }).filter(Boolean).join('');
        if (items) accHtml = `<ul class="rpg-vir-acc">${items}</ul>`;
    }

    // Equipment
    let eqHtml = '';
    if (Array.isArray(v.equipment) && v.equipment.length) {
        const items = v.equipment.map(eq => {
            if (!eq || typeof eq !== 'object') return '';
            const subparts = eq.subparts && typeof eq.subparts === 'object'
                ? Object.entries(eq.subparts).filter(([,v])=>v).map(([k,v])=>`${k}: ${esc(v)}`).join('; ')
                : '';
            return `<li><b>${esc(eq.type||'?')}</b>${eq.position?' @ '+esc(eq.position):''}${eq.condition?' ['+esc(eq.condition)+']':''}${subparts?'<br><span class="rpg-vir-subparts">'+subparts+'</span>':''}${eq.sigil?'<br><i>sigil: '+esc(eq.sigil)+'</i>':''}</li>`;
        }).filter(Boolean).join('');
        if (items) eqHtml = `<ul class="rpg-vir-eq">${items}</ul>`;
    }

    return `<div class="rpg-vir-card">
        ${identity ? '<div class="rpg-vir-identity">' + identity + '</div>' : ''}
        ${sec('Hair', hair)}
        ${sec('Facial hair', fh)}
        ${sec('Eyes', eyes)}
        ${sec('Skin', skin)}
        ${sec('Body', body)}
        ${sec('Limb config (non-default)', limbHtml)}
        ${sec('Non-human', nhHtml)}
        ${sec('Marks', marksHtml)}
        ${sec('Outfit', outfitHtml)}
        ${sec('Accessories', accHtml)}
        ${sec('Equipment', eqHtml)}
    </div>`;
}
function mod(v) { const m=Math.floor((v-10)/2); return m>=0?`+${m}`:String(m); }

function doRender() {
    const w = document.querySelector('.rpg-hud-wrapper');
    if (!w) return;
    const ctx = getContext();
    const s = getState();
    const gm = getCFG().opts?.gmEdit || false;
    const chatId = getChatId();

    // ── v4.1: Auto-tone classes on wrapper for CSS mood theming ─────────────
    // Period: morning/afternoon/evening/night → rpg-tone-time-<period>
    // Combat active → rpg-tone-combat
    // Genre → rpg-tone-genre-<genre>
    // Tone → rpg-tone-mood-<tone>  (sanitized)
    {
        const sanitize = v => String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,20);
        const period = sanitize(s.time?.period);
        const genre  = sanitize(s.topics?.genre);
        const tone   = sanitize(s.topics?.emotionalTone || s.mindset?.mood);
        const combat = !!s.combat?.active;
        // Strip prior tone classes then re-add
        Array.from(w.classList).forEach(c => { if (c.startsWith('rpg-tone-')) w.classList.remove(c); });
        if (period) w.classList.add('rpg-tone-time-' + period);
        if (genre)  w.classList.add('rpg-tone-genre-' + genre);
        if (tone)   w.classList.add('rpg-tone-mood-' + tone);
        if (combat) w.classList.add('rpg-tone-combat');
    }

    // ── location ──────────────────────────────────────────────
    const lEl=w.querySelector('#rpg-location-val'); if(lEl) lEl.textContent=s.map?.currentLocation||s.location||'Unknown';
    const rEl=w.querySelector('#rpg-region-val'); if(rEl) rEl.textContent=s.map?.region&&s.map.region!=='Unknown'?s.map.region:'';

    // ── time bar ──────────────────────────────────────────────
    const timeEl = w.querySelector('#rpg-time-val');
    if (timeEl) {
        const t = s.time;
        if (t?.dateStr) timeEl.textContent = t.dateStr;
        else if (t?.season && t.season !== "Unknown") timeEl.textContent = `Day ${t.day} · ${t.period} · ${t.season}`;
        else timeEl.textContent = '';
        timeEl.parentElement.style.display = timeEl.textContent ? '' : 'none';
    }

    // ── combat ────────────────────────────────────────────────
    const cb=w.querySelector('#rpg-combat-banner');
    if(cb){ cb.classList.toggle('active',!!s.combat?.active);
        if(s.combat?.active){
            const l=w.querySelector('#rpg-combat-label'); if(l)l.textContent=`⚔ Combat — Turn ${s.combat.turn||1}${s.combat.enemy?' vs '+s.combat.enemy:''}`;
            const ap=w.querySelector('#rpg-ap-display'); if(ap)ap.textContent=`AP:${s.combat.ap}/${s.combat.ap_max}`;
        }
    }

    // ── vitals — delta floaters + sparklines + low-HP warning ─
    const vc=w.querySelector('#rpg-vitals-container');
    if(vc){
        const frag=document.createDocumentFragment();
        let anyLowHp=false;
        for(const [id,v] of Object.entries(s.vitals||{})){
            const ratio=v.max?Math.max(0,Math.min(1,v.value/v.max)):1;
            if(v.max&&ratio<0.2) anyLowHp=true;
            const color=v.color||'var(--hud-primary)';
            const prev=_prevVitals[id];
            // Update sparkline history
            const hKey=`${chatId}_${id}`;
            if(!_vitalHistory[hKey]) _vitalHistory[hKey]=[];
            if(prev===undefined||prev!==v.value){ _vitalHistory[hKey].push(v.value); if(_vitalHistory[hKey].length>12)_vitalHistory[hKey].shift(); }
            const hist=_vitalHistory[hKey];

            const div=document.createElement('div'); div.className='rpg-vital';
            const hdr=document.createElement('div'); hdr.className='rpg-vital-header';
            const lbl=document.createElement('span'); lbl.className='rpg-vital-label'; lbl.textContent=v.name||id;
            hdr.appendChild(lbl);
            if(hist&&hist.length>=2){ const svg=document.createElement('span'); svg.innerHTML=buildSparkline(hist,v.max); if(svg.firstChild)hdr.appendChild(svg.firstChild); }
            const valSpan=document.createElement('span'); valSpan.className='rpg-vital-value'; valSpan.textContent=`${v.value}${v.max!=null?'/'+v.max:''}`;
            hdr.appendChild(valSpan);

            const track=document.createElement('div'); track.className='rpg-bar-track';
            const fill=document.createElement('div'); fill.className='rpg-bar-fill';
            fill.style.cssText=`background:${color};transform:scaleX(${ratio})`;
            // Delta indicator
            if(prev!==undefined&&prev!==v.value){
                const diff=v.value-prev;
                const delta=document.createElement('span');
                delta.className=`rpg-delta ${diff>0?'pos':'neg'}`;
                delta.textContent=`${diff>0?'+':''}${diff}`;
                track.appendChild(delta);
            }
            track.appendChild(fill);
            div.appendChild(hdr); div.appendChild(track);
            frag.appendChild(div);
            _prevVitals[id]=v.value;
        }
        vc.replaceChildren(frag);
        w.classList.toggle('rpg-low-hp',anyLowHp);
    }

    // ── attributes ────────────────────────────────────────────
    const ag=w.querySelector('#rpg-attributes-grid');
    if(ag){
        const frag=document.createDocumentFragment();
        for(const [id,a] of Object.entries(s.attributes||{})){
            const cell=document.createElement('div'); cell.className='rpg-attr-cell';
            cell.innerHTML=`<span class="rpg-attr-label">${esc(a.name||id)}</span><div class="rpg-attr-val">${a.value}</div>${a.value>=1&&a.value<=30?`<div class="rpg-attr-mod">${mod(a.value)}</div>`:''}`;
            frag.appendChild(cell);
        }
        ag.replaceChildren(frag);
    }

    // ── resources ─────────────────────────────────────────────
    const rr=w.querySelector('#rpg-resources-row');
    if(rr){
        const frag=document.createDocumentFragment();
        for(const [id,r] of Object.entries(s.resources||{})){
            const chip=document.createElement('div'); chip.className='rpg-resource-chip';
            chip.innerHTML=`<strong>${esc(r.name||id)}</strong>: ${esc(String(r.value))}`;
            frag.appendChild(chip);
        }
        rr.replaceChildren(frag);
    }

    // ── statuses ──────────────────────────────────────────────
    const sr=w.querySelector('#rpg-statuses-row');
    if(sr){
        sr.innerHTML=s.statuses?.length
            ?s.statuses.map(st=>`<span class="rpg-pill status-${(st.type||'debuff').includes('buff')?'buff':'debuff'}"${st.desc?` data-desc="${esc(st.desc)}"`:''}">${esc(st.name||st.id)}</span>`).join('')
            :'<span class="rpg-empty">No active effects.</span>';
    }

    // ── skills ────────────────────────────────────────────────
    const sl=w.querySelector('#rpg-skills-list');
    if(sl){
        if(!s.skills?.length){ sl.innerHTML='<span class="rpg-empty">No skills learned yet.</span>'; }
        else{
            const byCategory = {};
            for (const sk of s.skills) {
                const cat = sk.category||'general';
                if (!byCategory[cat]) byCategory[cat]=[];
                byCategory[cat].push(sk);
            }
            const frag = document.createDocumentFragment();
            for (const [cat, skills] of Object.entries(byCategory)) {
                if (Object.keys(byCategory).length > 1) {
                    const hdr = document.createElement('div');
                    hdr.className = 'rpg-section-heading';
                    hdr.innerHTML = `<i class="fa-solid fa-tag"></i> ${esc(cat.charAt(0).toUpperCase()+cat.slice(1))}`;
                    frag.appendChild(hdr);
                }
                const row = document.createElement('div'); row.className='rpg-pill-row';
                for (const sk of skills) {
                    const meta = [sk.cost&&`⚡${sk.cost}`, sk.cooldown&&parseInt(sk.cooldown)>0&&`⏱${sk.cd_remaining||sk.cooldown}t`].filter(Boolean).join(' ');
                    const pill = document.createElement('span');
                    pill.className='rpg-pill skill-pill'; pill.dataset.id=esc(sk.id||sk.name);
                    if(sk.desc) pill.dataset.desc=esc(sk.desc+(meta?' | '+meta:''));
                    pill.innerHTML=`${esc(sk.name||sk.id)} <span class="level-badge">Lv${esc(sk.level||1)}</span>${meta?`<span class="skill-meta">${esc(meta)}</span>`:''}`;
                    pill.addEventListener('click',()=>{
                        const ta=/** @type {HTMLTextAreaElement|null} */(document.getElementById('send_textarea'));
                        if(ta){ ta.value=(ta.value.trim()?ta.value+'\n':'')+`*Player uses ${sk.name||sk.id}*`; ta.dispatchEvent(new Event('input',{bubbles:true})); }
                    });
                    row.appendChild(pill);
                }
                frag.appendChild(row);
            }
            sl.replaceChildren(frag);
        }
    }

    // ── outfits ───────────────────────────────────────────────
    const outfitEl = w.querySelector('#rpg-outfit-list');
    if (outfitEl) {
        const active = (s.outfits||[]).filter(o=>o.active);
        const inactive = (s.outfits||[]).filter(o=>!o.active);
        if (!s.outfits?.length) { outfitEl.innerHTML='<span class="rpg-empty">No outfits tracked.</span>'; }
        else {
            const frag = document.createDocumentFragment();
            for (const o of [...active,...inactive]) {
                const d = document.createElement('div');
                d.className = `rpg-outfit-card${o.active?' active':''}  rarity-${o.rarity||'common'}`;
                d.innerHTML = `<div class="rpg-outfit-name">${o.active?'👗 ':''}<strong>${esc(o.name)}</strong>${o.rarity&&o.rarity!=='common'?` <span class="rpg-rarity-badge rarity-${o.rarity}">${esc(o.rarity)}</span>`:''}</div>${o.desc?`<div class="rpg-outfit-desc">${esc(o.desc)}</div>`:''}`;
                frag.appendChild(d);
            }
            outfitEl.replaceChildren(frag);
        }
        // ── presets bar ──
        let presetsBar = outfitEl.parentElement?.querySelector('.rpg-outfit-presets');
        if (!presetsBar) {
            presetsBar = document.createElement('div');
            presetsBar.className = 'rpg-outfit-presets';
            outfitEl.insertAdjacentElement('afterend', presetsBar);
        }
        const presets = s.outfitPresets || {};
        const presetNames = Object.keys(presets);
        presetsBar.innerHTML = '';
        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'rpg-preset-btn'; saveBtn.textContent = '💾 Save Preset';
        saveBtn.onclick = async () => {
            const name = prompt('Name this outfit preset:');
            if (!name?.trim()) return;
            s.outfitPresets[name.trim()] = (s.outfits||[]).filter(o=>o.active).map(o=>({...o}));
            saveState(); scheduleRender();
        };
        presetsBar.appendChild(saveBtn);
        // Load buttons for each saved preset
        for (const pn of presetNames) {
            const btn = document.createElement('button');
            btn.className = 'rpg-preset-btn rpg-preset-load'; btn.textContent = pn;
            btn.title = 'Click to load, right-click to delete';
            btn.onclick = () => {
                const saved = presets[pn]; if (!saved) return;
                s.outfits.forEach(o=>o.active=false);
                for (const o of saved) {
                    const idx = s.outfits.findIndex(x=>x.name===o.name);
                    if (idx!==-1) s.outfits[idx].active=true;
                    else s.outfits.push({...o, active:true});
                }
                saveState(); scheduleRender();
            };
            btn.oncontextmenu = e => { e.preventDefault(); if(confirm(`Delete preset "${pn}"?`)){delete s.outfitPresets[pn]; saveState(); scheduleRender();} };
            presetsBar.appendChild(btn);
        }
    }

    // ── equipped ──────────────────────────────────────────────
    const eg=w.querySelector('#rpg-equip-grid');
    if(eg){
        const SLOTS=['weapon','offhand','head','headwear','body','topwear','bottomwear','footwear','accessory'];
        const LABELS={weapon:'⚔ Weapon',offhand:'🛡 Off-hand',head:'⛑ Head',headwear:'⛑ Head',body:'👕 Body',topwear:'👕 Body',bottomwear:'👖 Legs',footwear:'👟 Feet',accessory:'💍 Acc.'};
        const shown=SLOTS.filter(sl=>s.inventory?.some(i=>i.slot===sl));
        if(!shown.length){ eg.innerHTML='<span class="rpg-empty">Nothing equipped.</span>'; }
        else{
            const frag=document.createDocumentFragment();
            shown.forEach(sl=>{
                const item=s.inventory?.find(i=>i.slot===sl&&i.equipped);
                const d=document.createElement('div'); d.className=`rpg-equip-slot${item?' filled':''}`;
                d.dataset.slot=sl;
                d.innerHTML=`<div class="rpg-equip-slot-label">${esc(LABELS[sl]||sl)}</div>${item?`<div class="rpg-equip-slot-item rarity-${item.rarity||'common'}">${esc(item.name)}</div>`:'<div class="rpg-equip-slot-empty">—</div>'}`;
                frag.appendChild(d);
            });
            eg.replaceChildren(frag);
        }
    }

    // ── backpack — drag-to-equip ───────────────────────────────
    const bp=w.querySelector('#rpg-backpack-grid');
    if(bp){
        const un=(s.inventory||[]).filter(i=>!i.equipped);
        if(!un.length){ bp.innerHTML='<span class="rpg-empty">Backpack empty.</span>'; }
        else{
            const frag=document.createDocumentFragment();
            un.forEach(i=>{
                const d=document.createElement('div'); d.className=`rpg-item-card rarity-${i.rarity||'common'}`;
                d.title=i.desc||''; d.draggable=true; d.dataset.itemName=i.name;
                d.innerHTML=`${esc(i.name)}${(i.qty||1)>1?` <span class="rpg-item-qty">×${i.qty}</span>`:''}`;
                d.addEventListener('dragstart',e=>{ e.dataTransfer.setData('text/plain',i.name); d.classList.add('dragging'); });
                d.addEventListener('dragend',()=>d.classList.remove('dragging'));
                frag.appendChild(d);
            });
            bp.replaceChildren(frag);
        }
        // Bind equip slots as drop targets (after frag is in DOM)
        requestAnimationFrame(()=>{
            w.querySelectorAll('.rpg-equip-slot:not([data-drop-bound])').forEach(slot=>{
                slot.dataset.dropBound='1';
                slot.addEventListener('dragover',e=>{ e.preventDefault(); slot.classList.add('drag-over'); });
                slot.addEventListener('dragleave',()=>slot.classList.remove('drag-over'));
                slot.addEventListener('drop',e=>{
                    e.preventDefault(); slot.classList.remove('drag-over');
                    const nm=e.dataTransfer.getData('text/plain');
                    const slotId=slot.dataset.slot;
                    const st=getState();
                    const idx=st.inventory.findIndex(i=>i.name===nm);
                    if(idx!==-1&&slotId){
                        st.inventory.forEach(i=>{ if(i.equipped&&i.slot===slotId)i.equipped=false; });
                        st.inventory[idx].equipped=true; st.inventory[idx].slot=slotId;
                        saveState(); scheduleRender();
                    }
                });
            });
        });
    }

    // ── party — with character portraits ──────────────────────
    const pl=w.querySelector('#rpg-party-list');
    if(pl){
        const chars=Object.entries(s.party||{});
        if(!chars.length){ pl.innerHTML='<span class="rpg-empty">No party members.</span>'; }
        else{
            const frag=document.createDocumentFragment();
            const ctxChars=ctx.characters||[];
            // Rel colors — same palette as NPC panel
            const RCLR={trust:'#70b0e8',affection:'#e87070',fear:'#888',respect:'#70e8a8',hostility:'var(--hud-danger)',gratitude:'#e8d070',desire:'#e870b8',lust:'#e8a870',rivalry:'#e8d070',connection:'#a870e8'};
            const REL_ORDER=['trust','affection','fear','respect','hostility','gratitude'];
            chars.forEach(([nm,combatStats])=>{
                // Relationship values come from NPC store — single source of truth
                const npcEntry = (s.npcs||[]).find(n=>n.name.toLowerCase()===nm.toLowerCase());
                const charObj=ctxChars.find(c=>c.name===nm);
                const avatarUrl=charObj?.avatar?`/thumbnail?type=avatar&file=${encodeURIComponent(charObj.avatar)}`:'';
                const card=document.createElement('div'); card.className='rpg-party-card';
                // Relationship bars (from NPC store)
                const relHtml = REL_ORDER.map(f=>{
                    const v = npcEntry?.[f] ?? 0;
                    const clr = v===0?'rgba(255,255,255,0.2)':(RCLR[f]||'#aaa');
                    const pct = Math.max(0,Math.min(1,(v+100)/200));
                    return `<div class="rpg-relation-cell${v===0?' zero':''}"><div class="rpg-relation-label">${f}</div><div class="rpg-relation-bar-track"><div class="rpg-relation-bar-fill" style="background:${clr};transform:scaleX(${pct})"></div></div><div class="rpg-relation-val" style="color:${clr}">${v>0?'+':''}${v}</div></div>`;
                }).join('');
                // HP/status from party store
                let hpHtml = '';
                if (combatStats.hp !== undefined && combatStats.hp_max) {
                    const hpPct = Math.max(0,Math.min(1,combatStats.hp/combatStats.hp_max));
                    const hpClr = hpPct > 0.5 ? 'var(--hud-success)' : hpPct > 0.2 ? 'var(--hud-warn)' : 'var(--hud-danger)';
                    hpHtml = `<div class="rpg-party-hp-bar"><div class="rpg-party-hp-label">HP ${combatStats.hp}/${combatStats.hp_max}</div><div class="rpg-bar-track" style="height:5px"><div class="rpg-bar-fill" style="background:${hpClr};transform:scaleX(${hpPct})"></div></div></div>`;
                }
                if (combatStats.status) hpHtml += `<div class="rpg-party-status">${esc(combatStats.status)}</div>`;
                // Outfit from NPC store
                const outfitLine = npcEntry?.outfit ? `<div class="rpg-npc-outfit" style="font-size:11px;opacity:.7;margin-bottom:4px"><i class="fa-solid fa-shirt" style="margin-right:4px;font-size:10px;"></i>${esc(npcEntry.outfit)}</div>` : '';
                card.innerHTML=`<div class="rpg-party-name">${avatarUrl?`<img class="rpg-party-portrait" src="${avatarUrl}" alt="${esc(nm)}" onerror="this.replaceWith(document.createTextNode('👤'))">`:'👤'} ${esc(nm)}</div>${hpHtml}${outfitLine}<div class="rpg-relation-grid">${relHtml}</div>`;
                frag.appendChild(card);
            });
            pl.replaceChildren(frag);
        }
    }

    // ── quests ────────────────────────────────────────────────
    function renderQ(el, quests) {
        if(!el) return;
        if(!quests.length){ el.innerHTML='<span class="rpg-empty">None.</span>'; return; }
        const frag=document.createDocumentFragment();
        quests.forEach(q=>{
            const d=document.createElement('div'); d.className=`rpg-quest-card ${q.status||''}`;
            d.innerHTML=`<div class="rpg-quest-title">${q.status==='completed'?'✓ ':q.status==='failed'?'✗ ':''}${esc(q.title||q.id)}</div>${q.desc?`<div class="rpg-quest-desc">${esc(q.desc)}</div>`:''}${q.steps?.length?`<ul class="rpg-quest-steps">${q.steps.map(st=>`<li>${esc(st)}</li>`).join('')}</ul>`:''}`;
            frag.appendChild(d);
        });
        el.replaceChildren(frag);
    }
    renderQ(w.querySelector('#rpg-active-quests'),(s.quests||[]).filter(q=>q.status==='active'));
    renderQ(w.querySelector('#rpg-done-quests'),(s.quests||[]).filter(q=>q.status!=='active'));

    // ── npcs (Phase 6: active/status badges + click-to-expand rich VIR) ──
    const nl=w.querySelector('#rpg-npc-list');
    if(nl){
        if(!s.npcs?.length){ nl.innerHTML='<span class="rpg-empty">No known NPCs.</span>'; }
        else{
            const frag=document.createDocumentFragment();
            s.npcs.forEach(n=>{
                const d=document.createElement('div'); d.className='rpg-npc-row';
                const disp=(n.disposition||n.role||'unknown').toLowerCase();

                // Phase 6: status badge driven by VIR roster persistence
                const virEntry = s.vir?.[n.name];
                const isActive = virEntry ? (virEntry.active !== false) : (n.active !== false);
                const status = (virEntry?.status || n.status || 'alive').toLowerCase();
                let statusBadge = '';
                let rowClass = 'rpg-npc-row';
                if (status === 'deceased') {
                    statusBadge = '<span class="rpg-npc-status-badge deceased" title="Deceased">✕ DECEASED</span>';
                    rowClass += ' npc-deceased';
                } else if (!isActive) {
                    statusBadge = '<span class="rpg-npc-status-badge off-scene" title="Off-scene">○ OFF-SCENE</span>';
                    rowClass += ' npc-offscene';
                } else if (status === 'missing' || status === 'imprisoned' || status === 'unconscious') {
                    statusBadge = `<span class="rpg-npc-status-badge ${status}" title="${esc(status)}">${esc(status.toUpperCase())}</span>`;
                    rowClass += ' npc-' + status;
                } else {
                    statusBadge = '<span class="rpg-npc-status-badge active" title="In scene">● ACTIVE</span>';
                }
                d.className = rowClass;

                const NPC_REL_COLORS = {trust:'#70b0e8',affection:'#e87070',fear:'#888',respect:'#70e8a8',hostility:'var(--hud-danger)',gratitude:'#e8d070'};
                // Always show all 6 meters; zero values are grayed out
                const npcRelHtml = `<div class="rpg-npc-rels">${Object.entries(NPC_REL_COLORS).map(([f,clr])=>{
                    const val = n[f] ?? 0;
                    const pct = Math.max(0,Math.min(1,(val+100)/200));
                    const isZero = val === 0;
                    const color = isZero ? 'rgba(255,255,255,0.2)' : clr;
                    return `<div class="rpg-npc-rel-cell${isZero?' zero':''}"><span class="rpg-npc-rel-label">${f}</span><div class="rpg-relation-bar-track"><div class="rpg-relation-bar-fill" style="background:${color};transform:scaleX(${pct})"></div></div><span class="rpg-npc-rel-val" style="color:${color}">${val>0?'+':''}${val}</span></div>`;
                }).join('')}</div>`;
                const outfitLine = n.outfit ? `<div class="rpg-npc-outfit"><i class="fa-solid fa-shirt" style="opacity:.6;margin-right:4px;font-size:10px;"></i>${esc(n.outfit)}</div>` : '';
                const goalLine = n.current_goal ? `<div class="rpg-npc-goal"><i class="fa-solid fa-crosshairs" style="opacity:.6;margin-right:4px;font-size:10px;"></i>${esc(n.current_goal)}</div>` : '';
                const lastSeenLine = n.lastSeenAt && n.lastSeenAt !== (s.map?.currentLocation||s.location) ? `<div class="rpg-npc-lastseen">Last seen: ${esc(n.lastSeenAt)}${n.exitState?' — '+esc(n.exitState):''}</div>` : '';

                // Phase 6: click-to-expand rich VIR panel (only when full VIR present)
                let virExpand = '';
                if (virEntry && (virEntry.hair || virEntry.eyes || virEntry.body || virEntry.outfit?.length)) {
                    virExpand = `<details class="rpg-npc-vir-expand"><summary>🧬 Visual Identity Registry</summary>${renderVirCard(virEntry)}</details>`;
                }

                // Layout matches original: content on left, status badge + role
                // stacked on the right (preserves the existing flex row layout
                // of .rpg-npc-row).
                d.innerHTML=`<div><div class="rpg-npc-name">${esc(n.name)}</div>${n.note?`<div class="rpg-npc-note">${esc(n.note)}</div>`:''}${goalLine}${lastSeenLine}${outfitLine}${npcRelHtml}${virExpand}</div><div class="rpg-npc-status-stack">${statusBadge}<span class="rpg-npc-role ${disp}">${esc(n.role||'unknown')}</span></div>`;
                frag.appendChild(d);
            });
            nl.replaceChildren(frag);
        }
    }

    // ── npc-to-npc relations ──────────────────────────────────
    const npcRelEl = w.querySelector('#rpg-npc-relations');
    if (npcRelEl) {
        if (!s.npcRelations?.length) { npcRelEl.innerHTML=''; }
        else {
            const frag = document.createDocumentFragment();
            for (const r of s.npcRelations) {
                const d = document.createElement('div'); d.className='rpg-npc-rel-row';
                d.innerHTML=`<span class="rpg-npc-rel-from">${esc(r.from)}</span><span class="rpg-npc-rel-type">${esc(r.type||'knows')}</span><span class="rpg-npc-rel-to">${esc(r.to)}</span>${r.note?`<span class="rpg-npc-rel-note">${esc(r.note)}</span>`:''}`;
                frag.appendChild(d);
            }
            npcRelEl.replaceChildren(frag);
        }
    }
    const npcRelSection = /** @type {HTMLElement|null} */(w.querySelector('#rpg-npc-relations-section'));
    if (npcRelSection) npcRelSection.style.display = s.npcRelations?.length ? '' : 'none';

    // ── world ─────────────────────────────────────────────────
    const wl=w.querySelector('#rpg-world-location'); if(wl) wl.textContent=s.map?.currentLocation||s.location||'Unknown';
    const wr=w.querySelector('#rpg-world-region'); if(wr) wr.textContent=s.map?.region||'Unknown Region';
    const ll=w.querySelector('#rpg-landmarks-list');
    if(ll){
        if(!s.map?.landmarks?.length){ ll.innerHTML='<li class="rpg-empty">No landmarks discovered.</li>'; }
        else{
            const frag=document.createDocumentFragment();
            s.map.landmarks.forEach(m=>{ const li=document.createElement('li'); li.className='rpg-landmark-item'; li.innerHTML=`📍 <strong>${esc(m.name)}</strong>${m.note?' — '+esc(m.note):''}`;frag.appendChild(li); });
            ll.replaceChildren(frag);
        }
    }
    const tl=w.querySelector('#rpg-travel-log');
    if(tl){
        const log=s.map?.travelLog||[];
        if(!log.length){ tl.innerHTML='<span class="rpg-empty">No travel history yet.</span>'; }
        else{
            const frag=document.createDocumentFragment();
            [s.map.currentLocation,...log].slice(0,8).forEach((loc,i)=>{ const d=document.createElement('div'); d.className='rpg-travel-entry'; d.innerHTML=`${i>0?'<span class="rpg-travel-arrow">◀</span>':''}<span>${esc(loc)}</span>`; frag.appendChild(d); });
            tl.replaceChildren(frag);
        }
    }

    // ── people here ───────────────────────────────────────────
    const pplEl = w.querySelector('#rpg-people-here');
    if (pplEl) {
        const curLoc = s.map?.currentLocation||s.location||"Unknown";
        const here = (s.npcs||[]).filter(n=>n.location&&n.location.toLowerCase()===curLoc.toLowerCase());
        if (!here.length) { pplEl.innerHTML='<span class="rpg-empty">Nobody notable here.</span>'; }
        else {
            // v4.1 C.2: color-code by disposition; tooltip shows trust/affection
            const DISP_COLORS = {
                friendly: { bg: 'rgba(82,200,122,0.15)', bd: 'rgba(82,200,122,0.4)', fg: '#74d18f' },
                wary:     { bg: 'rgba(220,170,60,0.15)', bd: 'rgba(220,170,60,0.4)', fg: '#dcaa3c' },
                neutral:  { bg: 'rgba(82,148,200,0.12)', bd: 'rgba(82,148,200,0.3)', fg: '#7eaccc' },
                hostile:  { bg: 'rgba(220,80,80,0.15)',  bd: 'rgba(220,80,80,0.4)',  fg: '#e57373' },
            };
            pplEl.innerHTML = here.map(n => {
                const d = DISP_COLORS[n.disposition] || DISP_COLORS.neutral;
                const tipBits = [];
                if (n.trust !== undefined)     tipBits.push(`trust=${n.trust}`);
                if (n.affection !== undefined) tipBits.push(`affection=${n.affection}`);
                if (n.fear !== undefined && n.fear !== 0) tipBits.push(`fear=${n.fear}`);
                const tip = `${n.disposition||'neutral'}${tipBits.length?' | '+tipBits.join(' '):''}${n.note?' | '+n.note:''}`;
                return `<span class="rpg-pill" title="${esc(tip)}" style="background:${d.bg};border:1px solid ${d.bd};color:${d.fg}">${esc(n.name)}</span>`;
            }).join('');
        }
    }

    // v4.1 C.2: Travel breadcrumb shows last 5 hops with arrows
    const travelEl = w.querySelector('#rpg-travel-log');
    if (travelEl) {
        const log = s.map?.travelLog || [];
        if (!log.length) {
            travelEl.innerHTML = '<span class="rpg-empty">No travel history yet.</span>';
        } else {
            const cur = s.map?.currentLocation || s.location || '?';
            const trail = [...log.slice(0,5).reverse(), cur];
            travelEl.innerHTML = trail.map((l, i) => {
                const isLast = i === trail.length - 1;
                const style = isLast ? 'font-weight:600;color:var(--hud-info);' : 'opacity:.7;';
                return `<span style="${style}">${esc(l)}</span>`;
            }).join(' <span style="opacity:.5;">→</span> ');
        }
    }

    // ── factions ──────────────────────────────────────────────
    const facEl = w.querySelector('#rpg-factions-list');
    if (facEl) {
        const facs = Object.values(s.factions||{});
        if (!facs.length) { facEl.innerHTML='<span class="rpg-empty">No factions encountered.</span>'; }
        else {
            const frag = document.createDocumentFragment();
            for (const f of facs) {
                const d = document.createElement('div'); d.className='rpg-faction-row';
                const repPct = Math.max(0,Math.min(1,(f.rep+100)/200));
                const repClr = f.status==='friendly'?'var(--hud-success)':f.status==='hostile'?'var(--hud-danger)':'var(--hud-warn)';
                d.innerHTML=`<div class="rpg-faction-name">${esc(f.name)}</div><span class="rpg-faction-status status-${f.status||'neutral'}">${esc(f.status||'neutral')}</span><div class="rpg-relation-bar-track rpg-faction-bar"><div class="rpg-relation-bar-fill" style="background:${repClr};transform:scaleX(${repPct})"></div></div><div class="rpg-faction-rep" style="color:${repClr}">${f.rep>0?'+':''}${f.rep}</div>${f.note?`<div class="rpg-faction-note">${esc(f.note)}</div>`:''}`;
                frag.appendChild(d);
            }
            facEl.replaceChildren(frag);
        }
    }

    // ── flags ─────────────────────────────────────────────────
    const flagsEl = w.querySelector('#rpg-flags-list');
    if (flagsEl) {
        const trueFlags = Object.entries(s.flags||{}).filter(([,f])=>f.value==="true"||f.value===true);
        if (!trueFlags.length) { flagsEl.innerHTML=''; }
        else { flagsEl.innerHTML = trueFlags.map(([id,f])=>`<span class="rpg-flag-chip" title="${esc(id)}">${esc(f.label||id)}</span>`).join(''); }
    }

    // ── journal ───────────────────────────────────────────────
    const jl=w.querySelector('#rpg-journal-list');
    if(jl){
        const notes=s.notes||[];
        if(!notes.length){ jl.innerHTML='<span class="rpg-empty">No journal entries yet.</span>'; }
        else{
            const frag=document.createDocumentFragment();
            [...notes].reverse().forEach(n=>{ const d=document.createElement('div'); d.className=`rpg-log-entry${n.text?.startsWith('[Parse')?' error':''}`; d.textContent=n.text||''; frag.appendChild(d); });
            jl.replaceChildren(frag);
        }
    }

    // ── F.2: Contradiction log (Journal tab) ─────────────────────
    const cSection = /** @type {HTMLElement|null} */(w.querySelector('#rpg-contradiction-section'));
    const cList = w.querySelector('#rpg-contradiction-list');
    if (cSection && cList) {
        const contras = s._contradictions || [];
        if (!contras.length) {
            cSection.style.display = 'none';
        } else {
            cSection.style.display = '';
            const frag = document.createDocumentFragment();
            [...contras].reverse().forEach((c, i) => {
                const realIdx = contras.length - 1 - i;
                const d = document.createElement('div');
                d.className = `rpg-contradiction-item rpg-contra-${c.type||'warn'}`;
                const icon = c.type === 'vir_drift' ? '👁️' : c.type === 'delta_clamped' ? '📊' : c.type === 'parse_miss' ? '📭' : '⚠️';
                d.innerHTML = `<span class="rpg-contra-turn">T${c.turn||0}</span><span class="rpg-contra-icon">${icon}</span><span class="rpg-contra-msg">${esc(c.message||'')}</span><span class="rpg-contra-actions"><button class="rpg-contra-btn rpg-contra-dismiss" data-idx="${realIdx}" title="Dismiss">✕</button><button class="rpg-contra-btn rpg-contra-correct" data-msg="${esc(c.message||'')}" title="Send correction">↩</button></span>`;
                frag.appendChild(d);
            });
            cList.replaceChildren(frag);

            // Bind dismiss buttons
            cList.querySelectorAll('.rpg-contra-dismiss').forEach(el => {
                const btn = /** @type {HTMLElement} */(el);
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.idx || '0');
                    const st = getState();
                    if (st._contradictions[idx]) { st._contradictions.splice(idx, 1); saveState(); scheduleRender(); }
                });
            });
            // Bind send-correction buttons
            cList.querySelectorAll('.rpg-contra-correct').forEach(el => {
                const btn = /** @type {HTMLElement} */(el);
                btn.addEventListener('click', () => {
                    const msg = btn.dataset.msg || '';
                    const ta = /** @type {HTMLTextAreaElement|null} */(document.getElementById('send_textarea'));
                    if (ta) { ta.value = (ta.value.trim() ? ta.value + '\n' : '') + `[Correction needed: ${msg}]`; ta.dispatchEvent(new Event('input', {bubbles:true})); ta.focus(); }
                });
            });
        }
    }

    // Wire clear-all button (once, after first render)
    const clearBtn = /** @type {HTMLElement|null} */(w.querySelector('#rpg-clear-contradictions'));
    if (clearBtn && !clearBtn.dataset.bound) {
        clearBtn.dataset.bound = '1';
        clearBtn.addEventListener('click', () => { const st = getState(); st._contradictions = []; saveState(); scheduleRender(); });
    }

    // ── v4.1 C.1: World Simulation tab ───────────────────────────
    const simOffEl = w.querySelector('#rpg-sim-offscene');
    if (simOffEl) {
        const peopleHere = new Set(s.map?.peopleHere || []);
        const off = (s.npcs || []).filter(n => n.name && !peopleHere.has(n.name));
        if (!off.length) {
            simOffEl.innerHTML = '<span class="rpg-empty">No off-scene NPCs.</span>';
        } else {
            const tNow = s._turnCount || 0;
            const html = off.map(n => {
                const lastSeen = s._npcLastSeenTurn?.[n.name];
                const gap = lastSeen !== undefined ? ` <span style="opacity:.6;font-size:11px;">(${tNow - lastSeen}t ago)</span>` : '';
                const lastLoc = n.lastSeenAt ? ` <span style="opacity:.6;font-size:11px;">@ ${esc(n.lastSeenAt)}</span>` : '';
                const note = n.note ? `<div style="opacity:.8;font-size:11px;margin-top:2px;">${esc(n.note)}</div>` : '';
                const goal = n.current_goal ? `<div style="opacity:.7;font-size:11px;margin-top:2px;"><i class="fa-solid fa-crosshairs"></i> ${esc(n.current_goal)}</div>` : '';
                return `<div class="rpg-sim-row" style="padding:6px 8px;margin-bottom:4px;border-left:3px solid var(--border-color);background:rgba(0,0,0,.08);border-radius:3px;"><div><strong>${esc(n.name)}</strong>${gap}${lastLoc} <span style="opacity:.6;font-size:11px;">trust=${n.trust??0}</span></div>${goal}${note}</div>`;
            }).join('');
            simOffEl.innerHTML = html;
        }
    }
    const simStatsEl = w.querySelector('#rpg-sim-stats');
    if (simStatsEl) {
        const feed = (s._statsUpdate || []).slice(-8).reverse();
        if (!feed.length) {
            simStatsEl.innerHTML = '<span class="rpg-empty">No stat events parsed yet.</span>';
        } else {
            const html = feed.map(blk => {
                const events = blk.events.slice(0, 12).map(ev => {
                    const arrow = ev.newV > ev.oldV ? '↑' : ev.newV < ev.oldV ? '↓' : '·';
                    const color = ev.newV > ev.oldV ? '#52c87a' : ev.newV < ev.oldV ? '#e57373' : '#888';
                    return `<div style="font-size:11px;margin-left:8px;"><span style="color:${color};">${arrow}</span> <strong>${esc(ev.character||'?')}</strong>: ${esc(ev.stat)} ${ev.oldV}→${ev.newV}${ev.reason ? ' <span style="opacity:.7;">— ' + esc(ev.reason) + '</span>' : ''}</div>`;
                }).join('');
                return `<div style="margin-bottom:6px;"><div style="font-size:11px;opacity:.6;">Turn ${blk.turn}</div>${events}</div>`;
            }).join('');
            simStatsEl.innerHTML = html;
        }
    }
    const simMilestonesEl = w.querySelector('#rpg-sim-milestones');
    if (simMilestonesEl) {
        const milestones = Object.entries(s._milestonesHit || {})
            .sort(([,a],[,b]) => b - a)
            .slice(0, 10);
        if (!milestones.length) {
            simMilestonesEl.innerHTML = '<span class="rpg-empty">No milestones hit yet.</span>';
        } else {
            const html = milestones.map(([key, turn]) => {
                const [name, field, tier] = key.split('|');
                return `<div style="font-size:11px;margin-bottom:2px;"><span style="opacity:.5;">T${turn}</span> <strong>${esc(name)}</strong> ${esc(field)} crossed ${tier}</div>`;
            }).join('');
            simMilestonesEl.innerHTML = html;
        }
    }

    // ── active goal strip (always-visible banner) ─────────────
    const goalStrip = /** @type {HTMLElement|null} */(w.querySelector('#rpg-active-goal-strip'));
    const goalText  = w.querySelector('#rpg-active-goal-text');
    if (goalStrip && goalText) {
        if (s.active_goal) {
            goalText.textContent = s.active_goal;
            goalStrip.style.display = '';
        } else {
            goalStrip.style.display = 'none';
        }
    }

    // ── facts (Journal tab) ───────────────────────────────────
    const factsEl = w.querySelector('#rpg-facts-list');
    if (factsEl) {
        const facts = s.facts || [];
        if (!facts.length) { factsEl.innerHTML='<span class="rpg-empty">No pinned facts yet.</span>'; }
        else {
            const frag = document.createDocumentFragment();
            const order = ['critical','high','normal',undefined];
            const sorted = [...facts].sort((a,b) => order.indexOf(a.priority) - order.indexOf(b.priority));
            sorted.forEach(f => {
                const d = document.createElement('div');
                d.className = `rpg-fact-item rpg-fact-${f.priority||'normal'}`;
                const icon = f.priority==='critical'?'⚠️':f.priority==='high'?'📌':'•';
                d.innerHTML = `<span class="rpg-fact-icon">${icon}</span><span class="rpg-fact-text">${esc(f.text)}</span><span class="rpg-fact-id">${esc(f.id)}</span>`;
                frag.appendChild(d);
            });
            factsEl.replaceChildren(frag);
        }
    }

    // ── key moments (Journal tab) ─────────────────────────────
    const kmEl = w.querySelector('#rpg-key-moments-list');
    if (kmEl) {
        const moments = s.keyMoments || [];
        if (!moments.length) { kmEl.innerHTML='<span class="rpg-empty">No key moments crystallized yet.</span>'; }
        else {
            const frag = document.createDocumentFragment();
            [...moments].slice(-10).reverse().forEach(m => {
                const d = document.createElement('div');
                d.className = 'rpg-key-moment-item';
                d.innerHTML = `<span class="rpg-km-turn">T${m.turn}</span><span class="rpg-km-text">${esc(m.text)}</span>`;
                frag.appendChild(d);
            });
            kmEl.replaceChildren(frag);
        }
    }

    // ── scene objects (World tab) ─────────────────────────────
    const soEl = w.querySelector('#rpg-scene-objects-list');
    if (soEl) {
        const objs = s.scene_objects || [];
        if (!objs.length) { soEl.innerHTML='<span class="rpg-empty">No persistent objects tracked.</span>'; }
        else {
            const frag = document.createDocumentFragment();
            objs.forEach(o => {
                const d = document.createElement('div');
                d.className = 'rpg-scene-object-item';
                d.innerHTML = `<i class="fa-solid fa-cube" style="opacity:.6;margin-right:5px;font-size:10px;"></i><strong>${esc(o.name||o.id)}</strong>${o.desc?' — '+esc(o.desc):''}${o.location?` <span class="rpg-muted">(${esc(o.location)})</span>`:''}`;
                frag.appendChild(d);
            });
            soEl.replaceChildren(frag);
        }
    }

    // ── personas (Identity tab) ───────────────────────────────
    const personasEl = w.querySelector('#rpg-personas-list');
    if (personasEl) {
        const personas = s.personas || {};
        if (!Object.keys(personas).length) { personasEl.innerHTML='<span class="rpg-empty">No persona cards yet. AI will populate via personas:{} data.</span>'; }
        else {
            const frag = document.createDocumentFragment();
            Object.entries(personas).forEach(([nm, p]) => {
                const card = document.createElement('div');
                card.className = 'rpg-persona-card';
                const PERSONA_FIELDS = [
                    {k:'voice',      l:'🎙 Voice'},
                    {k:'core_belief',l:'💡 Belief'},
                    {k:'forbidden',  l:'🚫 Forbidden'},
                    {k:'fears',      l:'😨 Fears'},
                    {k:'goals',      l:'🎯 Goals'},
                    {k:'quirks',     l:'🌀 Quirks'},
                    {k:'speech_example',l:'💬 Example'},
                ];
                const nameDiv = document.createElement('div');
                nameDiv.className = 'rpg-persona-name';
                nameDiv.textContent = `🎭 ${nm}`;
                card.appendChild(nameDiv);
                PERSONA_FIELDS.filter(({k})=>p[k]).forEach(({k,l})=>{
                    const row = document.createElement('div'); row.className='rpg-persona-field';
                    row.innerHTML=`<span class="rpg-persona-label">${l}:</span><span class="rpg-persona-val${k==='forbidden'?' rpg-persona-forbidden':''}">${esc(p[k])}</span>`;
                    card.appendChild(row);
                });
                frag.appendChild(card);
            });
            personasEl.replaceChildren(frag);
        }
    }

    // ── macros ────────────────────────────────────────────────
    const mb=w.querySelector('#rpg-macros-bar');
    if(mb) buildMacroBar(mb,s.combat?.active);

    // ── tab badges ────────────────────────────────────────────
    const questCount = (s.quests||[]).filter(q=>q.status==='active').length;
    const npcCount = (s.npcs||[]).length;
    const partyCount = Object.keys(s.party||{}).length;
    const virCount = Object.keys(s.vir||{}).length;
    const ledgerCount = Object.keys(s.relationships||{}).length + (s.secrets||[]).length + (s.open_threats||[]).length;
    const journalCount = (s.facts?.length||0) + (s.keyMoments?.length||0);
    const contradictionCount = (s._contradictions||[]).length;
    w.querySelectorAll('.rpg-hud-tab[data-target]').forEach(t => {
        const tab = /** @type {HTMLElement} */(t);
        const existing = tab.querySelector('.rpg-tab-badge');
        let count = 0;
        if (tab.dataset.target === 'panel-quests') count = questCount;
        else if (tab.dataset.target === 'panel-npcs') count = npcCount;
        else if (tab.dataset.target === 'panel-party') count = partyCount;
        else if (tab.dataset.target === 'panel-identity') count = virCount;
        else if (tab.dataset.target === 'panel-ledger') count = ledgerCount;
        else if (tab.dataset.target === 'panel-journal') count = journalCount;
        if (count > 0) {
            if (existing) existing.textContent = String(count);
            else { const b = document.createElement('span'); b.className='rpg-tab-badge'; b.textContent=String(count); tab.appendChild(b); }
        } else if (existing) { existing.remove(); }
        // Drift warning: color Journal tab orange/red when contradictions detected
        if (tab.dataset.target === 'panel-journal' && contradictionCount > 0) {
            tab.classList.add('rpg-tab-drift');
            tab.title = `${contradictionCount} contradiction(s) detected`;
        } else if (tab.dataset.target === 'panel-journal') {
            tab.classList.remove('rpg-tab-drift');
            tab.title = '';
        }
    });

    // ── PANEL: Identity (VIR, charInner, charExternal, mindset, charDev, VAD) ──
    const idPanel = w.querySelector('#panel-identity');
    if (idPanel) {
        const cfg = getCFG();
        const showCharDev = cfg.opts?.showCharDev || false;
        const gm = cfg.opts?.gmEdit || false;

        // Scene summary strip (compact char cards at top)
        const sceneSumEl = w.querySelector('#rpg-scene-summary');
        if (sceneSumEl) {
            const charList = [];
            if (s.charExternal?.name) charList.push({ name: s.charExternal.name, mood: s.mindset?.mood||'', hp: s.charInner?.health ?? null });
            // Build from party as well
            Object.keys(s.party||{}).forEach(nm => {
                if (!charList.find(c=>c.name===nm)) charList.push({ name:nm, mood:'', hp: s.party[nm].hp ?? null });
            });
            if (charList.length > 1) {
                sceneSumEl.innerHTML = charList.map(c=>
                    `<div class="rpg-scene-char-card"><span class="sc-name">${esc(c.name)}</span>${c.mood?`<span class="sc-mood">${esc(c.mood)}</span>`:''
                    }${c.hp!==null?`<span class="sc-hp">${c.hp}</span>`:''}</div>`).join('');
                sceneSumEl.style.display = '';
            } else { sceneSumEl.innerHTML = ''; sceneSumEl.style.display = 'none'; }
        }

        // charInner bars
        const ciEl = w.querySelector('#rpg-charinner-bars');
        if (ciEl) {
            const INNER_CFG = [
                {k:'health',    l:'❤️ Health',      c:'#e05252'},
                {k:'moral',     l:'⚖️ Moral',        c:'#70b0e8'},
                {k:'confidence',l:'✨ Confidence',  c:'#e8d070'},
                {k:'shame',     l:'🫣 Shame',        c:'#c270e8'},
                {k:'promiscuity',l:'❤️‍🔥 Promiscuity',c:'#e870b8'},
                {k:'arousal',   l:'😍 Arousal',      c:'#e87070'},
                {k:'dependence',l:'🦴 Dependence',   c:'#70e8a8'},
                {k:'love',      l:'💘 Love',          c:'#e8a870'},
            ];
            const ci = s.charInner || {};
            const hasCI = INNER_CFG.some(({k})=>ci[k]!==undefined);
            if (!hasCI) { ciEl.innerHTML = '<span class="rpg-empty">No inner stats tracked yet.</span>'; }
            else {
                const frag = document.createDocumentFragment();
                INNER_CFG.filter(({k})=>ci[k]!==undefined).forEach(({k,l,c})=>{
                    const val = ci[k];
                    const div = document.createElement('div'); div.className='rpg-vital';
                    const hdr = document.createElement('div'); hdr.className='rpg-vital-header';
                    const lbl = document.createElement('span'); lbl.className='rpg-vital-label'; lbl.textContent=l;
                    const valSpan = document.createElement('span'); valSpan.className=`rpg-vital-value rpg-inner-val`;
                    valSpan.dataset.key=k; valSpan.textContent=String(val);
                    if (gm) {
                        valSpan.style.cursor='pointer'; valSpan.title='Click to edit';
                        valSpan.addEventListener('click', ()=>{
                            const inp=document.createElement('input'); inp.type='number'; inp.min='0'; inp.max='100'; inp.value=String(val);
                            inp.className='rpg-inline-input'; inp.style.width='3.5em';
                            valSpan.replaceWith(inp); inp.focus(); inp.select();
                            const commit=()=>{ const st=getState(); st.charInner[k]=Math.max(0,Math.min(100,Number(inp.value)||0)); saveState(); scheduleRender(); };
                            inp.addEventListener('blur',commit); inp.addEventListener('keydown',ev=>{if(ev.key==='Enter')commit();if(ev.key==='Escape')scheduleRender();});
                        });
                    }
                    hdr.appendChild(lbl); hdr.appendChild(valSpan);
                    const track=document.createElement('div'); track.className='rpg-bar-track';
                    const fill=document.createElement('div'); fill.className='rpg-bar-fill';
                    fill.style.cssText=`background:${c};transform:scaleX(${Math.max(0,Math.min(1,val/100))})`;
                    track.appendChild(fill); div.appendChild(hdr); div.appendChild(track);
                    frag.appendChild(div);
                });
                ciEl.replaceChildren(frag);
            }
        }

        // charExternal fields (click-to-edit)
        const ceEl = w.querySelector('#rpg-charexternal-fields');
        if (ceEl) {
            const ce = s.charExternal || {};
            const EXT_CFG = [
                {k:'hair',l:'💇 Hair'},{k:'makeup',l:'💄 Makeup'},{k:'outfit',l:'👗 Outfit'},
                {k:'stateOfDress',l:'🎭 State'},{k:'postureAndInteraction',l:'🤸 Posture'},
            ];
            const hasCE = EXT_CFG.some(({k})=>ce[k]);
            if (!hasCE) { ceEl.innerHTML='<span class="rpg-empty">No appearance data yet.</span>'; }
            else {
                const frag=document.createDocumentFragment();
                EXT_CFG.filter(({k})=>ce[k]).forEach(({k,l})=>{
                    const row=document.createElement('div'); row.className='rpg-ext-row';
                    const lbl=document.createElement('div'); lbl.className='rpg-ext-label'; lbl.textContent=l;
                    const val=document.createElement('div'); val.className='rpg-ext-value';
                    val.textContent=ce[k]; val.dataset.key=k;
                    if (gm) {
                        val.style.cursor='pointer'; val.title='Click to edit';
                        val.addEventListener('click',()=>{
                            const inp=document.createElement('input'); inp.type='text'; inp.value=ce[k]||'';
                            inp.className='rpg-inline-input'; inp.style.cssText='width:100%;min-width:120px';
                            val.replaceWith(inp); inp.focus(); inp.select();
                            const commit=()=>{ const st=getState(); if(inp.value.trim()) st.charExternal[k]=inp.value.trim(); saveState(); scheduleRender(); };
                            inp.addEventListener('blur',commit); inp.addEventListener('keydown',ev=>{if(ev.key==='Enter')commit();if(ev.key==='Escape')scheduleRender();});
                        });
                    }
                    row.appendChild(lbl); row.appendChild(val); frag.appendChild(row);
                });
                ceEl.replaceChildren(frag);
            }
        }

        // mindset
        const msEl = w.querySelector('#rpg-mindset');
        if (msEl) {
            const ms = s.mindset || {};
            if (!ms.mood && !ms.thoughts) { msEl.innerHTML='<span class="rpg-empty">No mindset data yet.</span>'; }
            else {
                msEl.innerHTML = `${ms.mood?`<div class="rpg-mindset-row"><span class="rpg-mindset-icon">🎭</span><span class="rpg-mindset-label">Mood:</span><span class="rpg-mindset-val">${esc(ms.mood)}</span></div>`:''}${ms.thoughts?`<div class="rpg-mindset-row"><span class="rpg-mindset-icon">💭</span><span class="rpg-mindset-label">Thoughts:</span><span class="rpg-mindset-val">${esc(ms.thoughts)}</span></div>`:''}`;
            }
        }

        // charDev (behind showCharDev toggle)
        const cdEl = w.querySelector('#rpg-chardev-bars');
        if (cdEl) {
            cdEl.closest('.rpg-chardev-section')?.style.setProperty('display', showCharDev ? '' : 'none');
            if (showCharDev) {
                const DEV_CFG = [
                    {k:'clitoris',l:'🥑',c:'#e87070'},{k:'vagina',l:'🌹',c:'#c270e8'},
                    {k:'anus',l:'🏵️',c:'#70b0e8'},{k:'oral',l:'👄',c:'#e8a870'},
                    {k:'breasts',l:'🔔',c:'#e8d070'},{k:'nipples',l:'🍼',c:'#56c256'},
                    {k:'masochism',l:'🪢',c:'#e870b8'},{k:'caressing',l:'👋',c:'#70e8a8'},
                ];
                const cd = s.charDev || {};
                const hasCD = DEV_CFG.some(({k})=>cd[k]!==undefined);
                if (!hasCD) { cdEl.innerHTML='<span class="rpg-empty">No dev stats yet.</span>'; }
                else {
                    const frag=document.createDocumentFragment();
                    DEV_CFG.filter(({k})=>cd[k]!==undefined).forEach(({k,l,c})=>{
                        const val=cd[k]; const div=document.createElement('div'); div.className='rpg-vital';
                        div.innerHTML=`<div class="rpg-vital-header"><span class="rpg-vital-label">${l} ${k.charAt(0).toUpperCase()+k.slice(1)}</span><span class="rpg-vital-value">${val}</span></div><div class="rpg-bar-track"><div class="rpg-bar-fill" style="background:${c};transform:scaleX(${Math.max(0,Math.min(1,val/100))})"></div></div>`;
                        frag.appendChild(div);
                    });
                    cdEl.replaceChildren(frag);
                }
            }
        }

        // VIR cards (click-to-edit all fields)
        const virEl = w.querySelector('#rpg-vir-cards');
        if (virEl) {
            const VIR_LABELS = {species:'🧬 Species',anatomy:'🦴 Anatomy',hair:'💇 Hair',eyes:'👁️ Eyes',skin:'🎨 Skin',body:'📐 Body',permanent:'⚓ Permanent',franchise:'🎮 Source',outfit:'👗 Outfit'};
            const virData = s.vir || {};
            if (!Object.keys(virData).length) { virEl.innerHTML='<span class="rpg-empty">No VIR data yet. AI will populate this.</span>'; }
            else {
                const frag=document.createDocumentFragment();
                Object.entries(virData).forEach(([charName, traits])=>{
                    const card=document.createElement('div'); card.className='rpg-vir-card';
                    const nameDiv=document.createElement('div'); nameDiv.className='rpg-vir-char-name'; nameDiv.textContent=`🧬 ${charName}`;
                    card.appendChild(nameDiv);
                    Object.entries(traits).forEach(([k,v])=>{
                        const lbl=VIR_LABELS[k]||k;
                        const row=document.createElement('div'); row.className='rpg-vir-field'; row.dataset.virChar=charName; row.dataset.virKey=k;
                        const labelEl=document.createElement('span'); labelEl.className='rpg-vir-field-label'; labelEl.textContent=lbl+':';
                        const valEl=document.createElement('span'); valEl.className='rpg-vir-field-value'; valEl.textContent=String(v||'');
                        valEl.style.cursor='pointer'; valEl.title='Click to edit VIR trait';
                        valEl.addEventListener('click',()=>{
                            const inp=document.createElement('input'); inp.type='text'; inp.value=String(v||'');
                            inp.className='rpg-inline-input'; inp.style.cssText='width:100%;min-width:100px;flex:1';
                            valEl.replaceWith(inp); inp.focus(); inp.select();
                            const commit=()=>{
                                const newVal=inp.value.trim(); const st=getState();
                                if (!st.vir[charName]) st.vir[charName]={};
                                if (newVal) st.vir[charName][k]=newVal; else { delete st.vir[charName][k]; if(!Object.keys(st.vir[charName]).length) delete st.vir[charName]; }
                                saveState(); scheduleRender();
                                console.log(`[st-rpg-hud] VIR edited: ${charName}.${k} = ${newVal}`);
                            };
                            inp.addEventListener('blur',commit); inp.addEventListener('keydown',ev=>{if(ev.key==='Enter')commit();if(ev.key==='Escape')scheduleRender();});
                        });
                        row.appendChild(labelEl); row.appendChild(valEl); card.appendChild(row);
                    });
                    frag.appendChild(card);
                });
                virEl.replaceChildren(frag);
            }
        }

        // VAD (Valence/Arousal/Dominance sparklines)
        const vadEl = w.querySelector('#rpg-vad-panel');
        if (vadEl) {
            const vadData = s.vad || {};
            if (!Object.keys(vadData).length) { vadEl.innerHTML='<span class="rpg-empty">No VAD data yet.</span>'; }
            else {
                const VAD_AXES=[{key:'valence',label:'Valence',icon:'💜',cls:'vad-valence'},{key:'arousal',label:'Arousal',icon:'⚡',cls:'vad-arousal'},{key:'dominance',label:'Dom',icon:'👑',cls:'vad-dominance'}];
                const frag=document.createDocumentFragment();
                Object.entries(vadData).forEach(([nm,vad])=>{
                    const npc=document.createElement('div'); npc.className='rpg-vad-npc';
                    const nm2=document.createElement('div'); nm2.className='rpg-vad-npc-name'; nm2.textContent=nm; npc.appendChild(nm2);
                    VAD_AXES.filter(a=>vad[a.key]!==undefined).forEach(a=>{
                        const pct=Math.max(0,Math.min(100,Number(vad[a.key])));
                        const row=document.createElement('div'); row.className='rpg-vad-row';
                        row.innerHTML=`<span class="rpg-vad-icon">${a.icon}</span><span class="rpg-vad-lbl">${a.label}</span><div class="rpg-vad-bar-track"><div class="rpg-vad-bar-fill" style="transform:scaleX(${pct/100})"></div></div><span class="rpg-vad-val">${pct}</span>`;
                        npc.appendChild(row);
                    });
                    frag.appendChild(npc);
                });
                vadEl.replaceChildren(frag);
            }
        }
    }

    // ── PANEL: Ledger (relationships + secrets + open_threats) ──
    const ledgerPanel = w.querySelector('#panel-ledger');
    if (ledgerPanel) {
        const FLAG_COLORS = {
            romantic_interest:'flag-romantic', sexual_partner:'flag-sexual',
            sworn_enemy:'flag-enemy', owes_debt:'flag-debt',
            witnessed_theft:'flag-warn', knows_secret:'flag-secret',
        };

        // Relationships — bipolar trust bars
        const relEl = w.querySelector('#rpg-relationships-list');
        if (relEl) {
            const rels = s.relationships || {};
            if (!Object.keys(rels).length) { relEl.innerHTML='<span class="rpg-empty">No relationships tracked yet.</span>'; }
            else {
                const frag=document.createDocumentFragment();
                Object.entries(rels).forEach(([nm,rel])=>{
                    const trust = rel.trust ?? rel.trust_score ?? 0;
                    const pos=(trust+100)/2;
                    const left=Math.min(pos,50); const width=Math.abs(pos-50);
                    const clr=trust>=0?'var(--trust-pos,#4caf80)':'var(--trust-neg,#e05252)';
                    const flags=(rel.flags||[]).map(f=>{
                        const cls=FLAG_COLORS[f]||'flag-default';
                        return `<span class="rpg-flag-chip ${cls}">${esc(f.replace(/_/g,' '))}</span>`;
                    }).join('');
                    const histHtml = (rel._history||[]).slice(-3).map(h=>`<span class="rpg-rel-hist-entry ${h.delta>0?'pos':'neg'}">${h.delta>0?'+':''}${h.delta} ${h.field}${h.reason?` — ${h.reason}`:''}</span>`).join('');
                    const d=document.createElement('div'); d.className='rpg-ledger-row';
                    d.innerHTML=`<div class="rpg-ledger-name">${esc(nm)}</div><div class="rpg-trust-wrap"><div class="rpg-trust-bar"><div class="rpg-trust-fill" style="left:${left}%;width:${width}%;background:${clr}"></div></div><span class="rpg-trust-val" style="color:${clr}">${trust>0?'+':''}${trust}</span></div>${flags?`<div class="rpg-flag-row">${flags}</div>`:''}${histHtml?`<div class="rpg-rel-history">${histHtml}</div>`:''}`;
                    frag.appendChild(d);
                });
                relEl.replaceChildren(frag);
            }
        }

        // Secrets
        const secEl = w.querySelector('#rpg-secrets-list');
        if (secEl) {
            const secrets = s.secrets || [];
            if (!secrets.length) { secEl.innerHTML='<span class="rpg-empty">No secrets tracked.</span>'; }
            else {
                const known=secrets.filter(sec=>sec.revealed); const hidden=secrets.filter(sec=>!sec.revealed);
                const frag=document.createDocumentFragment();
                if (known.length) {
                    const lbl=document.createElement('div'); lbl.className='rpg-secrets-sublabel'; lbl.textContent='Known'; frag.appendChild(lbl);
                    known.forEach(sec=>{
                        const d=document.createElement('div'); d.className='rpg-secret-card rpg-secret-known';
                        d.innerHTML=`<div class="rpg-secret-label">🔓 ${esc(sec.id||sec.title||'Secret')}</div><div class="rpg-secret-text">${esc(sec.text||sec.content||'')}</div>`;
                        frag.appendChild(d);
                    });
                }
                if (hidden.length) {
                    const lbl=document.createElement('div'); lbl.className='rpg-secrets-sublabel'; lbl.textContent='Hidden'; frag.appendChild(lbl);
                    hidden.forEach(()=>{
                        const d=document.createElement('div'); d.className='rpg-secret-card rpg-secret-hidden';
                        d.innerHTML=`<div class="rpg-secret-label">🔒 (secret hidden)</div><div class="rpg-secret-text rpg-secret-redacted">██████████</div>`;
                        frag.appendChild(d);
                    });
                }
                secEl.replaceChildren(frag);
            }
        }

        // Open threats
        const threatEl = w.querySelector('#rpg-threats-list');
        if (threatEl) {
            if (!s.open_threats?.length) { threatEl.innerHTML='<span class="rpg-empty">No active threats.</span>'; }
            else {
                const frag=document.createDocumentFragment();
                s.open_threats.forEach(t=>{
                    const d=document.createElement('div'); d.className='rpg-threat-item';
                    d.innerHTML=`<strong>⚠️ ${esc(t.source||'?')}</strong><span class="rpg-threat-nature">${esc(t.nature||'')}</span><span class="rpg-threat-trigger">${esc(t.trigger||'')}</span>`;
                    frag.appendChild(d);
                });
                threatEl.replaceChildren(frag);
            }
        }

        // Phase 6: scene_state (sceneWide lighting + perCharacter mutable state)
        const sceneWideEl = w.querySelector('#rpg-scene-state-wide');
        if (sceneWideEl) {
            const sw = s.scene_state?.sceneWide;
            if (!sw || !Object.keys(sw).length) {
                sceneWideEl.innerHTML = '<span class="rpg-empty">No scene-wide state.</span>';
            } else {
                const fields = ['key_light','rim_light','ambient','palette','atmosphere','camera_baseline'];
                const parts = fields.filter(f => sw[f]).map(f => `<div class="rpg-scene-kv"><span class="rpg-scene-key">${f.replace('_',' ')}</span><span class="rpg-scene-val">${esc(sw[f])}</span></div>`);
                sceneWideEl.innerHTML = parts.length ? '<div class="rpg-scene-grid">'+parts.join('')+'</div>' : '<span class="rpg-empty">No scene-wide state.</span>';
            }
        }
        const sceneCharEl = w.querySelector('#rpg-scene-state-perchar');
        if (sceneCharEl) {
            const pc = s.scene_state?.perCharacter;
            if (!pc || !Object.keys(pc).length) {
                sceneCharEl.innerHTML = '';
            } else {
                const charFields = ['hair_state','exertion_state','injuries','outfit_damage','hand_contents','makeup_state','gaze_target','body_state'];
                const blocks = Object.entries(pc).map(([name, st]) => {
                    if (!st || typeof st !== 'object') return '';
                    const parts = charFields.filter(f => st[f] !== undefined && st[f] !== null && st[f] !== '')
                                            .map(f => `<span class="rpg-scene-tag"><b>${f.replace('_',' ')}:</b> ${esc(st[f])}</span>`);
                    if (!parts.length) return '';
                    return `<div class="rpg-scene-char-row"><div class="rpg-scene-char-name">${esc(name)}</div><div class="rpg-scene-char-tags">${parts.join('')}</div></div>`;
                }).filter(Boolean);
                sceneCharEl.innerHTML = blocks.join('');
            }
        }
    }

    // ── Topics footer ─────────────────────────────────────────
    const topicsEl = w.querySelector('#rpg-topics-footer');
    if (topicsEl) {
        const topics = s.topics;
        if (topics) {
            const parts = [];
            if (topics.genre) parts.push(`<span class="rpg-genre-badge rpg-genre-${(topics.genre||'').toLowerCase()}">${esc(topics.genre)}</span>`);
            if (topics.primaryTopic) parts.push(`Topic: <b>${esc(topics.primaryTopic)}</b>`);
            if (topics.emotionalTone) parts.push(`Tone: ${esc(topics.emotionalTone)}`);
            if (topics.interactionTheme) parts.push(`Theme: ${esc(topics.interactionTheme)}`);
            topicsEl.innerHTML = parts.join('<span class="rpg-topic-sep">·</span>');
            topicsEl.style.display = '';
        } else {
            topicsEl.style.display = 'none';
        }
    }

    // ── Genre badge on location bar ────────────────────────────
    const genreBadgeEl = w.querySelector('#rpg-genre-badge');
    if (genreBadgeEl) {
        const genre = s.topics?.genre;
        if (genre) {
            genreBadgeEl.textContent = genre;
            genreBadgeEl.className = `rpg-genre-badge rpg-genre-${genre.toLowerCase()}`;
            genreBadgeEl.style.display = '';
        } else { genreBadgeEl.style.display = 'none'; }
    }
}


// ── HUD injection ─────────────────────────────────────────────
function injectHud() {
    if (!isEnabled()) return;
    const blocks = document.querySelectorAll('#chat .mes');
    if (!blocks.length) return;
    let target = null;
    for (let i = blocks.length-1; i >= 0; i--) {
        if (blocks[i].getAttribute('is_user') !== 'true') { target = blocks[i]; break; }
    }
    if (!target) return;

    // ── Move-only optimisation: skip full rebuild if already in position ──
    const existing = document.querySelector('.rpg-hud-wrapper');
    if (existing && existing.previousElementSibling === target) {
        scheduleRender();
        return;
    }

    // Remove stale HUDs
    document.querySelectorAll('.rpg-hud-wrapper').forEach(e => e.remove());

    const wrap = document.createElement('div');
    wrap.className = 'rpg-hud-wrapper';
    if (localStorage.getItem(COLLAPSED_STORE) === '1') wrap.classList.add('collapsed');
    // Apply persisted theme and compact mode
    const savedTheme = getCFG().opts?.theme;
    if (savedTheme) wrap.classList.add('theme-'+savedTheme);
    if (getCFG().opts?.compactMode) wrap.classList.add('rpg-compact');
    wrap.innerHTML = _hudTemplate;


    // Add collapse toggle button into tab bar
    const tabBar = wrap.querySelector('.rpg-hud-tabs');
    if (tabBar) {
        const colBtn = document.createElement('div');
        colBtn.id = 'rpg-collapse-toggle';
        colBtn.className = 'rpg-hud-tab';
        colBtn.title = wrap.classList.contains('collapsed') ? 'Expand HUD' : 'Collapse HUD';
        colBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
        tabBar.appendChild(colBtn);
    }

    // Block ST swipe handlers
    ['pointerdown','mousedown','touchstart'].forEach(ev => {
        wrap.addEventListener(ev, e => e.stopPropagation(), { passive: false });
    });

    target.insertAdjacentElement('afterend', wrap);

    // ── Tabs ──────────────────────────────────────────────────
    const savedTab = localStorage.getItem(TAB_STORE);
    const tabs = wrap.querySelectorAll('.rpg-hud-tab');
    const panels = wrap.querySelectorAll('.rpg-hud-panel');

    tabs.forEach(tab => {
        if (tab.id === 'rpg-gm-toggle') {
            tab.addEventListener('click', () => {
                const cfg = getCFG();
                cfg.opts.gmEdit = !cfg.opts.gmEdit;
                tab.classList.toggle('active', cfg.opts.gmEdit);
                getContext().saveSettingsDebounced();
                scheduleRender();
            });
            tab.classList.toggle('active', !!getCFG().opts.gmEdit);
            return;
        }
        if (tab.id === 'rpg-collapse-toggle') {
            tab.addEventListener('click', () => {
                const collapsed = wrap.classList.toggle('collapsed');
                localStorage.setItem(COLLAPSED_STORE, collapsed ? '1' : '0');
                tab.title = collapsed ? 'Expand HUD' : 'Collapse HUD';
            });
            return;
        }
        // Restore last active tab
        if (savedTab && tab.dataset.target === savedTab) {
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const p = wrap.querySelector(`#${savedTab}`);
            if (p) p.classList.add('active');
        }
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const t = wrap.querySelector(`#${tab.dataset.target}`);
            if (t) t.classList.add('active');
            if (tab.dataset.target) localStorage.setItem(TAB_STORE, tab.dataset.target);
        });
    });

    scheduleRender();
}

// ── Macros ────────────────────────────────────────────────────
const DEFAULT_MACROS = [
    { name:'Attack', icon:'⚔️', text:'*Player attacks!*', combatOnly:true },
    { name:'Defend', icon:'🛡️', text:'*Player defends!*', combatOnly:true },
    { name:'Flee',   icon:'🏃', text:'*Player tries to flee!*', combatOnly:true },
    { name:'Search', icon:'🔍', text:'*Player searches the area.*', combatOnly:false },
    { name:'Rest',   icon:'🏕️', text:'*Player rests to recover.*', combatOnly:false }
];

function getMacros() {
    const cfg = getCFG();
    if (!cfg.opts.macros?.length) cfg.opts.macros = JSON.parse(JSON.stringify(DEFAULT_MACROS));
    return cfg.opts.macros;
}

function buildMacroBar(el, inCombat) {
    if (!el) return; el.innerHTML = '';
    getMacros().forEach(m => {
        if (m.combatOnly && !inCombat) return;
        const btn = document.createElement('button');
        btn.className = 'rpg-macro-btn';
        btn.innerHTML = `${m.icon||''} ${m.name}`;
        btn.addEventListener('click', () => {
            const ta = document.getElementById('send_textarea');
            if (ta) { ta.value=(ta.value.trim()?ta.value+'\n':'')+m.text; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); }
        });
        el.appendChild(btn);
    });
}

// ── Dice overlay ──────────────────────────────────────────────
function showDiceOverlay(stat, dc, mod) {
    document.querySelector('#rpg-dice-overlay')?.remove();
    const s = getState();
    const attrVal = s.attributes?.[stat?.toLowerCase()]?.value;
    const statMod = attrVal != null ? Math.floor((attrVal-10)/2) : (mod||0);
    const modStr = statMod >= 0 ? `+${statMod}` : `${statMod}`;

    const overlay = document.createElement('div');
    overlay.id = 'rpg-dice-overlay';
    overlay.className = 'rpg-dice-overlay';
    overlay.innerHTML = `<div class="rpg-dice-modal">
        <div class="rpg-dice-title">🎲 ${stat?stat.toUpperCase()+' Check':'Dice Roll'}</div>
        <div class="rpg-dice-sub">DC ${dc} · ${modStr}</div>
        <div class="rpg-dice-result spinning" id="rpg-dice-num">—</div>
        <div class="rpg-dice-verdict" id="rpg-dice-verdict">Roll the die…</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:10px;">
            <button class="menu_button" id="rpg-d20">🎲 d20</button>
            <button class="menu_button" id="rpg-adv">⬆ Adv.</button>
            <button class="menu_button" id="rpg-dis">⬇ Disadv.</button>
        </div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const numEl = overlay.querySelector('#rpg-dice-num');
    const vEl = overlay.querySelector('#rpg-dice-verdict');
    const spin = setInterval(() => { if(numEl) numEl.textContent = String(Math.floor(Math.random()*20)+1); }, 80);

    function roll(fn) {
        clearInterval(spin);
        const raw = fn();
        const total = raw + statMod;
        const ok = total >= dc;
        if (numEl) { numEl.textContent=`${raw}${statMod!==0?` (${total})`:''}`; numEl.classList.remove('spinning'); numEl.classList.add(ok?'success':'failure'); }
        if (vEl) { vEl.textContent=ok?`Success! ${total}≥DC${dc}`:`Failure ${total}<DC${dc}`; vEl.style.color=ok?'var(--hud-success)':'var(--hud-danger)'; }
        setTimeout(() => {
            const ta = document.getElementById('send_textarea');
            if (ta) { ta.value=(ta.value.trim()?ta.value+'\n':'')+`[Roll: ${raw}${statMod>=0?'+':''}${statMod!==0?statMod:''} = ${total} vs DC${dc} → ${ok?'SUCCESS':'FAILURE'}]`; ta.dispatchEvent(new Event('input',{bubbles:true})); }
            setTimeout(() => overlay.remove(), 600);
        }, 400);
    }

    overlay.querySelector('#rpg-d20')?.addEventListener('click', () => roll(() => Math.floor(Math.random()*20)+1));
    overlay.querySelector('#rpg-adv')?.addEventListener('click', () => roll(() => Math.max(Math.floor(Math.random()*20)+1, Math.floor(Math.random()*20)+1)));
    overlay.querySelector('#rpg-dis')?.addEventListener('click', () => roll(() => Math.min(Math.floor(Math.random()*20)+1, Math.floor(Math.random()*20)+1)));
}

// ── Settings panel ────────────────────────────────────────────
function replayHistory() {
    const chat = getContext().chat;
    if (!chat || chat.length === 0) { toastr?.warning('No chat history to replay.'); return; }
    // Replay on top of current state — parsers are merge-safe (update-in-place, no duplicates)
    // Use Reset + Replay if you want a fully clean rebuild from scratch
    let processed = 0;
    for (const msg of /** @type {any[]} */ (chat)) {
        if (msg.is_user) continue;
        if (processMessage(msg.mes)) processed++;
    }
    getContext().saveSettingsDebounced();
    injectHud();
    updatePrompt();
    toastr?.success(`Replayed ${chat.length} messages, found RPG data in ${processed}.`);
}

function addSettingsPanel() {
    try {
        const cfg = getCFG();
        const html = `<div class="extension-settings" id="rpg-hud-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>RPG HUD</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
            <div class="inline-drawer-content" style="display:none;">
                <div style="font-size:12px;opacity:0.8;margin-bottom:8px;">v4.0.0 — Full Feature Engine</div>
                <label class="checkbox_label"><input type="checkbox" id="rpg-hud-enable"/> Enable for this Chat</label>
                <hr style="margin:8px 0;border:0;border-top:1px solid var(--border-color);">
                <label>Depth: <input type="number" id="rpg-hud-depth" class="text_pole" value="${cfg.opts.depth??4}" min="0" max="10" style="width:55px;margin-left:6px;"/></label>
                <label style="margin-top:6px;">Budget:
                    <select id="rpg-hud-budget" class="text_pole" style="margin-left:6px;">
                        <option value="compact" ${cfg.opts.budget==='compact'?'selected':''}>Compact</option>
                        <option value="standard" ${!cfg.opts.budget||cfg.opts.budget==='standard'?'selected':''}>Standard</option>
                        <option value="full" ${cfg.opts.budget==='full'?'selected':''}>Full</option>
                    </select>
                </label>
                <label class="checkbox_label" style="margin-top:6px;" title="When enabled, deceased and off-scene characters stay in the VIR roster forever (matches preset's persistence rule).">
                    <input type="checkbox" id="rpg-hud-keepdeceased" ${cfg.opts.keepDeceasedInRoster!==false?'checked':''}/> Keep deceased + off-scene chars in roster
                </label>
                <label class="checkbox_label" style="margin-top:4px;" title="Use multi-pass JSON repair (strip comments, trailing commas, truncate-at-last-balanced-brace).">
                    <input type="checkbox" id="rpg-hud-jsonrepair" ${cfg.opts.aggressiveJsonRepair!==false?'checked':''}/> Aggressive JSON repair
                </label>
                <hr style="margin:8px 0;border:0;border-top:1px solid var(--border-color);">
                <div style="font-size:11px;opacity:0.7;margin-bottom:4px;">⚡ Token-saver settings (v4 plan)</div>
                <label class="checkbox_label" style="margin-top:4px;" title="AI emits only changed fields each turn (delta-only). HUD merges deltas into stored state. Heartbeat triggers a full echo every N turns or after a parse miss.">
                    <input type="checkbox" id="rpg-hud-deltaonly" ${cfg.opts.deltaOnly!==false?'checked':''}/> Delta-only rpg blocks (A.1)
                </label>
                <label class="checkbox_label" style="margin-top:4px;" title="Adaptive FORMAT_REMINDER: minimal schema on steady-state turns, full schema on first turn / after parse miss. Saves ~300 tokens/turn.">
                    <input type="checkbox" id="rpg-hud-adaptivereminder" ${cfg.opts.adaptiveReminder!==false?'checked':''}/> Adaptive FORMAT_REMINDER (A.3)
                </label>
                <label class="checkbox_label" style="margin-top:4px;" title="Tiered state injection: TIER 1 (vitals/loc/goal) always; heavy blocks (story summaries, full relationship history, urgency header) only on full-echo turns. Saves ~200–500 tokens/turn.">
                    <input type="checkbox" id="rpg-hud-tiered" ${cfg.opts.tieredInjection!==false?'checked':''}/> Tiered state injection (A.2)
                </label>
                <label class="checkbox_label" style="margin-top:4px;" title="Write off-scene NPCs to a keyword-gated lorebook entry. Zero tokens until their name is mentioned in chat. Requires world-info.js (built into ST).">
                    <input type="checkbox" id="rpg-hud-offscene-lorebook" ${cfg.opts.offSceneToLorebook!==false?'checked':''}/> Off-scene NPCs → lorebook (A.5)
                </label>
                <label class="checkbox_label" style="margin-top:4px;" title="Show full persona only on first appearance and after parse misses. Subsequent turns show compact form (voice + forbidden only).">
                    <input type="checkbox" id="rpg-hud-compactpersona" ${cfg.opts.compactPersona!==false?'checked':''}/> Compact personas after first show (B.5)
                </label>
                <label style="margin-top:6px;display:block;">Heartbeat (full echo every N turns):
                    <input type="number" id="rpg-hud-heartbeat" class="text_pole" value="${cfg.opts.heartbeatInterval||10}" min="2" max="50" style="width:55px;margin-left:6px;"/>
                </label>
                <label style="margin-top:6px;display:block;">VIR mode:
                    <select id="rpg-hud-virmode" class="text_pole" style="margin-left:6px;">
                        <option value="self"   ${(!cfg.opts.virMode||cfg.opts.virMode==='self')?'selected':''}>Self-contained (default)</option>
                        <option value="bridge" ${cfg.opts.virMode==='bridge'?'selected':''}>Bridge to ff4-vir-lorebook-sync</option>
                        <option value="off"    ${cfg.opts.virMode==='off'?'selected':''}>Off (no VIR in RPG HUD)</option>
                    </select>
                </label>
                <hr style="margin:8px 0;border:0;border-top:1px solid var(--border-color);">
                <div style="font-size:11px;opacity:0.7;margin-bottom:4px;">📚 Rule lorebook (v4.1 A.4)</div>
                <div style="font-size:11px;opacity:0.8;margin-bottom:6px;">Splits the system prompt into 6 lorebook entries: CORE always-on (~350 tok) + 5 keyword-gated topic sections (0 tok until mentioned). Saves ~2000 tokens/turn vs pasting the full system-prompt.md as constant.</div>
                <button class="menu_button" id="rpg-export-rules-btn"><i class="fa-solid fa-book"></i> Export rules to lorebook</button>
                <hr style="margin:8px 0;border:0;border-top:1px solid var(--border-color);">
                <div style="font-size:11px;opacity:0.7;margin-bottom:4px;">📝 Per-chat rule overlay (v4.1 C.6)</div>
                <div style="font-size:11px;opacity:0.8;margin-bottom:6px;">Extra rules injected at TIER 4 for this chat only. Use for genre tone, table conventions, or one-off house rules.</div>
                <textarea id="rpg-hud-overlay" class="text_pole" rows="3" placeholder="e.g. This chat is HORROR — maintain dread tone; no comic relief. Sensory detail prioritised over combat math." style="width:100%;font-size:12px;font-family:inherit;">${esc(getState()._ruleOverlay || '')}</textarea>
                <label style="margin-top:6px;">Theme:
                    <select id="rpg-hud-theme" class="text_pole" style="margin-left:6px;">
                        <option value="" ${!cfg.opts.theme?'selected':''}>Default (Gold)</option>
                        <option value="horror" ${cfg.opts.theme==='horror'?'selected':''}>Horror (Red)</option>
                        <option value="romance" ${cfg.opts.theme==='romance'?'selected':''}>Romance (Pink)</option>
                        <option value="tactical" ${cfg.opts.theme==='tactical'?'selected':''}>Tactical (Green)</option>
                        <option value="scifi" ${cfg.opts.theme==='scifi'?'selected':''}>Sci-Fi (Cyan)</option>
                    </select>
                </label>
                <label class="checkbox_label" style="margin-top:6px;"><input type="checkbox" id="rpg-hud-compact" ${cfg.opts.compactMode?'checked':''}/> Compact Mode</label>
                <label class="checkbox_label" style="margin-top:4px;"><input type="checkbox" id="rpg-hud-chardev" ${cfg.opts.showCharDev?'checked':''}/> Show Dev Stats (adult content)</label>
                <hr style="margin:8px 0;border:0;border-top:1px solid var(--border-color);">
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="menu_button" id="rpg-export-btn"><i class="fa-solid fa-file-export"></i> Export</button>
                    <button class="menu_button" id="rpg-import-btn"><i class="fa-solid fa-file-import"></i> Import</button>
                    <input type="file" id="rpg-import-file" accept=".json" style="display:none;"/>
                    <button class="menu_button" id="rpg-replay-btn" title="Reprocess all AI messages in this chat to rebuild state"><i class="fa-solid fa-clock-rotate-left"></i> Replay History</button>
                    <button class="menu_button" id="rpg-summary-btn" title="Generate session summary report"><i class="fa-solid fa-clipboard-list"></i> Session Summary</button>
                    <button class="menu_button red" id="rpg-reset-btn"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                    <button class="menu_button" id="rpg-disable-outfits-btn" title="Disable the separate Outfit System extension — RPG HUD now tracks outfits"><i class="fa-solid fa-shirt"></i> Disable Outfit Tracker</button>
                </div>
            </div>
        </div>
    </div>`;    const container = document.getElementById('extensions_settings');

    if (container) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html.trim();
        container.appendChild(wrapper.firstChild);
    } else {
        console.error("[st-rpg-hud] Cannot find extensions_settings container!");
    }

    const enableCb = document.getElementById('rpg-hud-enable');
    if (enableCb) enableCb.checked = isEnabled();

    document.getElementById('rpg-hud-enable')?.addEventListener('change', e => {
        const on = e.target.checked;
        const id = getChatId();
        const cfg = getCFG();
        if (on && !cfg.enabledChatIds.includes(id)) cfg.enabledChatIds.push(id);
        else if (!on) cfg.enabledChatIds = cfg.enabledChatIds.filter(x => x !== id);
        getContext().saveSettingsDebounced();
        if (on) injectHud(); else document.querySelectorAll('.rpg-hud-wrapper').forEach(e=>e.remove());
        updatePrompt();
    });
    document.getElementById('rpg-hud-depth')?.addEventListener('change', e => { getCFG().opts.depth=parseInt(e.target.value)||4; getContext().saveSettingsDebounced(); updatePrompt(); });
    document.getElementById('rpg-hud-budget')?.addEventListener('change', e => { getCFG().opts.budget=e.target.value; getContext().saveSettingsDebounced(); updatePrompt(); });
    document.getElementById('rpg-hud-keepdeceased')?.addEventListener('change', e => { getCFG().opts.keepDeceasedInRoster=e.target.checked; getContext().saveSettingsDebounced(); });
    document.getElementById('rpg-hud-jsonrepair')?.addEventListener('change', e => { getCFG().opts.aggressiveJsonRepair=e.target.checked; getContext().saveSettingsDebounced(); });
    // v4 token-saver toggles
    document.getElementById('rpg-hud-deltaonly')?.addEventListener('change', e => { getCFG().opts.deltaOnly=e.target.checked; getContext().saveSettingsDebounced(); updatePrompt(); });
    document.getElementById('rpg-hud-adaptivereminder')?.addEventListener('change', e => { getCFG().opts.adaptiveReminder=e.target.checked; getContext().saveSettingsDebounced(); updatePrompt(); });
    document.getElementById('rpg-hud-tiered')?.addEventListener('change', e => { getCFG().opts.tieredInjection=e.target.checked; getContext().saveSettingsDebounced(); updatePrompt(); });
    document.getElementById('rpg-hud-offscene-lorebook')?.addEventListener('change', e => { getCFG().opts.offSceneToLorebook=e.target.checked; getContext().saveSettingsDebounced(); });
    document.getElementById('rpg-hud-compactpersona')?.addEventListener('change', e => { getCFG().opts.compactPersona=e.target.checked; getContext().saveSettingsDebounced(); updatePrompt(); });
    document.getElementById('rpg-hud-heartbeat')?.addEventListener('change', e => { getCFG().opts.heartbeatInterval=Math.max(2, parseInt(e.target.value)||10); getContext().saveSettingsDebounced(); });
    document.getElementById('rpg-hud-virmode')?.addEventListener('change', e => { getCFG().opts.virMode=e.target.value; getContext().saveSettingsDebounced(); updatePrompt(); });
    document.getElementById('rpg-export-rules-btn')?.addEventListener('click', async () => { try { await exportSystemPromptToLorebook(); } catch(e) { toastr?.error('Export failed: '+e.message); } });
    document.getElementById('rpg-hud-overlay')?.addEventListener('input', e => { getState()._ruleOverlay = e.target.value; saveState(); updatePrompt(); });
    document.getElementById('rpg-export-btn')?.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(getState(),null,2)], {type:'application/json'});
        const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`rpg-hud-${getChatId()}.json`; a.click();
    });
    document.getElementById('rpg-import-btn')?.addEventListener('click', () => document.getElementById('rpg-import-file')?.click());
    document.getElementById('rpg-import-file')?.addEventListener('change', e => {
        const f = e.target.files?.[0]; if(!f) return;
        const r = new FileReader();
        r.onload = ev => {
            try { getCFG().chatStates[getChatId()]=JSON.parse(ev.target.result); getContext().saveSettingsDebounced(); scheduleRender(); toastr?.success('Imported!'); }
            catch { toastr?.error('Invalid JSON'); }
        };
        r.readAsText(f); e.target.value='';
    });
    document.getElementById('rpg-reset-btn')?.addEventListener('click', () => {
        if (!confirm('Reset RPG state for this chat?')) return;
        getCFG().chatStates[getChatId()] = emptyState(); getContext().saveSettingsDebounced(); scheduleRender(); toastr?.success('Reset!');
    });
    document.getElementById('rpg-replay-btn')?.addEventListener('click', () => replayHistory());

    // ── v4: Theme selector ──
    document.getElementById('rpg-hud-theme')?.addEventListener('change', e => {
        const theme = e.target.value;
        getCFG().opts.theme = theme;
        getContext().saveSettingsDebounced();
        // Apply to existing wrapper
        const wrapper = document.querySelector('.rpg-hud-wrapper');
        if (wrapper) {
            ['horror','romance','tactical','scifi'].forEach(t => wrapper.classList.remove('theme-'+t));
            if (theme) wrapper.classList.add('theme-'+theme);
        }
    });

    // ── v4: Compact mode ──
    document.getElementById('rpg-hud-compact')?.addEventListener('change', e => {
        getCFG().opts.compactMode = e.target.checked;
        getContext().saveSettingsDebounced();
        const wrapper = document.querySelector('.rpg-hud-wrapper');
        if (wrapper) wrapper.classList.toggle('rpg-compact', !!e.target.checked);
    });

    // ── v4: Show charDev toggle ──
    document.getElementById('rpg-hud-chardev')?.addEventListener('change', e => {
        getCFG().opts.showCharDev = e.target.checked;
        getContext().saveSettingsDebounced();
        scheduleRender();
    });

    // ── v4: Session Summary button ──
    document.getElementById('rpg-summary-btn')?.addEventListener('click', () => {
        const s = getState();
        const lines = [];
        lines.push(`# RPG Session Summary\n`);
        if (s.charInner && Object.keys(s.charInner).length) {
            lines.push(`## Inner Stats\n`);
            Object.entries(s.charInner).forEach(([k,v])=>lines.push(`- **${k}**: ${v}/100`));
        }
        if (s.quests?.filter(q=>q.status==='completed').length) {
            lines.push(`\n## Completed Quests\n`);
            s.quests.filter(q=>q.status==='completed').forEach(q=>lines.push(`- ✓ ${q.title||q.id}`));
        }
        if (s.npcs?.length) {
            lines.push(`\n## Known NPCs\n`);
            s.npcs.forEach(n=>{ const relParts=['trust','affection','fear'].filter(f=>n[f]!==undefined&&n[f]!==0).map(f=>`${f}=${n[f]}`); lines.push(`- **${n.name}** (${n.role||'?'})${relParts.length?' — '+relParts.join(', '):''}`); });
        }
        if (Object.keys(s.relationships||{}).length) {
            lines.push(`\n## Relationships\n`);
            Object.entries(s.relationships).forEach(([nm,rel])=>lines.push(`- **${nm}**: Trust ${rel.trust??0}${(rel.flags||[]).length?' | Flags: '+rel.flags.join(', '):''}`));
        }
        if (s.vir && Object.keys(s.vir).length) {
            lines.push(`\n## VIR Registry\n`);
            Object.entries(s.vir).forEach(([nm,traits])=>{ lines.push(`### ${nm}`); Object.entries(traits).forEach(([k,v])=>lines.push(`- ${k}: ${v}`)); });
        }
        const md = lines.join('\n');
        // Show as modal
        const overlay = document.createElement('div'); overlay.className='rpg-summary-overlay';
        const modal = document.createElement('div'); modal.className='rpg-summary-modal';
        modal.innerHTML=`<h3>📋 Session Summary</h3><pre style="font-size:12px;white-space:pre-wrap;color:var(--hud-text);line-height:1.5;font-family:var(--hud-font)">${esc(md)}</pre><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="menu_button" id="rpg-copy-summary">Copy</button><button class="menu_button" id="rpg-close-summary">Close</button></div>`;
        overlay.appendChild(modal); document.body.appendChild(overlay);
        overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});
        modal.querySelector('#rpg-close-summary')?.addEventListener('click',()=>overlay.remove());
        modal.querySelector('#rpg-copy-summary')?.addEventListener('click',()=>{ navigator.clipboard?.writeText(md).then(()=>toastr?.success('Copied!')); });
    });

    document.getElementById('rpg-disable-outfits-btn')?.addEventListener('click', async () => {
        try {
            const { disableExtension } = await import('../../../extensions.js');
            await disableExtension('ST-Outfits', false);
            const btn = /** @type {HTMLButtonElement} */ (document.getElementById('rpg-disable-outfits-btn'));
            btn.textContent = '✓ Outfit Tracker disabled (reload to take effect)';
            btn.disabled = true;
            toastr?.success('Outfit System extension disabled. Reload SillyTavern to remove it.');
        } catch(e) {
            toastr?.warning('Could not auto-disable. Please disable "Outfit System" manually in the Extensions panel.');
        }
    });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            const cb = document.getElementById('rpg-hud-enable');
            if (cb) cb.checked = isEnabled();
        });

        // v4.1: register slash commands (lazy-imports ST's slash command API)
        try { registerSlashCommands(); } catch(e) { console.warn('[st-rpg-hud] slash command registration failed', e); }

        if (typeof toastr !== 'undefined') toastr.success("RPG HUD v4.1 Loaded!", "Debug", {timeOut: 3000});
    } catch(e) {
        console.error("[st-rpg-hud] UI Rendering Error:", e);
        if (typeof toastr !== 'undefined') toastr.error("RPG HUD Error: " + e.message, "Debug", {timeOut: 10000});
    }
}


// ── Bootstrap ─────────────────────────────────────────────────
$(async () => {
    try {
        // Load HTML template
        const res = await fetch(`/scripts/extensions/third-party/${EXT}/hud.html`);
        if (res.ok) _hudTemplate = await res.text();
        else throw new Error('hud.html not found');
    } catch(e) {
        console.error('[st-rpg-hud] Failed to load hud.html:', e);
        // Fallback minimal template
        _hudTemplate = `<div id="st-rpg-hud">
            <div class="rpg-hud-tabs" id="rpg-tab-bar">
                <div class="rpg-hud-tab active" data-target="panel-overview"><i class="fa-solid fa-heart-pulse"></i> Overview</div>
                <div class="rpg-hud-tab" data-target="panel-skills"><i class="fa-solid fa-wand-sparkles"></i> Skills</div>
                <div class="rpg-hud-tab" data-target="panel-inventory"><i class="fa-solid fa-toolbox"></i> Gear</div>
                <div class="rpg-hud-tab" data-target="panel-party"><i class="fa-solid fa-users"></i> Party</div>
                <div class="rpg-hud-tab" data-target="panel-quests"><i class="fa-solid fa-scroll"></i> Quests</div>
                <div class="rpg-hud-tab" data-target="panel-npcs"><i class="fa-solid fa-handshake"></i> NPCs</div>
                <div class="rpg-hud-tab" data-target="panel-locations"><i class="fa-solid fa-map-location-dot"></i> World</div>
                <div class="rpg-hud-tab" data-target="panel-journal"><i class="fa-solid fa-book-open"></i> Journal</div>
                <div class="rpg-hud-tab" id="rpg-gm-toggle" title="GM Edit Mode"><i class="fa-solid fa-pen-to-square"></i></div>
            </div>
            <div class="rpg-hud-panels">
                <div id="panel-overview" class="rpg-hud-panel active">
                    <div id="rpg-combat-banner" class="rpg-combat-banner"><i class="fa-solid fa-swords"></i><span id="rpg-combat-label">Combat</span><span id="rpg-ap-display" style="margin-left:auto"></span></div>
                    <div class="rpg-location-bar"><div class="rpg-location-name"><i class="fa-solid fa-location-dot"></i><span id="rpg-location-val">Unknown</span></div><div class="rpg-location-region" id="rpg-region-val"></div></div>
                    <div id="rpg-vitals-container"></div>
                    <div class="rpg-section-heading"><i class="fa-solid fa-dice-d20"></i> Attributes</div>
                    <div id="rpg-attributes-grid" class="rpg-attr-grid"></div>
                    <div class="rpg-section-heading"><i class="fa-solid fa-coins"></i> Resources</div>
                    <div id="rpg-resources-row" class="rpg-resources-row"></div>
                    <div class="rpg-section-heading"><i class="fa-solid fa-flask-vial"></i> Status</div>
                    <div id="rpg-statuses-row" class="rpg-pill-row"></div>
                </div>
                <div id="panel-skills" class="rpg-hud-panel"><div class="rpg-section-heading">Skills</div><div id="rpg-skills-list" class="rpg-pill-row"></div></div>
                <div id="panel-inventory" class="rpg-hud-panel">
                    <div class="rpg-section-heading">Equipped</div><div id="rpg-equip-grid" class="rpg-equip-grid"></div>
                    <div class="rpg-section-heading">Backpack</div><div id="rpg-backpack-grid" class="rpg-backpack-grid"></div>
                </div>
                <div id="panel-party" class="rpg-hud-panel"><div id="rpg-party-list"></div></div>
                <div id="panel-quests" class="rpg-hud-panel">
                    <div class="rpg-section-heading">Active</div><div id="rpg-active-quests"></div>
                    <div class="rpg-section-heading">Done</div><div id="rpg-done-quests"></div>
                </div>
                <div id="panel-npcs" class="rpg-hud-panel"><div id="rpg-npc-list"></div></div>
                <div id="panel-locations" class="rpg-hud-panel">
                    <div class="rpg-location-bar"><div class="rpg-location-name"><i class="fa-solid fa-compass"></i><span id="rpg-world-location">Unknown</span></div><div class="rpg-location-region" id="rpg-world-region"></div></div>
                    <div class="rpg-section-heading"><i class="fa-solid fa-user-group"></i> People Here</div><div id="rpg-people-here" class="rpg-pill-row"></div>
                    <div class="rpg-section-heading"><i class="fa-solid fa-map-pin"></i> Landmarks</div><ul id="rpg-landmarks-list" class="rpg-landmark-list"></ul>
                    <div class="rpg-section-heading"><i class="fa-solid fa-shield-halved"></i> Factions</div><div id="rpg-factions-list"></div>
                    <div class="rpg-section-heading"><i class="fa-solid fa-route"></i> Travel Log</div><div id="rpg-travel-log" class="rpg-travel-log"></div>
                </div>
                <div id="panel-journal" class="rpg-hud-panel"><div id="rpg-journal-list"></div></div>
            </div>
            <div id="rpg-macros-bar"></div>
        </div>`;
    }

    // Delay rendering slightly to ensure ST UI is built, avoiding intervals
    setTimeout(() => {
        try {
            const container = document.getElementById('extensions_settings');
            if (container) {
                if (!document.getElementById('rpg-hud-settings')) {
                    addSettingsPanel();
                }
            } else {
                console.error("[st-rpg-hud] extensions_settings container not found!");
            }
            updatePrompt();
        } catch(e) {
            console.error("[st-rpg-hud] Initialization error:", e);
        }
    }, 1500);

    // Get eventSource + event_types from context (same as ST-Outfits)
    const ctx0 = getContext();
    eventSource = ctx0.eventSource;
    event_types = ctx0.event_types;

    if (!eventSource || !event_types) {
        console.log('[st-rpg-hud] Could not get eventSource from context. Events will not fire.');
        return;
    }

    // ── GENERATION_ENDED — parse after full AI response ——————
    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (!isEnabled()) return;
        const ctx = getContext();
        if (!ctx.chat?.length) return;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const msg = /** @type {any} */ (ctx.chat[i]);
            if (msg && !msg.is_user && !msg.is_system) {
                const rawMes = msg.mes || '';
                let changed = false;
                try { changed = processMessage(rawMes); } catch(e) { console.error('[RPG-HUD] processMessage threw:', e); }
                // Strip <RPG-HUD> wrapper OR bare tags (whichever the AI used)
                const strippedWrapped = stripHud(rawMes);
                const hadWrapper = strippedWrapped !== rawMes;
                const strippedBare = hadWrapper ? strippedWrapped : stripBareTags(rawMes);
                const hadBare = !hadWrapper && strippedBare !== rawMes;
                const anyStripped = hadWrapper || hadBare;
                if (anyStripped) {
                    msg.mes = hadWrapper ? strippedWrapped : strippedBare;
                    try { getContext().saveChat(); } catch(e) { console.warn('[RPG-HUD] saveChat failed:', e); }
                    const domEl = document.querySelector(`.mes[mesid="${i}"] .mes_text`);
                    if (domEl) {
                        if (hadWrapper) domEl.innerHTML = domEl.innerHTML.replace(/<RPG-HUD\s*>[\s\S]*?(?:<\/RPG-HUD>|$)/gi,'');
                        else { for (const tag of BARE_TAG_NAMES) domEl.innerHTML = domEl.innerHTML.replace(new RegExp(`<${tag}[^>]*?(?:\\s*/>|>[\\s\\S]*?<\\/${tag}>)`, 'gi'), ''); }
                    }
                }
                if (changed || anyStripped) updatePrompt();
                injectHud(); // always re-attach to latest AI message
                break;
            }
        }
    });

    // ── CHARACTER_MESSAGE_RENDERED — strip all RPG data from DOM after render ──
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, mesId => {
        if (!isEnabled()) return;
        const idx = typeof mesId === 'number' ? mesId : getContext().chat.length - 1;
        const el = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
        if (el) stripHudFromDom(el);
    });

    // ── MESSAGE_RECEIVED — strip during streaming ──
    eventSource.on(event_types.MESSAGE_RECEIVED, mesId => {
        if (!isEnabled()) return;
        const ctx = getContext();
        const idx = typeof mesId === 'number' ? mesId : ctx.chat.length - 1;
        const msg = /** @type {any} */ (ctx.chat?.[idx]);
        if (!msg || msg.is_user) return;
        const el = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
        if (el) stripHudFromDom(el);
    });

    // ── CHAT_CHANGED
    eventSource.on(event_types.CHAT_CHANGED, () => {
        document.querySelectorAll('.rpg-hud-wrapper').forEach(e => e.remove());
        if (isEnabled()) { injectHud(); }
        updatePrompt();
    });

    // Initial inject if already on an enabled chat
    if (isEnabled()) injectHud();

    // ── MESSAGE_SENDING — prepend VIR registry to user message ──
    // This ensures the AI always has authoritative visual identity data
    if (event_types.MESSAGE_SENDING) {
        eventSource.on(event_types.MESSAGE_SENDING, (data) => {
            if (!isEnabled() || !data || typeof data !== 'object' || !('text' in data)) return;
            const s = getState();
            if (!s?.vir || !Object.keys(s.vir).length) return;

            const virBlock = Object.entries(s.vir).map(([name, traits]) => {
                const fields = Object.entries(traits).map(([k, v]) => `  ${k}: ${v}`).join('\n');
                return `[${name}]\n${fields}`;
            }).join('\n\n');

            data.text =
                `[ACTIVE VIR REGISTRY — Copy these visual traits EXACTLY into every <pic prompt>. ` +
                `Traits are locked against drift; only update via narrated story events + vir delta in \`\`\`rpg block.]\n` +
                `${virBlock}\n` +
                data.text;

            console.log('[st-rpg-hud] VIR injected for:', Object.keys(s.vir).join(', '));
        });
    }


    try {
        const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE } = getContext();
        if (SlashCommandParser && SlashCommand) {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'rpg-toggle',
                callback: () => {
                    const id=getChatId(); const cfg=getCFG();
                    const on=!cfg.enabledChatIds.includes(id);
                    if(on) cfg.enabledChatIds.push(id);
                    else cfg.enabledChatIds=cfg.enabledChatIds.filter(x=>x!==id);
                    getContext().saveSettingsDebounced();
                    const cb=document.getElementById('rpg-hud-enable'); if(cb) cb.checked=on;
                    if(on) injectHud(); else document.querySelectorAll('.rpg-hud-wrapper').forEach(e=>e.remove());
                    updatePrompt();
                    return `RPG HUD ${on?'enabled':'disabled'} for this chat.`;
                },
                helpString: 'Toggle RPG HUD on/off for the current chat.',
            }));

            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'rpg-reset',
                callback: () => {
                    getCFG().chatStates[getChatId()]=emptyState();
                    getContext().saveSettingsDebounced(); scheduleRender();
                    return 'RPG state reset.';
                },
                helpString: 'Reset all RPG state for the current chat.',
            }));

            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'rpg-set',
                callback: (args) => {
                    const id=(args.stat||args.id||'').toLowerCase();
                    const val=parseFloat(args.value??'0');
                    if(!id) return 'Usage: /rpg-set stat=hp value=80';
                    const s=getState();
                    const obj=s.vitals[id]||s.attributes[id]||s.resources[id];
                    if(!obj) return `Stat "${id}" not found.`;
                    obj.value=val;
                    if(args.max!==undefined) obj.max=parseFloat(args.max);
                    saveState(); scheduleRender(); updatePrompt();
                    return `Set ${id} = ${val}`;
                },
                namedArgumentList: [
                    SlashCommandNamedArgument.fromProps({name:'stat',description:'Stat ID (e.g. hp, mp, str)',isRequired:true,typeList:[ARGUMENT_TYPE.STRING]}),
                    SlashCommandNamedArgument.fromProps({name:'value',description:'New value',isRequired:true,typeList:[ARGUMENT_TYPE.NUMBER]}),
                    SlashCommandNamedArgument.fromProps({name:'max',description:'Optional new max',typeList:[ARGUMENT_TYPE.NUMBER]}),
                ],
                helpString: 'Set an RPG stat directly. Example: <code>/rpg-set stat=hp value=50 max=100</code>',
            }));

            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'rpg-quest',
                callback: (args) => {
                    const title=args.title||'';
                    const act=(args.action||'add').toLowerCase();
                    if(!title) return 'Usage: /rpg-quest title="Quest Name" action=add';
                    const s=getState();
                    const idx=s.quests.findIndex(q=>q.title===title||q.id===title);
                    if(act==='add'&&idx===-1){ s.quests.push({id:title,title,desc:args.desc||'',steps:[],status:'active',category:'main'}); }
                    else if(act==='complete'&&idx!==-1){ s.quests[idx].status='completed'; }
                    else if(act==='fail'&&idx!==-1){ s.quests[idx].status='failed'; }
                    else return `Quest "${title}" not found or already exists.`;
                    saveState(); scheduleRender();
                    return `Quest "${title}" ${act==='add'?'added':act+'d'}.`;
                },
                namedArgumentList: [
                    SlashCommandNamedArgument.fromProps({name:'title',description:'Quest title',isRequired:true,typeList:[ARGUMENT_TYPE.STRING]}),
                    SlashCommandNamedArgument.fromProps({name:'action',description:'add | complete | fail',typeList:[ARGUMENT_TYPE.STRING]}),
                    SlashCommandNamedArgument.fromProps({name:'desc',description:'Quest description',typeList:[ARGUMENT_TYPE.STRING]}),
                ],
                helpString: 'Manage quests. Example: <code>/rpg-quest title="Find the key" action=add</code>',
            }));

            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'rpg-item',
                callback: (args) => {
                    const name=args.name||'';
                    const act=(args.action||'add').toLowerCase();
                    if(!name) return 'Usage: /rpg-item name="Sword" action=add';
                    const s=getState();
                    const idx=s.inventory.findIndex(i=>i.name.toLowerCase()===name.toLowerCase());
                    if(act==='add'){
                        if(idx===-1) s.inventory.push({name,slot:args.slot||'backpack',type:args.type||'item',desc:args.desc||'',qty:parseInt(args.qty||'1'),equipped:false});
                        else s.inventory[idx].qty=(s.inventory[idx].qty||1)+parseInt(args.qty||'1');
                    } else if(act==='remove'&&idx!==-1){ s.inventory.splice(idx,1); }
                    else if(act==='equip'&&idx!==-1){
                        const sl=args.slot||s.inventory[idx].slot;
                        s.inventory.forEach(i=>{ if(i.equipped&&i.slot===sl)i.equipped=false; });
                        s.inventory[idx].equipped=true; s.inventory[idx].slot=sl;
                    } else return `Item "${name}" not found.`;
                    saveState(); scheduleRender();
                    return `Item "${name}" ${act}ed.`;
                },
                namedArgumentList: [
                    SlashCommandNamedArgument.fromProps({name:'name',description:'Item name',isRequired:true,typeList:[ARGUMENT_TYPE.STRING]}),
                    SlashCommandNamedArgument.fromProps({name:'action',description:'add | remove | equip',typeList:[ARGUMENT_TYPE.STRING]}),
                    SlashCommandNamedArgument.fromProps({name:'slot',description:'Equipment slot',typeList:[ARGUMENT_TYPE.STRING]}),
                    SlashCommandNamedArgument.fromProps({name:'qty',description:'Quantity',typeList:[ARGUMENT_TYPE.NUMBER]}),
                ],
                helpString: 'Manage inventory. Example: <code>/rpg-item name="Iron Sword" action=equip slot=weapon</code>',
            }));

            console.log('[st-rpg-hud] Slash commands registered ✓');
        }
    } catch(e) {
        console.warn('[st-rpg-hud] Slash command registration failed:', e);
    }

    console.log('[st-rpg-hud] v2.0 loaded ✓');
});
