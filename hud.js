import { StateManager, Settings } from './state.js';
import { MacroManager } from './macros.js';

const EXT_NAME = 'st-rpg-hud';
let htmlTemplate = '';

// Relation color map — same hue logic as BetterSimTracker
const RELATION_COLORS = {
    affection:  '#e87070',
    trust:      '#70b0e8',
    desire:     '#e870b8',
    lust:       '#e8a870',
    fear:       '#888',
    respect:    '#70e8a8',
    rivalry:    '#e8d070',
    connection: '#a870e8'
};

// ─────────────────────────────────────────────────────────────────────────────
// Track previous vital values for delta indicators
// ─────────────────────────────────────────────────────────────────────────────
const _prevVitals = {};

// ─────────────────────────────────────────────────────────────────────────────
// Render queue — single requestAnimationFrame debounce to prevent thrash
// ─────────────────────────────────────────────────────────────────────────────
let _renderPending = false;
function scheduleRender() {
    if (!_renderPending) {
        _renderPending = true;
        requestAnimationFrame(() => {
            _doRender();
            _renderPending = false;
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
function el(tag, cls, attrs = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else e.setAttribute(k, v);
    }
    return e;
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[m]));
}

// ─────────────────────────────────────────────────────────────────────────────
// D&D-style attribute modifier
// ─────────────────────────────────────────────────────────────────────────────
function attrMod(val) {
    const mod = Math.floor((val - 10) / 2);
    return mod >= 0 ? `+${mod}` : String(mod);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vital bar — uses CSS scaleX transform (GPU-composited)
// ─────────────────────────────────────────────────────────────────────────────
function buildVitalBar(id, vital, prevVitals, gmEdit) {
    const ratio = vital.max != null ? Math.max(0, Math.min(1, vital.value / vital.max)) : 1;
    const pct = `${Math.round(ratio * 100)}%`;
    const valText = vital.max != null ? `${vital.value} / ${vital.max}` : String(vital.value);
    const color = vital.color || 'var(--hud-primary)';

    const wrapper = el('div', 'rpg-vital');

    const header = el('div', 'rpg-vital-header');
    const labelEl = el('span', 'rpg-vital-label', { text: vital.name || id });
    header.appendChild(labelEl);

    // GM edit inputs
    if (gmEdit) {
        const valInp = el('input', 'rpg-inline-input');
        valInp.type = 'number';
        valInp.value = String(vital.value);
        valInp.setAttribute('data-path', `vitals.${id}.value`);
        header.appendChild(valInp);
        if (vital.max != null) {
            header.appendChild(document.createTextNode(' / '));
            const maxInp = el('input', 'rpg-inline-input');
            maxInp.type = 'number';
            maxInp.value = String(vital.max);
            maxInp.setAttribute('data-path', `vitals.${id}.max`);
            header.appendChild(maxInp);
        }
    } else {
        header.appendChild(el('span', 'rpg-vital-value', { text: valText }));
    }

    wrapper.appendChild(header);

    const track = el('div', 'rpg-bar-track');
    const fill = el('div', 'rpg-bar-fill');
    fill.style.background = color;
    fill.style.transform = `scaleX(${ratio})`;
    track.appendChild(fill);
    wrapper.appendChild(track);

    // Delta indicator
    if (prevVitals) {
        const prev = prevVitals[id];
        if (prev !== undefined && prev !== vital.value) {
            const delta = vital.value - prev;
            const sign = delta > 0 ? '+' : '';
            const deltaEl = el('span', `rpg-delta ${delta > 0 ? 'pos' : 'neg'}`, { text: `${sign}${delta}` });
            wrapper.style.position = 'relative';
            wrapper.appendChild(deltaEl);
            // Remove after animation
            deltaEl.addEventListener('animationend', () => deltaEl.remove());
        }
    }

    return wrapper;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render — updates DOM in-place, no full innerHTML swap
// ─────────────────────────────────────────────────────────────────────────────
function _doRender() {
    const wrapper = document.querySelector('.rpg-hud-wrapper');
    if (!wrapper) return;

    const state = StateManager.getState();
    const gmEdit = Settings.globalOptions?.gmEditMode ?? false;

    // ── Combat banner ──────────────────────────────────────────────────────
    const combatBanner = wrapper.querySelector('#rpg-combat-banner');
    if (combatBanner) {
        combatBanner.classList.toggle('active', !!state.combat?.active);
        if (state.combat?.active) {
            const lbl = wrapper.querySelector('#rpg-combat-label');
            if (lbl) lbl.textContent = `⚔ Combat — Turn ${state.combat.turn || 1}${state.combat.enemy ? ` vs ${state.combat.enemy}` : ''}`;
            const apEl = wrapper.querySelector('#rpg-ap-display');
            if (apEl) apEl.textContent = `AP: ${state.combat.ap}/${state.combat.ap_max}`;
        }
    }

    // ── Location ───────────────────────────────────────────────────────────
    const locEl = wrapper.querySelector('#rpg-location-val');
    if (locEl) locEl.textContent = state.map?.currentLocation || state.location || 'Unknown';
    const regEl = wrapper.querySelector('#rpg-region-val');
    if (regEl) regEl.textContent = state.map?.region && state.map.region !== 'Unknown' ? state.map.region : '';

    // ── Vitals ─────────────────────────────────────────────────────────────
    const vitalsContainer = wrapper.querySelector('#rpg-vitals-container');
    if (vitalsContainer) {
        vitalsContainer.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const [id, vital] of Object.entries(state.vitals || {})) {
            frag.appendChild(buildVitalBar(id, vital, _prevVitals, gmEdit));
        }
        vitalsContainer.appendChild(frag);
        // Snapshot for next delta calc
        for (const [id, v] of Object.entries(state.vitals || {})) _prevVitals[id] = v.value;
    }

    // ── Attributes ─────────────────────────────────────────────────────────
    const attrGrid = wrapper.querySelector('#rpg-attributes-grid');
    if (attrGrid) {
        attrGrid.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const [id, attr] of Object.entries(state.attributes || {})) {
            const cell = el('div', 'rpg-attr-cell');
            cell.appendChild(el('span', 'rpg-attr-label', { text: attr.name || id }));
            if (gmEdit) {
                const inp = el('input', 'rpg-attr-val rpg-inline-input');
                inp.type = 'number';
                inp.value = String(attr.value);
                inp.style.width = '48px';
                inp.setAttribute('data-path', `attributes.${id}.value`);
                cell.appendChild(inp);
            } else {
                cell.appendChild(el('div', 'rpg-attr-val', { text: String(attr.value) }));
                // Show D&D modifier for stats 1-30 range
                if (attr.value >= 1 && attr.value <= 30) {
                    cell.appendChild(el('div', 'rpg-attr-mod', { text: attrMod(attr.value) }));
                }
            }
            frag.appendChild(cell);
        }
        attrGrid.appendChild(frag);
    }

    // ── Resources ──────────────────────────────────────────────────────────
    const resRow = wrapper.querySelector('#rpg-resources-row');
    if (resRow) {
        resRow.innerHTML = '';
        const RESOURCE_ICONS = { gold: 'fa-coins', lvl: 'fa-star', level: 'fa-star', xp: 'fa-circle-dot' };
        for (const [id, res] of Object.entries(state.resources || {})) {
            const icon = RESOURCE_ICONS[id] || 'fa-gem';
            const chip = el('div', 'rpg-resource-chip');
            chip.innerHTML = `<i class="fa-solid ${icon}"></i> <strong>${esc(res.name || id)}</strong>: ${esc(String(res.value))}`;
            resRow.appendChild(chip);
        }
        if (!Object.keys(state.resources || {}).length) {
            resRow.appendChild(el('span', 'rpg-empty', { text: 'No resources.' }));
        }
    }

    // ── Status Effects ─────────────────────────────────────────────────────
    const statusesRow = wrapper.querySelector('#rpg-statuses-row');
    if (statusesRow) {
        statusesRow.innerHTML = '';
        if (!state.statuses?.length) {
            statusesRow.appendChild(el('span', 'rpg-empty', { text: 'No active effects.' }));
        } else {
            for (const s of state.statuses) {
                const type = (s.type || 'debuff').toLowerCase();
                const pill = el('span', `rpg-pill status-${type.includes('buff') ? 'buff' : 'debuff'}`);
                pill.textContent = s.name || s.id;
                const desc = [s.desc, s.turns != null ? `${s.turns}t` : ''].filter(Boolean).join(' · ');
                if (desc) pill.setAttribute('data-desc', desc);
                statusesRow.appendChild(pill);
            }
        }
    }

    // ── Skills ─────────────────────────────────────────────────────────────
    const skillsList = wrapper.querySelector('#rpg-skills-list');
    if (skillsList) {
        skillsList.innerHTML = '';
        if (!state.skills?.length) {
            skillsList.appendChild(el('span', 'rpg-empty', { text: 'No skills learned yet.' }));
        } else {
            for (const skill of state.skills) {
                const pill = el('span', 'rpg-pill skill-pill');
                pill.setAttribute('data-id', skill.id || skill.name);
                if (skill.desc) pill.setAttribute('data-desc', skill.desc);
                pill.innerHTML = `${esc(skill.name || skill.id)} <span class="level-badge">Lv${esc(String(skill.level || 1))}</span>`;
                skillsList.appendChild(pill);
            }
        }
    }

    // ── Inventory ──────────────────────────────────────────────────────────
    const SLOT_LABELS = {
        weapon: '⚔ Weapon', offhand: '🛡 Off-hand', head: '⛑ Head', headwear: '⛑ Head',
        topwear: '👕 Body', body: '👕 Body', bottomwear: '👖 Legs', footwear: '👟 Feet',
        accessory: '💍 Acc.', ring: '💍 Ring', amulet: '📿 Amulet', backpack: '🎒 Pack'
    };
    const SLOT_ORDER = ['weapon', 'offhand', 'head', 'headwear', 'body', 'topwear', 'bottomwear', 'footwear', 'accessory', 'ring', 'amulet'];

    const equipGrid = wrapper.querySelector('#rpg-equip-grid');
    if (equipGrid) {
        equipGrid.innerHTML = '';
        const showSlots = SLOT_ORDER.filter(s =>
            state.inventory?.some(i => i.slot === s)
        );
        if (!showSlots.length && !state.inventory?.some(i => i.equipped)) {
            equipGrid.innerHTML = '<span class="rpg-empty">Nothing equipped.</span>';
        } else {
            for (const slot of showSlots) {
                const item = state.inventory?.find(i => i.slot === slot && i.equipped);
                const cell = el('div', `rpg-equip-slot${item ? ' filled' : ''}`);
                cell.innerHTML = `
                    <div class="rpg-equip-slot-label">${esc(SLOT_LABELS[slot] || slot)}</div>
                    ${item
                        ? `<div class="rpg-equip-slot-item">${esc(item.name)}</div>`
                        : `<div class="rpg-equip-slot-empty">—</div>`}`;
                equipGrid.appendChild(cell);
            }
        }
    }

    const backpackGrid = wrapper.querySelector('#rpg-backpack-grid');
    if (backpackGrid) {
        backpackGrid.innerHTML = '';
        const unequipped = (state.inventory || []).filter(i => !i.equipped);
        if (!unequipped.length) {
            backpackGrid.appendChild(el('span', 'rpg-empty', { text: 'Backpack is empty.' }));
        } else {
            for (const item of unequipped) {
                const card = el('div', 'rpg-item-card');
                card.setAttribute('data-name', item.name);
                if (item.desc) card.title = item.desc;
                card.innerHTML = esc(item.name);
                if ((item.qty || 1) > 1) {
                    card.innerHTML += ` <span class="rpg-item-qty">×${item.qty}</span>`;
                }
                backpackGrid.appendChild(card);
            }
        }
    }

    // ── Party ──────────────────────────────────────────────────────────────
    const partyList = wrapper.querySelector('#rpg-party-list');
    if (partyList) {
        partyList.innerHTML = '';
        const chars = Object.entries(state.party || {});
        // Fallback to relationships from NPCs if party is empty
        if (!chars.length && state.npcs) {
            state.npcs.forEach(n => {
                if (n.trust || n.affection || n.fear) {
                    chars.push([n.name, { trust: n.trust, affection: n.affection, fear: n.fear }]);
                }
            });
        }
        if (!chars.length) {
            partyList.appendChild(el('span', 'rpg-empty', { text: 'No party members.' }));
        } else {
            for (const [name, rels] of chars) {
                const card = el('div', 'rpg-party-card');
                card.innerHTML = `<div class="rpg-party-name"><i class="fa-solid fa-user"></i> ${esc(name)}</div>`;
                const grid = el('div', 'rpg-relation-grid');
                for (const [rel, val] of Object.entries(rels)) {
                    if (typeof val !== 'number') continue;
                    const clr = RELATION_COLORS[rel] || '#aaa';
                    const pct = Math.max(0, Math.min(100, val + 100)) / 200; // -100..100 → 0..1
                    const cell = el('div', 'rpg-relation-cell');
                    cell.innerHTML = `
                        <div class="rpg-relation-label">${esc(rel)}</div>
                        <div class="rpg-relation-bar-track">
                            <div class="rpg-relation-bar-fill" style="background:${clr}; transform:scaleX(${pct})"></div>
                        </div>
                        <div class="rpg-relation-val" style="color:${clr}">${val > 0 ? '+' : ''}${val}</div>`;
                    grid.appendChild(cell);
                }
                card.appendChild(grid);
                partyList.appendChild(card);
            }
        }
    }

    // ── Quests ─────────────────────────────────────────────────────────────
    function renderQuests(container, quests) {
        if (!container) return;
        container.innerHTML = '';
        if (!quests.length) {
            container.appendChild(el('span', 'rpg-empty', { text: 'None.' }));
            return;
        }
        for (const quest of quests) {
            const card = el('div', `rpg-quest-card ${quest.status === 'completed' ? 'completed' : quest.status === 'failed' ? 'failed' : ''}`);
            const status_icon = quest.status === 'completed' ? '✓ ' : quest.status === 'failed' ? '✗ ' : '';
            card.innerHTML = `
                <div class="rpg-quest-title">${status_icon}${esc(quest.title || quest.id)}</div>
                ${quest.desc ? `<div class="rpg-quest-desc">${esc(quest.desc)}</div>` : ''}
                ${quest.steps?.length ? `<ul class="rpg-quest-steps">${quest.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
            `;
            container.appendChild(card);
        }
    }
    renderQuests(wrapper.querySelector('#rpg-active-quests'), (state.quests || []).filter(q => q.status === 'active'));
    renderQuests(wrapper.querySelector('#rpg-done-quests'), (state.quests || []).filter(q => q.status !== 'active'));

    // ── NPCs ───────────────────────────────────────────────────────────────
    const npcList = wrapper.querySelector('#rpg-npc-list');
    if (npcList) {
        npcList.innerHTML = '';
        if (!state.npcs?.length) {
            npcList.appendChild(el('span', 'rpg-empty', { text: 'No known characters.' }));
        } else {
            for (const npc of state.npcs) {
                const row = el('div', 'rpg-npc-row');
                const disp = (npc.disposition || npc.role || 'unknown').toLowerCase();
                row.innerHTML = `
                    <div>
                        <div class="rpg-npc-name">${esc(npc.name)}</div>
                        ${npc.note ? `<div class="rpg-npc-note">${esc(npc.note)}</div>` : ''}
                        ${npc.location && npc.location !== 'Unknown' ? `<div class="rpg-npc-note"><i class="fa-solid fa-location-dot" style="font-size:10px;"></i> ${esc(npc.location)}</div>` : ''}
                    </div>
                    <span class="rpg-npc-role ${disp}">${esc(npc.role || 'unknown')}</span>`;
                npcList.appendChild(row);
            }
        }
    }

    // ── Locations / World ──────────────────────────────────────────────────
    const worldLoc = wrapper.querySelector('#rpg-world-location');
    if (worldLoc) worldLoc.textContent = state.map?.currentLocation || state.location || 'Unknown';
    const worldReg = wrapper.querySelector('#rpg-world-region');
    if (worldReg) worldReg.textContent = state.map?.region || 'Unknown Region';

    const landmarkList = wrapper.querySelector('#rpg-landmarks-list');
    if (landmarkList) {
        landmarkList.innerHTML = '';
        const marks = state.map?.landmarks || [];
        if (!marks.length) {
            landmarkList.innerHTML = '<li class="rpg-empty">No landmarks discovered.</li>';
        } else {
            const LANDMARK_ICONS = { dungeon: 'fa-dungeon', town: 'fa-city', city: 'fa-city', shrine: 'fa-place-of-worship', tavern: 'fa-mug-saucer', default: 'fa-map-pin' };
            for (const lm of marks) {
                const icon = LANDMARK_ICONS[lm.type] || LANDMARK_ICONS.default;
                const li = el('li', 'rpg-landmark-item');
                li.innerHTML = `<i class="fa-solid ${icon} rpg-landmark-icon"></i> <strong>${esc(lm.name)}</strong>${lm.note ? ` — <span class="rpg-npc-note">${esc(lm.note)}</span>` : ''}`;
                landmarkList.appendChild(li);
            }
        }
    }

    const travelLog = wrapper.querySelector('#rpg-travel-log');
    if (travelLog) {
        travelLog.innerHTML = '';
        const log = state.map?.travelLog || [];
        if (!log.length) {
            travelLog.appendChild(el('span', 'rpg-empty', { text: 'No travel history yet.' }));
        } else {
            const current = state.map?.currentLocation || '?';
            const entries = [current, ...log].slice(0, 10);
            for (let i = 0; i < entries.length; i++) {
                const row = el('div', 'rpg-travel-entry');
                if (i > 0) row.innerHTML += `<span class="rpg-travel-arrow">◀</span>`;
                row.innerHTML += `<span>${esc(entries[i])}</span>`;
                travelLog.appendChild(row);
            }
        }
    }

    // ── Journal ────────────────────────────────────────────────────────────
    const journalList = wrapper.querySelector('#rpg-journal-list');
    if (journalList) {
        journalList.innerHTML = '';
        const notes = state.notes || [];
        if (!notes.length) {
            journalList.appendChild(el('span', 'rpg-empty', { text: 'No journal entries yet.' }));
        } else {
            // Show most recent first
            for (const note of [...notes].reverse()) {
                const entry = el('div', `rpg-log-entry${note.text?.startsWith('[Parse Error') ? ' error' : ''}`);
                const meta = [
                    note.turn != null ? `Turn ${note.turn}` : '',
                    note.location || ''
                ].filter(Boolean).join(' · ');
                if (meta) entry.appendChild(el('div', 'rpg-log-meta', { text: meta }));
                entry.appendChild(el('div', '', { text: note.text || '' }));
                journalList.appendChild(entry);
            }
        }
    }

    
    // ── Story / Psyche (v5 stats) ─────────────────────────────────────────
    const goalEl = wrapper.querySelector('#rpg-active-goal');
    if (goalEl) goalEl.textContent = state.active_goal || 'None';

    const factsList = wrapper.querySelector('#rpg-facts-list');
    if (factsList) {
        factsList.innerHTML = '';
        if (!state.facts?.length) {
            factsList.innerHTML = '<span class="rpg-empty">No established facts.</span>';
        } else {
            for (const f of state.facts) {
                const elDiv = el('div', 'rpg-log-entry');
                elDiv.innerHTML = `<strong>${esc(f.priority === 'critical' ? '⚠️' : '📌')} ${esc(f.id)}:</strong> ${esc(f.text)}`;
                factsList.appendChild(elDiv);
            }
        }
    }

    const innerGrid = wrapper.querySelector('#rpg-inner-grid');
    if (innerGrid) {
        innerGrid.innerHTML = '';
        if (!state.charInner || !Object.keys(state.charInner).length) {
            innerGrid.innerHTML = '<span class="rpg-empty">No psychological data.</span>';
        } else {
            for (const [k, v] of Object.entries(state.charInner)) {
                const pill = el('span', 'rpg-pill');
                pill.innerHTML = `<strong>${esc(k)}</strong>: ${esc(String(v))}/100`;
                innerGrid.appendChild(pill);
            }
        }
    }

    const virList = wrapper.querySelector('#rpg-vir-list');
    if (virList) {
        virList.innerHTML = '';
        if (!state.vir || !Object.keys(state.vir).length) {
            virList.innerHTML = '<span class="rpg-empty">No VIR data.</span>';
        } else {
            for (const [name, traits] of Object.entries(state.vir)) {
                const card = el('div', 'rpg-item-card');
                card.innerHTML = `<strong>${esc(name)}</strong><br><span style="font-size:0.8em; opacity:0.8">${esc(traits.hair || '')} ${esc(traits.eyes || '')}</span>`;
                virList.appendChild(card);
            }
        }
    }
    
    // ── Macros bar ─────────────────────────────────────────────────────────
    const macroBar = wrapper.querySelector('#rpg-macros-bar');
    if (macroBar && macroBar.children.length === 0) {
        MacroManager.renderBar(macroBar, state.combat?.active);
    } else if (macroBar) {
        // Refresh macro visibility based on combat state
        macroBar.querySelectorAll('.rpg-macro-btn[data-combat-only="true"]').forEach(btn => {
            btn.style.display = state.combat?.active ? '' : 'none';
        });
    }

    // ── GM Edit listeners ──────────────────────────────────────────────────
    if (gmEdit) {
        wrapper.querySelectorAll('input.rpg-inline-input').forEach(inp => {
            inp.addEventListener('change', e => {
                const input = /** @type {HTMLInputElement} */ (e.target);
                const path = input.getAttribute('data-path');
                const val = parseFloat(input.value);
                if (!isNaN(val) && path) {
                    const parts = path.split('.');
                    let obj = StateManager.getState();
                    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
                    obj[parts[parts.length - 1]] = val;
                    StateManager.saveState();
                    scheduleRender();
                }
            });
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export const HudManager = {
    async init() {
        try {
            const res = await fetch(`/scripts/extensions/third-party/${EXT_NAME}/hud.html`);
            if (res.ok) htmlTemplate = await res.text();
        } catch (e) {
            console.error('[st-rpg-hud] Failed to load hud.html', e);
        }
    },

    // ✅ FIXED: HUD is injected AFTER .mes_text (sibling), not inside it.
    // This prevents it being destroyed when ST re-renders message text on swipe/edit.
    // It also doesn't conflict with JS-Slash-Runner iframes inside message content.
    inject(force = false) {
        if (!StateManager.isHudEnabled()) return;

        const chatBlocks = document.querySelectorAll('#chat .mes');
        if (!chatBlocks.length) return;

        // Find the last AI message block
        let targetBlock = null;
        for (let i = chatBlocks.length - 1; i >= 0; i--) {
            if (chatBlocks[i].getAttribute('is_user') !== 'true' &&
                chatBlocks[i].getAttribute('is_system') !== 'true') {
                targetBlock = chatBlocks[i];
                break;
            }
        }
        if (!targetBlock) return;

        // Remove all existing HUD instances
        document.querySelectorAll('.rpg-hud-wrapper').forEach(el => el.remove());

        // Build new wrapper
        const hudWrapper = document.createElement('div');
        hudWrapper.className = 'rpg-hud-wrapper';
        hudWrapper.id = 'rpg-hud-container';
        hudWrapper.innerHTML = htmlTemplate;

        // ✅ Block ST's swipe/drag handlers from consuming HUD events
        for (const ev of ['pointerdown', 'mousedown', 'touchstart']) {
            hudWrapper.addEventListener(ev, e => e.stopPropagation(), { passive: false });
        }

        // Insert AFTER the target message block (not inside .mes_text)
        targetBlock.insertAdjacentElement('afterend', hudWrapper);

        this._attachTabListeners(hudWrapper);
        this._attachSkillClickListeners(hudWrapper);
        scheduleRender();
    },

    render() {
        scheduleRender();
    },

    _attachTabListeners(wrapper) {
        const tabs   = wrapper.querySelectorAll('.rpg-hud-tab');
        const panels = wrapper.querySelectorAll('.rpg-hud-panel');

        tabs.forEach(tab => {
            // GM toggle special case
            if (tab.id === 'rpg-gm-toggle') {
                tab.addEventListener('click', () => {
                    Settings.globalOptions.gmEditMode = !Settings.globalOptions.gmEditMode;
                    tab.classList.toggle('active', Settings.globalOptions.gmEditMode);
                    StateManager.saveState();
                    scheduleRender();
                });
                tab.classList.toggle('active', !!Settings.globalOptions.gmEditMode);
                return;
            }

            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                panels.forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                const target = wrapper.querySelector(`#${tab.getAttribute('data-target')}`);
                if (target) target.classList.add('active');
            });
        });
    },

    _attachSkillClickListeners(wrapper) {
        // Event delegation — single listener on container, not per pill
        const skillsList = wrapper.querySelector('#rpg-skills-list');
        if (!skillsList) return;
        skillsList.addEventListener('click', e => {
            const pill = e.target.closest('.skill-pill');
            if (!pill) return;
            const id = pill.getAttribute('data-id');
            const skillName = pill.textContent?.replace(/Lv\d+/, '').trim() || id;
            // Queue skill use into send textarea
            const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
            if (textarea) {
                const prefix = textarea.value.trim() ? textarea.value + '\n' : '';
                textarea.value = prefix + `*[Player uses ${skillName}]*`;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }
};
