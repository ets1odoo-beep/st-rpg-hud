# ST RPG HUD

A dynamic, tabbed role-playing game heads-up display for SillyTavern. It tracks stats, party members, quests, inventory, relationships, and dynamic mini-maps persistently, keeping your chat interface perfectly clean while managing complex RPG mechanics under the hood using invisible AI-generated XML blocks.

## Features
- **Clean Chat UI:** XML tags (`<RPG-HUD>...</RPG-HUD>`) are safely stripped and hidden out of your chat interface for true prose immersion.
- **Performance Optimized:** Bounded parsing on tail-end messages and tiered LLM injection tracking guarantees optimal response speeds with heavily reduced token overhead (≤ 200 overhead tokens per turn).
- **Extensive Tracking:** Overview vitals, active skills, outfit/paper-doll slot allocations, multi-value relationship matrices (Trust, Affection, Rivalry, etc), NPC map locations, and an active turn/log manager.
- **Dynamic Minimap:** A fully active HTML5 Canvas map tracking the `Current Room/Zone`, Fog of War mapping, and relational (Hostile/Ally) NPC dots.
- **In-Chat Interactions:** D20 Dice-Roll Overlay popup interrupts, Click-to-Use staged actions for Items and Spells, HUD Macros (`[Attack]`, `[Defend]`), and more.
- **Fail-safe Engine:** Smart recovery parsing for when the AI truncates early or hits limits without destroying context.

---

## 1. How to Enable the HUD
The RPG HUD requires explicit activation per-chat. This guarantees zero resource bleeding into your non-RPG standard chats.
1. In SillyTavern, open the top-left **Extensions** menu (the block/puzzle piece icon).
2. Scroll through the panel and expand the **ST RPG HUD** accordion.
3. Check the **Enable for Current Chat** toggle to inject the HUD interface frame. When disabled, the engine powers off fully for the current story session.

## 2. Setting Up the AI (System Prompt)
The AI needs to know the "rules of the game" for generating proper state tags. Included in this extension folder is a highly optimized ruleset.
1. Locate `system-prompt.md` inside this extension's directory.
2. Copy the text block inside.
3. Paste it directly into your SillyTavern character's **System Prompt / Post-History** override box, OR drop it into a **Lorebook Entry** with "Constant" insertion toggled on. 
> *Tip: GLM-4, Kimi K2, and strong Claude/GPT logic models excel at mapping and adhering to this JSON/XML rule engine out of the box.*

## 3. Configuration & Tuning
Inside the ST RPG HUD Extensions Panel, you have several configuration tuning sliders:
* **Context Budget Depth:** Adjusts exactly where in the ST `Combine Prompts` pipeline we insert context to map priorities logic. Standard defaults to `4`. Adjust this up or down if it's conflicting with other pipeline enhancers (like Megumin-Suite).
* **Audio SFX Toggle:** Un-mute occasional dynamic audio-cues (e.g., Level ups, Quest acceptances).
* **GM Edit Mode:** The AI is smart, but sometimes gets confused or hallucinates a number. Toggling `GM Edit Mode` enables an inline "Pencil" button across the HUD allowing you to force-override fields directly via keyboard inputs to save the state structure natively.

## 4. UI Actions & Controls
A fresh HUD frame attaches to the bottom of the *latest* chat frame every time a generation successfully parses. 
* **Tabs Navigation:** Swap freely between `Overview`, `Skills`, `Inventory`, `Party`, `Quests`, `NPCs`, `Map`, and `Log` without forcing visual reflows. 
* **Using Elements:** In `Inventory` and `Skills`, tapping an active "Pill" item stages an intent directly into your chat box window (ex: `*[Player] uses Health Potion*`).
* **Active Statuses:** Hover your mouse over any glowing purple 'status' pill in the UI menus to read its specific mechanical debuffs/buffs via CSS-tooltips.
* **Macros:** Simply click the generated macro actions (e.g. `[Flee]` or `[Search]`) below the chat frame to rapidly pace intense combat scenes!

## 5. Cross-Extension Synergies
The ST RPG HUD automatically shares Global Variables with the popular **ST-Outfits** extension. If an AI triggers `<ITEM action="equip" slot="headwear" name="Iron Helmet">`, the HUD natively reaches across SillyTavern's variables and updates your graphical ST-Outfits overlay to match immediately!
