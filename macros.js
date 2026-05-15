// ─────────────────────────────────────────────────────────────────────────────
// macros.js — Configurable quick-action buttons
// ─────────────────────────────────────────────────────────────────────────────

import { Settings } from './state.js';

// ─────────────────────────────────────────────────────────────────────────────
// Default macros — user can override these via Settings panel
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_MACROS = [
    { name: 'Attack',  icon: '⚔️',  text: '*Player attacks!*',          combatOnly: true  },
    { name: 'Defend',  icon: '🛡️',  text: '*Player takes a defensive stance.*', combatOnly: true  },
    { name: 'Flee',    icon: '🏃',  text: '*Player attempts to flee!*',  combatOnly: true  },
    { name: 'Search',  icon: '🔍',  text: '*Player carefully searches the area.*', combatOnly: false },
    { name: 'Rest',    icon: '🏕️',  text: '*Player rests to recover.*',  combatOnly: false },
    { name: 'Talk',    icon: '💬',  text: '*Player tries to talk.*',     combatOnly: false }
];

function getMacros() {
    if (!Settings.globalOptions?.macros?.length) {
        Settings.globalOptions.macros = JSON.parse(JSON.stringify(DEFAULT_MACROS));
    }
    return Settings.globalOptions.macros;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export const MacroManager = {
    getMacros,

    renderBar(container, inCombat = false) {
        if (!container) return;
        container.innerHTML = '';

        const macros = getMacros();
        const anyVisible = macros.some(m => inCombat || !m.combatOnly);

        if (!anyVisible) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        for (const macro of macros) {
            // Hide combat-only macros outside combat
            if (macro.combatOnly && !inCombat) continue;

            const btn = document.createElement('button');
            btn.className = 'rpg-macro-btn';
            btn.setAttribute('data-combat-only', String(!!macro.combatOnly));
            btn.innerHTML = `${macro.icon || ''} ${macro.name}`;
            btn.title = macro.text;

            btn.addEventListener('click', () => {
                this.executeMacro(macro);
            });

            container.appendChild(btn);
        }
    },

    executeMacro(macro) {
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
        if (!textarea) return;
        const existing = textarea.value.trim();
        textarea.value = existing ? `${existing}\n${macro.text}` : macro.text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    },

    // ── Settings panel UI for macro editing ───────────────────────────────
    buildSettingsUI(container) {
        if (!container) return;
        container.innerHTML = `
            <div class="rpg-section-heading"><i class="fa-solid fa-bolt"></i> Quick Macros</div>
            <div id="rpg-macro-list"></div>
            <button class="menu_button" id="rpg-add-macro" style="margin-top:8px;">
                <i class="fa-solid fa-plus"></i> Add Macro
            </button>`;

        const list = container.querySelector('#rpg-macro-list');
        const macros = getMacros();

        const renderList = () => {
            list.innerHTML = '';
            for (let i = 0; i < macros.length; i++) {
                const m = macros[i];
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px;';
                row.innerHTML = `
                    <input type="text" value="${m.icon || ''}" placeholder="Icon" style="width:38px;" class="text_pole" />
                    <input type="text" value="${m.name}" placeholder="Name" style="flex:0.6;" class="text_pole" />
                    <input type="text" value="${m.text}" placeholder="Action text" style="flex:1;" class="text_pole" />
                    <label style="display:flex;align-items:center;gap:4px;font-size:11px;">
                        <input type="checkbox" ${m.combatOnly ? 'checked' : ''} /> Combat only
                    </label>
                    <button class="menu_button" data-del="${i}" style="padding:4px 8px;"><i class="fa-solid fa-trash"></i></button>`;

                const [iconInp, nameInp, textInp] = row.querySelectorAll('input[type="text"]');
                const cbInp = row.querySelector('input[type="checkbox"]');

                iconInp.addEventListener('change', () => { macros[i].icon = iconInp.value; _save(); });
                nameInp.addEventListener('change', () => { macros[i].name = nameInp.value; _save(); });
                textInp.addEventListener('change', () => { macros[i].text = textInp.value; _save(); });
                cbInp.addEventListener('change', () => { macros[i].combatOnly = cbInp.checked; _save(); });

                row.querySelector(`[data-del="${i}"]`)?.addEventListener('click', () => {
                    macros.splice(i, 1);
                    _save();
                    renderList();
                });

                list.appendChild(row);
            }
        };

        const _save = () => {
            Settings.globalOptions.macros = macros;
            import('./state.js').then(m => m.StateManager.saveState());
        };

        container.querySelector('#rpg-add-macro')?.addEventListener('click', () => {
            macros.push({ name: 'New Macro', icon: '✨', text: '*Player does something.*', combatOnly: false });
            _save();
            renderList();
        });

        renderList();
    }
};
