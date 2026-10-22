<script setup lang="ts">
// The Config tab: what this sheet shows (saved with the character), and this browser's preferences
// (the rule card delay, the natural 20 / 1 animation).
import { computed, ref } from "vue";

import { critFxEnabled, playCrit, setCritFxEnabled } from "../crits";
import { SHEET_SECTIONS } from "../data";

import { isHiddenIn, type ConfigList } from "./config";
import { useSheet } from "./context";
import { CARD_DELAY_MAX_S } from "./ruleCards";
import { BASE_TABS, HIDEABLE_TABS, LIMITED_TABS } from "./tabs";

const { data, isCharacter, macroStatus, flashMacroStatus, save, saveAndReexport, cards } = useSheet();
const { cardDelay, setCardDelay } = cards;

function isHidden(list: ConfigList, name: string): boolean {
    return isHiddenIn(data.value, list, name);
}

/** Shows or hides one thing. Weapons and skills also leave the dice macros, so those re-export. */
function setShown(list: ConfigList, name: string, shown: boolean, label = name): void {
    const config = (data.value.sheetConfig ??= {});
    const rest = ((config[list] as string[] | undefined) ?? []).filter((n) => n !== name);
    (config[list] as string[]) = shown ? rest : [...rest, name];
    const message = `${label}: ${shown ? "shown" : "hidden"}.`;
    if (list === "hiddenWeapons" || list === "hiddenSkills") saveAndReexport(message);
    else {
        save();
        flashMacroStatus(message);
    }
}

/** Hides every skill without ranks (or shows every skill again). */
function hideSkillsWithoutRanks(hide: boolean): void {
    const config = (data.value.sheetConfig ??= {});
    config.hiddenSkills = hide ? data.value.skills.filter((s) => s.ranks <= 0).map((s) => s.name) : [];
    saveAndReexport(hide ? "Skills without ranks hidden." : "All skills shown.");
}

const configTabs = computed(() =>
    (isCharacter.value ? BASE_TABS : LIMITED_TABS).filter((t) => HIDEABLE_TABS.includes(t)),
);

/** Whether this browser plays the natural 20 / 1 animation. */
const critFx = ref(critFxEnabled());
function setCritFx(on: boolean): void {
    critFx.value = on;
    setCritFxEnabled(on);
    if (on) playCrit("nat20", "Preview", "this is how a natural 20 looks");
}
</script>

<template>
    <div class="pf1e-panel">
        <div class="readonly-note">
            Choose what this sheet shows; the choices are saved with the character and kept when you re-import. A hidden
            weapon or skill is also left out of PlanarAlly's dice macros.
            <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
        </div>

        <h4>Sheet sections</h4>
        <div class="config-list">
            <label v-for="[key, label] of SHEET_SECTIONS" :key="key">
                <input
                    type="checkbox"
                    :checked="!isHidden('hiddenSections', key)"
                    @change="setShown('hiddenSections', key, ($event.target as HTMLInputElement).checked, label)"
                />
                {{ label }}
            </label>
        </div>

        <h4>Weapons</h4>
        <div v-if="data.combat.attacks.length" class="config-list">
            <label v-for="(atk, i) of data.combat.attacks" :key="i">
                <input
                    type="checkbox"
                    :checked="!isHidden('hiddenWeapons', atk.name)"
                    @change="setShown('hiddenWeapons', atk.name, ($event.target as HTMLInputElement).checked)"
                />
                {{ atk.name }} <span class="hint">{{ atk.bonus }} · {{ atk.damage }}</span>
            </label>
        </div>
        <div v-else class="readonly-note">No weapons in the Hero Lab export.</div>

        <h4>Skills</h4>
        <div class="hp-push-row">
            <button type="button" @click="hideSkillsWithoutRanks(true)">Hide skills without ranks</button>
            <button type="button" @click="hideSkillsWithoutRanks(false)">Show all skills</button>
        </div>
        <div class="config-list columns">
            <label v-for="skill of data.skills" :key="skill.name">
                <input
                    type="checkbox"
                    :checked="!isHidden('hiddenSkills', skill.name)"
                    @change="setShown('hiddenSkills', skill.name, ($event.target as HTMLInputElement).checked)"
                />
                {{ skill.name }}
            </label>
        </div>

        <h4>Rule cards</h4>
        <div class="config-list">
            <label>
                Show a rule card after hovering a skill, feat, spell or special for
                <input
                    class="delay-input"
                    type="number"
                    min="0"
                    :max="CARD_DELAY_MAX_S"
                    step="0.5"
                    :value="cardDelay"
                    @change="setCardDelay"
                />
                seconds
            </label>
            <span class="hint"
                >0 shows it at once. Saved for this browser, for every sheet; clicking a name always shows its
                card.</span
            >
        </div>

        <h4>Natural 20 / natural 1</h4>
        <div class="config-list">
            <label>
                <input
                    type="checkbox"
                    :checked="critFx"
                    @change="setCritFx(($event.target as HTMLInputElement).checked)"
                />
                Play an animation when any d20 roll comes up a natural 20 or a natural 1
            </label>
            <span class="hint"
                >Any d20 roll you see - the dice panel, rolls shared with you, this sheet's rolls. Saved for this
                browser.</span
            >
        </div>

        <h4>Tabs</h4>
        <div class="config-list">
            <label v-for="tab of configTabs" :key="tab">
                <input
                    type="checkbox"
                    :checked="!isHidden('hiddenTabs', tab)"
                    @change="setShown('hiddenTabs', tab, ($event.target as HTMLInputElement).checked, `${tab} tab`)"
                />
                {{ tab }}
            </label>
        </div>
    </div>
</template>
