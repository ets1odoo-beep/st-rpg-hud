import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { setGlobalVariable } from "../../../variables.js";

const EXT_NAME = "st-rpg-hud";
const SCHEMA_VERSION = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Empty state skeleton — v2 schema
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_STATE = () => ({
    _version: SCHEMA_VERSION,
    is_initialized: false,

    // Stats
    vitals: {},       // { hp: { name, value, max, color }, ... }
    attributes: {},   // { str: { name, value }, ... }
    resources: {},    // { gold: { name, value }, level: { name, value }, ... }
    statuses: [],     // [{ id, name, desc, turns, type }]
    skills: [],       // [{ id, name, desc, level, type }]

    // Inventory & equipment
    inventory: [],    // [{ name, slot, type, desc, qty, equipped }]

    // Relations
    party: {},        // { "CharName": { affection, trust, desire, lust, fear, respect, rivalry, connection } }
    npcs: [],         // [{ name, role, note, disposition, location }]

    // World
    location: 'Unknown',
    map: {
        currentLocation: 'Unknown',
        region: 'Unknown',
        landmarks: [],    // [{ name, type, discovered, note }]
        travelLog: []     // last 15 visited locations
    },

    // Quests
    quests: [],       // [{ id, title, desc, steps, status, category }]

    // Session
    notes: [],        // [{ text, turn, location, timestamp }]
    combat: { active: false, turn: 0, ap: 0, ap_max: 3, enemy: '' },

    // Legacy compat
    session_log: [],

    // v5 Fields
    vir: {},
    charInner: {},
    charExternal: {},
    charDev: {},
    mindset: {},
    relationships: {},
    secrets: [],
    open_threats: [],
    vad: {},
    topics: {},
    world_flags: {},
    facts: [],
    active_goal: "",
    keyMoments: [],
    personas: {},
    scene_objects: [],
    _contradictions: [],
    _parseMisses: 0
});

// ─────────────────────────────────────────────────────────────────────────────
// Ensure the global settings block exists
// ─────────────────────────────────────────────────────────────────────────────
if (!extension_settings[EXT_NAME]) {
    extension_settings[EXT_NAME] = {
        enabledChatIds: [],
        chatStates: {},
        globalOptions: {
            depth: 4,
            budget: 'standard',  // 'compact' | 'standard' | 'full'
            gmEditMode: false,
            audioSfx: false,
            macros: [
                { name: 'Attack', icon: '⚔️', text: '*Player attacks!*', combatOnly: true },
                { name: 'Defend', icon: '🛡️', text: '*Player defends!*', combatOnly: true },
                { name: 'Flee', icon: '🏃', text: '*Player tries to flee!*', combatOnly: true },
                { name: 'Search', icon: '🔍', text: '*Player searches the area.*', combatOnly: false },
                { name: 'Rest', icon: '🏕️', text: '*Player rests to recover.*', combatOnly: false }
            ]
        }
    };
}

export const Settings = extension_settings[EXT_NAME];

// ─────────────────────────────────────────────────────────────────────────────
// Default schema loaded from file
// ─────────────────────────────────────────────────────────────────────────────
let defaultSchema = null;

// ─────────────────────────────────────────────────────────────────────────────
// State Manager
// ─────────────────────────────────────────────────────────────────────────────
export const StateManager = {
    async init() {
        try {
            const res = await fetch(`/scripts/extensions/third-party/${EXT_NAME}/schema-default.json`);
            if (res.ok) {
                defaultSchema = await res.json();
            }
        } catch (e) {
            console.warn('[st-rpg-hud] Could not load schema-default.json, using bare state', e);
        }
    },

    getCurrentChatId() {
        const context = getContext();
        return context.chatId || 'global';
    },

    getState() {
        const chatId = this.getCurrentChatId();
        if (!Settings.chatStates[chatId]) {
            this.resetState(chatId);
        }
        return this.migrateState(Settings.chatStates[chatId]);
    },

    saveState() {
        this._pruneState();
        saveSettingsDebounced();
    },

    _pruneState() {
        const chatId = this.getCurrentChatId();
        const state = Settings.chatStates[chatId];
        if (!state) return;

        // Cap notes and session log — UI-only data, never sent to AI
        if (state.notes && state.notes.length > 100) {
            state.notes = state.notes.slice(-100);
        }
        if (state.session_log && state.session_log.length > 100) {
            state.session_log = state.session_log.slice(-100);
        }
    },

    resetState(chatId) {
        const id = chatId || this.getCurrentChatId();
        const newState = EMPTY_STATE();

        // Apply default schema if loaded
        if (defaultSchema) {
            newState.vitals = JSON.parse(JSON.stringify(defaultSchema.vitals || {}));
            newState.attributes = JSON.parse(JSON.stringify(defaultSchema.attributes || {}));
            newState.resources = JSON.parse(JSON.stringify(defaultSchema.resources || {}));
        }

        Settings.chatStates[id] = newState;
        this.saveState();
    },

    isHudEnabled() {
        return (Settings.enabledChatIds || []).includes(this.getCurrentChatId());
    },

    toggleHud(enabled) {
        const chatId = this.getCurrentChatId();
        if (!Settings.enabledChatIds) Settings.enabledChatIds = [];
        const currentlyEnabled = this.isHudEnabled();

        if (enabled && !currentlyEnabled) {
            Settings.enabledChatIds.push(chatId);
        } else if (!enabled && currentlyEnabled) {
            Settings.enabledChatIds = Settings.enabledChatIds.filter(id => id !== chatId);
        }
        this.saveState();
    },

    // ── Schema migration ────────────────────────────────────────────────────
    migrateState(state) {
        if (!state) return EMPTY_STATE();
        if (!state._version) state._version = 0;

        // v0 → v1: add missing top-level keys
        if (state._version < 1) {
            state.npcs = state.npcs || state.connections || [];
            state.party = state.party || {};
            state.quests = state.quests || [];
            state.notes = state.notes || [];
            state.statuses = state.statuses || [];
            state.skills = state.skills || [];
            state.inventory = state.inventory || [];
            state.combat = state.combat || { active: false, turn: 0, ap: 0, ap_max: 3 };
            state._version = 1;
        }

        // v1 → v2: restructure map, add travelLog, landmarks
        if (state._version < 2) {
            const oldMap = state.map || {};
            state.map = {
                currentLocation: state.location || oldMap.location || 'Unknown',
                region: oldMap.region || 'Unknown',
                landmarks: (() => {
                    // Convert old coordinate-based landmarks to new format
                    const old = oldMap.landmarks || [];
                    return old.map(l => ({
                        name: l.name || '?',
                        type: l.type || 'landmark',
                        discovered: true,
                        note: l.note || ''
                    }));
                })(),
                travelLog: []
            };
            state.location = state.map.currentLocation;

            // Fix party: convert old array-style to object-style if needed
            if (Array.isArray(state.party)) {
                const partyObj = {};
                for (const member of state.party) {
                    if (member.name) {
                        partyObj[member.name] = member.relationship || {
                            affection: 0, trust: 0, desire: 0, lust: 0,
                            fear: 0, respect: 0, rivalry: 0, connection: 0
                        };
                    }
                }
                state.party = partyObj;
            }

            // Normalize statuses
            state.statuses = (state.statuses || []).map(s => ({
                id: s.id || s.name || '?',
                name: s.name || s.id || '?',
                desc: s.desc || '',
                turns: s.turns,
                type: s.type || 'debuff'
            }));

            // Normalize skills
            state.skills = (state.skills || []).map(s => ({
                id: s.id || s.name || '?',
                name: s.name || s.id || '?',
                desc: s.desc || '',
                level: s.level || s.rank || '1',
                type: s.type || 'active'
            }));

            // Normalize inventory
            state.inventory = (state.inventory || []).map(i => ({
                name: i.name || '?',
                slot: i.slot || 'backpack',
                type: i.type || 'item',
                desc: i.desc || '',
                qty: i.qty || 1,
                equipped: i.equipped || false
            }));

            // Normalize quests
            state.quests = (state.quests || []).map(q => ({
                id: q.id || q.name || q.title || '?',
                title: q.title || q.name || q.id || '?',
                desc: q.desc || '',
                steps: q.steps || [],
                status: q.status || 'active',
                category: q.category || 'main'
            }));

            state._version = 2;
            this.saveState();
            console.log('[st-rpg-hud] Migrated state to v2');
        }

        return state;
    },

    // ── State export / import ───────────────────────────────────────────────
    exportState() {
        const state = this.getState();
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rpg-hud-state-${this.getCurrentChatId()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    importState(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);
            const chatId = this.getCurrentChatId();
            Settings.chatStates[chatId] = parsed;
            this.migrateState(Settings.chatStates[chatId]);
            this.saveState();
            return true;
        } catch (e) {
            console.error('[st-rpg-hud] Import failed', e);
            return false;
        }
    },

    // ── ST-Outfits cross-extension bridge ──────────────────────────────────
    updateOutfitGlobalVar(slot, itemName) {
        if (typeof setGlobalVariable !== 'function') return;
        const context = getContext();
        let scopeName = 'User';
        if (context.characterId !== undefined && context.characters?.[context.characterId]) {
            scopeName = context.characters[context.characterId].name;
        }
        const varName = `${scopeName}_${slot}`;
        try {
            setGlobalVariable(varName, itemName);
        } catch (e) {
            // setGlobalVariable is optional — silently ignore if unavailable
        }
    }
};
