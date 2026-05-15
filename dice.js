// ─────────────────────────────────────────────────────────────────────────────
// dice.js — Dice roll overlay + RNG engine
// ─────────────────────────────────────────────────────────────────────────────

import { StateManager } from './state.js';

const DIE_SIDES = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100: 100 };

let _pendingCheck = null;
let _spinInterval = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export const DiceManager = {
    init() {
        // Listen for CHECK tag events dispatched by parser.js
        document.addEventListener('rpg-hud-dice-check', (e) => {
            const { stat, dc, modifier, type } = e.detail || {};
            this.showCheckOverlay(stat, parseInt(dc) || 10, parseInt(modifier) || 0, type);
        });
    },

    roll(sides = 20) {
        return Math.floor(Math.random() * sides) + 1;
    },

    rollWithAdvantage(sides = 20) {
        return Math.max(this.roll(sides), this.roll(sides));
    },

    rollWithDisadvantage(sides = 20) {
        return Math.min(this.roll(sides), this.roll(sides));
    },

    // ── Get stat modifier from attributes ───────────────────────────────────
    getStatModifier(statId) {
        if (!statId) return 0;
        const id = statId.toLowerCase();
        const state = StateManager.getState();
        const attr = state.attributes?.[id];
        if (!attr) return 0;
        // D&D style: floor((value - 10) / 2)
        return Math.floor((attr.value - 10) / 2);
    },

    // ── Show CHECK overlay ──────────────────────────────────────────────────
    showCheckOverlay(stat, dc, modifier, type) {
        // Remove any existing overlay
        document.querySelector('#rpg-dice-overlay')?.remove();

        // Determine stat modifier from character sheet
        const statMod = this.getStatModifier(stat) || modifier || 0;
        const modStr = statMod >= 0 ? `+${statMod}` : `${statMod}`;

        const overlay = document.createElement('div');
        overlay.id = 'rpg-dice-overlay';
        overlay.className = 'rpg-dice-overlay';
        overlay.innerHTML = `
            <div class="rpg-dice-modal">
                <div class="rpg-dice-title">
                    <i class="fa-solid fa-dice-d20"></i> ${stat ? `${stat.toUpperCase()} Check` : 'Dice Roll'}
                </div>
                <div class="rpg-dice-sub">DC ${dc} · Modifier: ${modStr}</div>
                <div class="rpg-dice-result spinning" id="rpg-dice-num">—</div>
                <div class="rpg-dice-verdict" id="rpg-dice-verdict">Roll the die…</div>
                <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
                    <button class="menu_button" id="rpg-roll-normal">🎲 Roll d20</button>
                    <button class="menu_button" id="rpg-roll-adv">⬆ Advantage</button>
                    <button class="menu_button" id="rpg-roll-dis">⬇ Disadvantage</button>
                </div>
                <div style="margin-top:12px;">
                    <label style="font-size:11px;color:var(--hud-muted);">Other dice:&nbsp;</label>
                    ${Object.keys(DIE_SIDES).map(d =>
                        `<button class="menu_button rpg-other-die" data-sides="${DIE_SIDES[d]}" style="padding:4px 8px;font-size:11px;">${d}</button>`
                    ).join('')}
                </div>
            </div>`;

        document.body.appendChild(overlay);

        // Close overlay on backdrop click
        overlay.addEventListener('click', e => {
            if (e.target === overlay) this.closeOverlay(overlay);
        });

        const numEl = overlay.querySelector('#rpg-dice-num');
        const verdictEl = overlay.querySelector('#rpg-dice-verdict');

        // Start spinning placeholder
        let spinTick = 0;
        _spinInterval = setInterval(() => {
            if (numEl) numEl.textContent = String(Math.floor(Math.random() * 20) + 1);
        }, 80);

        const executeRoll = (rollFn) => {
            clearInterval(_spinInterval);
            const raw = rollFn();
            const total = raw + statMod;
            const success = total >= dc;

            if (numEl) {
                numEl.textContent = `${raw}${statMod !== 0 ? ` (${total})` : ''}`;
                numEl.classList.remove('spinning');
                numEl.classList.add(success ? 'success' : 'failure');
            }
            if (verdictEl) {
                verdictEl.textContent = success ? `✓ Success! (${total} ≥ DC ${dc})` : `✗ Failure (${total} < DC ${dc})`;
                verdictEl.style.color = success ? 'var(--hud-success)' : 'var(--hud-danger)';
            }

            // Inject result into the user's text field
            setTimeout(() => {
                const resultText = `[Dice Roll: ${raw}${statMod >= 0 ? '+' : ''}${statMod !== 0 ? statMod : ''} = ${total} vs DC ${dc} → ${success ? 'SUCCESS' : 'FAILURE'}]`;
                this._injectResult(resultText);
                // Auto-close after delay
                setTimeout(() => this.closeOverlay(overlay), 800);
            }, 400);
        };

        overlay.querySelector('#rpg-roll-normal')?.addEventListener('click', () =>
            executeRoll(() => this.roll(20)));
        overlay.querySelector('#rpg-roll-adv')?.addEventListener('click', () =>
            executeRoll(() => this.rollWithAdvantage(20)));
        overlay.querySelector('#rpg-roll-dis')?.addEventListener('click', () =>
            executeRoll(() => this.rollWithDisadvantage(20)));
        overlay.querySelectorAll('.rpg-other-die').forEach(btn => {
            btn.addEventListener('click', () => {
                const sides = parseInt(btn.getAttribute('data-sides') || '20');
                executeRoll(() => this.roll(sides));
            });
        });
    },

    closeOverlay(overlay) {
        clearInterval(_spinInterval);
        if (overlay) overlay.remove();
    },

    // ─── ✅ FIXED: was using "\\n" (literal backslash-n) — now injects actual newline
    _injectResult(text) {
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
        if (!textarea) return;
        const existing = textarea.value.trim();
        textarea.value = existing ? `${existing}\n${text}` : text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
};
