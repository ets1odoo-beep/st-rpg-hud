import { StateManager } from './state.js';

// ─────────────────────────────────────────────────────────────────────────────
// Attribute extractor — pulls key="value" pairs from a tag attribute string
// ─────────────────────────────────────────────────────────────────────────────
function extractAttrs(attrString) {
    const attrs = {};
    // Match key="value" or key='value'
    const re = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(attrString)) !== null) {
        attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    }
    return attrs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe numeric helpers
// ─────────────────────────────────────────────────────────────────────────────
function safeFloat(val, fallback = NaN) {
    if (val === undefined || val === null || val === '') return fallback;
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
}

/** Clamp delta magnitude so AI hallucinations can't spike values wildly */
function clampDelta(delta, max = 9999) {
    return Math.max(-max, Math.min(max, delta));
}

/** Apply delta to current value with optional min/max bounds */
function applyBounded(current, delta, min = 0, max = undefined) {
    let next = current + delta;
    next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core tag scanner — finds all self-closing or paired tags of a given name
// Returns array of { attrs, innerText } objects
// ─────────────────────────────────────────────────────────────────────────────
function scanTags(tagName, xmlText) {
    const results = [];
    const tag = tagName.toUpperCase();

    // Self-closing: <TAG attr="x" />  OR  <TAG attr="x">
    const selfRe = new RegExp(`<${tag}([^>]*?)(?:\\/>|>(?!\\s*<\\/${tag}>))`, 'gi');
    let m;
    while ((m = selfRe.exec(xmlText)) !== null) {
        // Disambiguate: if followed by </TAG> it's a pair, handle via pairRe
        const afterTag = xmlText.slice(m.index + m[0].length, m.index + m[0].length + 50);
        const isPaired = afterTag.trimStart().startsWith(`</${tag}`) || afterTag.trimStart().toUpperCase().startsWith(`</${tag}`);
        if (!isPaired) {
            results.push({ attrs: extractAttrs(m[1] || ''), innerText: '' });
        }
    }

    // Paired: <TAG attr="x">inner</TAG>
    const pairRe = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    while ((m = pairRe.exec(xmlText)) !== null) {
        results.push({ attrs: extractAttrs(m[1] || ''), innerText: (m[2] || '').trim() });
    }

    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract the <RPG-HUD>...</RPG-HUD> block from a full message
// Scans tail for performance (bounded), handles truncated blocks
// ─────────────────────────────────────────────────────────────────────────────
function extractHudBlock(text) {
    // Only scan the tail — avoids expensive regex on very long messages
    const TAIL_CHARS = 2000;
    const searchText = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;

    // Find opening tag
    const openIdx = searchText.search(/<RPG-HUD\s*>/i);
    if (openIdx === -1) return null;

    // Find closing tag
    const closeMatch = searchText.slice(openIdx).match(/<\/RPG-HUD>/i);
    if (closeMatch) {
        // Complete block — return inner content
        const inner = searchText.slice(
            openIdx + searchText.slice(openIdx).match(/<RPG-HUD\s*>/i)[0].length,
            openIdx + closeMatch.index
        );
        return inner;
    }

    // Truncated (streaming cutoff) — return everything after open tag
    // The parser will still extract any complete child tags
    const inner = searchText.slice(openIdx + searchText.slice(openIdx).match(/<RPG-HUD\s*>/i)[0].length);
    return inner || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strip RPG-HUD block + any raw text remnants from visible message
// ─────────────────────────────────────────────────────────────────────────────
function stripHudBlock(text) {
    // Remove complete blocks
    let stripped = text.replace(/<RPG-HUD\s*>[\s\S]*?<\/RPG-HUD>/gi, '');
    // Remove any orphaned opening tags (streaming truncation)
    stripped = stripped.replace(/<RPG-HUD\s*>[\s\S]*/gi, '');
    return stripped.trimEnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// State processors — one per tag type
// ─────────────────────────────────────────────────────────────────────────────

function processStats(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        const id = (attrs.id || '').toLowerCase().trim();
        if (!id) continue;

        // Find or auto-create the stat entry in vitals → attributes → resources
        let targetObj = state.vitals[id] ?? state.attributes[id] ?? state.resources[id];

        // ✅ FIXED BUG: Auto-create missing stat so AI can initialize the HUD
        if (!targetObj) {
            // Determine best bucket based on id hints
            const vitalIds = ['hp', 'mp', 'ap', 'xp', 'stamina', 'sta', 'energy', 'health', 'mana'];
            const attrIds = ['str', 'dex', 'con', 'int', 'wis', 'cha', 'spd', 'lck', 'per', 'end'];
            const name = attrs.name || id.toUpperCase();
            const color = attrs.color || '#888888';

            if (vitalIds.includes(id)) {
                state.vitals[id] = { name, value: 0, max: undefined, color };
                targetObj = state.vitals[id];
            } else if (attrIds.includes(id)) {
                state.attributes[id] = { name, value: 0 };
                targetObj = state.attributes[id];
            } else {
                // Default to resources
                state.resources[id] = { name, value: 0 };
                targetObj = state.resources[id];
            }
            // Update display name if provided
            if (attrs.name) targetObj.name = attrs.name;
            if (attrs.color) targetObj.color = attrs.color;
        }

        // Update max
        const maxStr = attrs.max;
        if (maxStr !== undefined) {
            const parsedMax = safeFloat(maxStr);
            if (!isNaN(parsedMax)) {
                targetObj.max = parsedMax;
                changed = true;
            }
        }

        // Absolute set takes priority over delta
        const valueStr = attrs.value ?? attrs.set ?? attrs.abs;
        const deltaStr = attrs.delta;

        if (valueStr !== undefined) {
            const parsed = safeFloat(valueStr);
            if (!isNaN(parsed)) {
                targetObj.value = parsed;
                if (targetObj.max !== undefined) targetObj.value = Math.min(targetObj.max, targetObj.value);
                targetObj.value = Math.max(0, targetObj.value);
                changed = true;
            }
        } else if (deltaStr !== undefined) {
            const delta = clampDelta(safeFloat(deltaStr, 0));
            targetObj.value = applyBounded(targetObj.value, delta, 0, targetObj.max);
            changed = true;
        }
    }
    return changed;
}

function processSkills(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        const id = (attrs.id || attrs.name || '').trim();
        const action = (attrs.action || 'add').toLowerCase();
        if (!id) continue;

        const existingIdx = state.skills.findIndex(s => s.id === id || s.name === id);

        if (action === 'add' && existingIdx === -1) {
            state.skills.push({
                id,
                name: attrs.name || id,
                desc: attrs.desc || attrs.description || '',
                level: attrs.level || attrs.rank || '1',
                type: attrs.type || 'active'
            });
            changed = true;
        } else if ((action === 'level' || action === 'upgrade') && existingIdx !== -1) {
            state.skills[existingIdx].level = attrs.value || attrs.level || attrs.rank || state.skills[existingIdx].level;
            if (attrs.desc) state.skills[existingIdx].desc = attrs.desc;
            changed = true;
        } else if (action === 'remove' && existingIdx !== -1) {
            state.skills.splice(existingIdx, 1);
            changed = true;
        }
    }
    return changed;
}

function processStatuses(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        const id = (attrs.id || attrs.name || '').trim();
        const action = (attrs.action || 'add').toLowerCase();
        if (!id) continue;

        const existingIdx = state.statuses.findIndex(s => s.id === id || s.name === id);

        if (action === 'add' && existingIdx === -1) {
            state.statuses.push({
                id,
                name: attrs.name || id,
                desc: attrs.desc || attrs.description || '',
                turns: attrs.turns ? parseInt(attrs.turns) : undefined,
                type: attrs.type || 'debuff'
            });
            changed = true;
        } else if (action === 'remove' && existingIdx !== -1) {
            state.statuses.splice(existingIdx, 1);
            changed = true;
        } else if (action === 'update' && existingIdx !== -1) {
            if (attrs.turns) state.statuses[existingIdx].turns = parseInt(attrs.turns);
            if (attrs.desc) state.statuses[existingIdx].desc = attrs.desc;
            changed = true;
        }
    }
    return changed;
}

function processItems(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        const name = (attrs.name || '').trim();
        const action = (attrs.action || 'add').toLowerCase();
        if (!name) continue;

        const existingIdx = state.inventory.findIndex(i => i.name.toLowerCase() === name.toLowerCase());

        if (action === 'add' && existingIdx === -1) {
            state.inventory.push({
                name,
                slot: attrs.slot || 'backpack',
                type: attrs.type || 'item',
                desc: attrs.desc || '',
                qty: parseInt(attrs.qty || attrs.quantity || '1') || 1,
                equipped: false
            });
            changed = true;
        } else if ((action === 'remove' || action === 'burn' || action === 'use' || action === 'consume') && existingIdx !== -1) {
            const item = state.inventory[existingIdx];
            if (item.equipped && item.slot) {
                StateManager.updateOutfitGlobalVar(item.slot, 'None');
            }
            // Decrement qty or remove entirely
            if (item.qty > 1 && (action === 'use' || action === 'consume')) {
                state.inventory[existingIdx].qty -= 1;
            } else {
                state.inventory.splice(existingIdx, 1);
            }
            changed = true;
        } else if (action === 'equip') {
            if (existingIdx !== -1) {
                const slot = attrs.slot || state.inventory[existingIdx].slot;
                // Unequip anything already in that slot
                state.inventory.forEach(i => {
                    if (i.equipped && i.slot === slot && i.name !== name) {
                        i.equipped = false;
                        StateManager.updateOutfitGlobalVar(slot, 'None');
                    }
                });
                state.inventory[existingIdx].equipped = true;
                state.inventory[existingIdx].slot = slot;
                StateManager.updateOutfitGlobalVar(slot, name);
                changed = true;
            }
        } else if (action === 'unequip' && existingIdx !== -1) {
            const slot = state.inventory[existingIdx].slot;
            state.inventory[existingIdx].equipped = false;
            if (slot) StateManager.updateOutfitGlobalVar(slot, 'None');
            changed = true;
        } else if (action === 'add' && existingIdx !== -1) {
            // Stack quantity
            state.inventory[existingIdx].qty = (state.inventory[existingIdx].qty || 1) + (parseInt(attrs.qty || '1') || 1);
            changed = true;
        }
    }
    return changed;
}

function processParty(tags, state) {
    let changed = false;
    for (const { attrs, innerText } of tags) {
        const charName = (attrs.char || attrs.name || '').trim();
        const action = (attrs.action || 'add').toLowerCase();
        if (!charName) continue;

        if (action === 'add' || action === 'update') {
            if (!state.party[charName]) {
                state.party[charName] = {
                    affection: 0, trust: 0, desire: 0, lust: 0,
                    fear: 0, respect: 0, rivalry: 0, connection: 0
                };
            }

            // Update relationship fields from tag attributes (absolute set)
            const relFields = ['affection', 'trust', 'desire', 'lust', 'fear', 'respect', 'rivalry', 'connection'];
            for (const field of relFields) {
                if (attrs[field] !== undefined) {
                    const val = safeFloat(attrs[field]);
                    if (!isNaN(val)) {
                        state.party[charName][field] = Math.max(-100, Math.min(100, val));
                        changed = true;
                    }
                }
            }
        } else if (action === 'relation' || action === 'delta') {
            // Delta-style: <PARTY char="Elf" relation="trust" delta="+5" />
            const relation = attrs.relation;
            const deltaStr = attrs.delta;
            if (relation && deltaStr) {
                if (!state.party[charName]) {
                    state.party[charName] = { affection: 0, trust: 0, desire: 0, lust: 0, fear: 0, respect: 0, rivalry: 0, connection: 0 };
                }
                if (state.party[charName][relation] !== undefined) {
                    const delta = clampDelta(safeFloat(deltaStr, 0), 30);
                    state.party[charName][relation] = Math.max(-100, Math.min(100, state.party[charName][relation] + delta));
                    changed = true;
                }
            }
        } else if (action === 'remove') {
            if (state.party[charName]) {
                delete state.party[charName];
                changed = true;
            }
        }
    }

    // Legacy: also handle <PARTY char="X" relation="Y" delta="Z" /> format (no action attr)
    for (const { attrs } of tags) {
        if (attrs.relation && attrs.delta && !attrs.action) {
            const charName = (attrs.char || attrs.name || '').trim();
            if (!charName) continue;
            if (!state.party[charName]) {
                state.party[charName] = { affection: 0, trust: 0, desire: 0, lust: 0, fear: 0, respect: 0, rivalry: 0, connection: 0 };
            }
            const relation = attrs.relation;
            if (state.party[charName][relation] !== undefined) {
                const delta = clampDelta(safeFloat(attrs.delta, 0), 30);
                state.party[charName][relation] = Math.max(-100, Math.min(100, state.party[charName][relation] + delta));
                changed = true;
            }
        }
    }

    return changed;
}

function processQuests(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        const id = (attrs.id || attrs.name || '').trim();
        const action = (attrs.action || 'add').toLowerCase();
        if (!id) continue;

        const existingIdx = state.quests.findIndex(q => q.id === id || q.title === id);

        if (action === 'add' && existingIdx === -1) {
            state.quests.push({
                id,
                title: attrs.title || attrs.name || id,
                desc: attrs.desc || attrs.description || '',
                steps: [],
                status: 'active',
                category: attrs.category || 'main'
            });
            changed = true;
        } else if (action === 'step' && existingIdx !== -1) {
            const stepDesc = attrs.desc || attrs.step || attrs.text;
            if (stepDesc) {
                state.quests[existingIdx].steps.push(stepDesc);
                changed = true;
            }
        } else if ((action === 'complete' || action === 'finish') && existingIdx !== -1) {
            state.quests[existingIdx].status = 'completed';
            changed = true;
        } else if (action === 'fail' && existingIdx !== -1) {
            state.quests[existingIdx].status = 'failed';
            changed = true;
        } else if (action === 'update' && existingIdx !== -1) {
            if (attrs.desc) state.quests[existingIdx].desc = attrs.desc;
            if (attrs.title) state.quests[existingIdx].title = attrs.title;
            changed = true;
        }
    }
    return changed;
}

function processLocations(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        let action = (attrs.action || '').toLowerCase();
        const name = (attrs.name || '').trim();

        // If no action but name present → treat as 'set'
        if (!action && name) action = 'set';

        if (action === 'set' && name) {
            // Add to travel log before changing
            if (state.location && state.location !== name && state.location !== 'Unknown') {
                state.map.travelLog = state.map.travelLog || [];
                state.map.travelLog.unshift(state.location);
                if (state.map.travelLog.length > 15) state.map.travelLog.pop();
            }
            state.location = name;
            state.map.currentLocation = name;
            if (attrs.region) state.map.region = attrs.region;
            changed = true;
        } else if (action === 'add' && name) {
            // Add a landmark
            state.map.landmarks = state.map.landmarks || [];
            if (!state.map.landmarks.some(l => l.name === name)) {
                state.map.landmarks.push({
                    name,
                    type: attrs.type || 'landmark',
                    discovered: true,
                    note: attrs.note || attrs.desc || ''
                });
                changed = true;
            }
        } else if (action === 'region' && name) {
            state.map.region = name;
            changed = true;
        }
    }
    return changed;
}

function processNpcs(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        const name = (attrs.name || '').trim();
        const action = (attrs.action || 'add').toLowerCase();
        if (!name) continue;

        const existingIdx = state.npcs.findIndex(n => n.name.toLowerCase() === name.toLowerCase());

        if (action === 'add' && existingIdx === -1) {
            state.npcs.push({
                name,
                role: attrs.role || 'unknown',
                note: attrs.note || attrs.desc || '',
                disposition: attrs.disposition || 'neutral',
                location: attrs.location || state.location || 'Unknown'
            });
            changed = true;
        } else if (action === 'update' && existingIdx !== -1) {
            if (attrs.role) state.npcs[existingIdx].role = attrs.role;
            if (attrs.note || attrs.desc) state.npcs[existingIdx].note = attrs.note || attrs.desc;
            if (attrs.disposition) state.npcs[existingIdx].disposition = attrs.disposition;
            if (attrs.location) state.npcs[existingIdx].location = attrs.location;
            changed = true;
        } else if (action === 'remove' && existingIdx !== -1) {
            state.npcs.splice(existingIdx, 1);
            changed = true;
        }
    }
    return changed;
}

function processCombat(tags, state) {
    let changed = false;
    for (const { attrs } of tags) {
        const mode = (attrs.mode || '').toLowerCase();
        if (mode === 'active') {
            state.combat.active = true;
            if (attrs.turn !== undefined) state.combat.turn = parseInt(attrs.turn) || 0;
            if (attrs.ap !== undefined) state.combat.ap = parseInt(attrs.ap) || 0;
            if (attrs.ap_max !== undefined) state.combat.ap_max = parseInt(attrs.ap_max) || 3;
            if (attrs.enemy || attrs.enemies) state.combat.enemy = attrs.enemy || attrs.enemies;
            changed = true;
        } else if (mode === 'idle' || mode === 'end' || mode === 'off') {
            state.combat.active = false;
            state.combat.turn = 0;
            changed = true;
        }
    }
    return changed;
}

function processChecks(tags) {
    for (const { attrs } of tags) {
        const stat = attrs.stat || attrs.skill || '';
        const dc = attrs.dc || attrs.difficulty || '10';
        if (stat) {
            document.dispatchEvent(new CustomEvent('rpg-hud-dice-check', {
                detail: { stat, dc, modifier: attrs.modifier || '0', type: attrs.type || 'check' }
            }));
        }
    }
}

function processNotes(tags, state) {
    let changed = false;
    for (const { attrs, innerText } of tags) {
        const text = attrs.text || attrs.content || innerText || '';
        if (text.trim()) {
            state.notes.push({
                text: text.trim(),
                turn: state.combat?.turn || 0,
                location: state.location || 'Unknown',
                timestamp: Date.now()
            });
            changed = true;
        }
    }
    return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export const Parser = {
    stripTags(text) {
        return stripHudBlock(text);
    },

    hasHudBlock(text) {
        return /<RPG-HUD\s*>/i.test(text);
    },

    processMessage(text) {
        const hudContent = extractHudBlock(text);
        if (!hudContent) return false;

        const state = StateManager.getState();
        let changed = false;

        try {
            // Process each tag type in dependency order
            changed |= processStats(scanTags('STAT', hudContent), state);
            changed |= processSkills(scanTags('SKILL', hudContent), state);
            changed |= processStatuses(scanTags('STATUS', hudContent), state);
            changed |= processItems(scanTags('ITEM', hudContent), state);
            changed |= processParty(scanTags('PARTY', hudContent), state);
            changed |= processQuests(scanTags('QUEST', hudContent), state);
            changed |= processLocations(scanTags('LOC', hudContent), state);
            changed |= processNpcs(scanTags('NPC', hudContent), state);
            changed |= processCombat(scanTags('COMBAT', hudContent), state);
            changed |= processNotes(scanTags('NOTE', hudContent), state);
            processChecks(scanTags('CHECK', hudContent));

        } catch (e) {
            console.error('[st-rpg-hud] Parser error:', e);
            state.notes.push({
                text: `[Parse Error: ${e.message}]`,
                turn: state.combat?.turn || 0,
                location: state.location || '?',
                timestamp: Date.now()
            });
        }

        if (changed) {
            state.is_initialized = true;
            StateManager.saveState();
        }

        return !!changed;
    }
};
