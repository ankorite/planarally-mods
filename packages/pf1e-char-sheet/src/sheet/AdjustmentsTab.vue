<script setup lang="ts">
// The Adjustments tab: buffs, conditions and the mutagens from the export, switched on and off (see
// adjustments.ts), and custom adjustments.
import { ref } from "vue";

import { BONUS_TYPES, BUILTIN_ADJUSTMENTS, describeEffects, TARGET_LABELS } from "../adjustments";
import type { AdjustmentEffect, AdjustmentState, AdjustmentTarget } from "../data";
import { usesLeft } from "../resources";

import { useSheet } from "./context";

const { data, macroStatus, flashMacroStatus, saveAndReexport, setUsesLeft } = useSheet();

const ADJUSTMENT_GROUPS = ["Spells", "Class abilities", "Combat", "Conditions"] as const;
const adjustmentGroups = ADJUSTMENT_GROUPS.map((group) => ({
    group,
    items: BUILTIN_ADJUSTMENTS.filter((a) => a.group === group),
}));

function adjustmentState(): AdjustmentState {
    data.value.adjustments ??= { enabled: [], custom: [] };
    return data.value.adjustments;
}

function isAdjustmentOn(key: string): boolean {
    return (data.value.adjustments?.enabled ?? []).includes(key);
}

/** Says whether the export's numbers already include a mutagen (when the guess at import was wrong). */
function setInExport(key: string, inExport: boolean): void {
    const adj = data.value.importedAdjustments?.find((a) => a.key === key);
    if (!adj) return;
    adj.inExport = inExport;
    saveAndReexport(`${adj.name}: ${inExport ? "counted as in" : "counted as not in"} the Hero Lab numbers.`);
}

function toggleAdjustment(key: string, name: string, on: boolean): void {
    const state = adjustmentState();
    state.enabled = state.enabled.filter((k) => k !== key);
    if (on) state.enabled.push(key);
    saveAndReexport(`${name} ${on ? "on" : "off"}.${on ? drinkDose(key) : ""}`);
}

/**
 * Switching on a mutagen drinks a dose: one use of its resource (Resources tab, and its tracker on the
 * token). Switching it off gives nothing back - the dose is gone. Returns a note for the status line.
 */
function drinkDose(key: string): string {
    const adj = data.value.importedAdjustments?.find((a) => a.key === key);
    const r = adj?.resource ? data.value.resources?.find((x) => x.key === adj.resource) : undefined;
    if (!r) return "";
    const left = usesLeft(r);
    if (left <= 0) return " No doses left on the Resources tab.";
    setUsesLeft(r, left - 1);
    return ` Drank a dose: ${left - 1} left.`;
}

const newAdjName = ref("");
const newAdjEffects = ref<AdjustmentEffect[]>([{ target: "attack", type: "untyped", value: 1 }]);
const ADJUSTMENT_TARGETS = Object.keys(TARGET_LABELS) as AdjustmentTarget[];

function addNewEffectRow(): void {
    newAdjEffects.value.push({ target: "attack", type: "untyped", value: 1 });
}

function addCustomAdjustment(): void {
    const name = newAdjName.value.trim();
    const effects = newAdjEffects.value.filter((e) => Number.isFinite(e.value) && e.value !== 0);
    if (!name || !effects.length) {
        flashMacroStatus("Give the adjustment a name and at least one non-zero effect.");
        return;
    }
    const state = adjustmentState();
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    state.custom.push({ id, name, effects: effects.map((e) => ({ ...e })) });
    state.enabled.push(id);
    newAdjName.value = "";
    newAdjEffects.value = [{ target: "attack", type: "untyped", value: 1 }];
    saveAndReexport(`${name} added and switched on.`);
}

function removeCustomAdjustment(id: string, name: string): void {
    const state = adjustmentState();
    state.custom = state.custom.filter((a) => a.id !== id);
    state.enabled = state.enabled.filter((k) => k !== id);
    saveAndReexport(`${name} removed.`);
}
</script>

<template>
    <div class="pf1e-panel">
        <div class="readonly-note">
            Ticked adjustments are added to this sheet's numbers, its roll buttons and the token's dice macros,
            following PF1 stacking (same-type bonuses don't stack; dodge, circumstance and untyped do). Export from Hero
            Lab with its own adjustments switched <strong>off</strong>, or they count twice.
            <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
        </div>

        <template v-if="data.importedAdjustments?.length">
            <h4>From Hero Lab</h4>
            <div class="readonly-note">
                Mutagens and class abilities from the export. One that was active in Hero Lab is already in the imported
                numbers: leave it ticked while it lasts, and untick it when it wears off. Ticking a mutagen drinks a
                dose (one use on the Resources tab).
            </div>
            <div class="adjustment-list">
                <div v-for="adj of data.importedAdjustments" :key="adj.key" class="adjustment">
                    <input
                        type="checkbox"
                        :checked="isAdjustmentOn(adj.key)"
                        @change="toggleAdjustment(adj.key, adj.name, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="adj-name">{{ adj.name }}</span>
                    <span class="adj-effects">{{ describeEffects(adj.effects) }}</span>
                    <label class="adj-in-export">
                        <input
                            type="checkbox"
                            :checked="adj.inExport"
                            @change="setInExport(adj.key, ($event.target as HTMLInputElement).checked)"
                        />
                        active in the export
                    </label>
                </div>
            </div>
        </template>

        <template v-for="g of adjustmentGroups" :key="g.group">
            <h4>{{ g.group }}</h4>
            <div class="adjustment-list">
                <label v-for="adj of g.items" :key="adj.key" class="adjustment">
                    <input
                        type="checkbox"
                        :checked="isAdjustmentOn(adj.key)"
                        @change="toggleAdjustment(adj.key, adj.name, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="adj-name">{{ adj.name }}</span>
                    <span class="adj-effects">{{ describeEffects(adj.effects, adj.extraAttack) }}</span>
                </label>
            </div>
        </template>

        <h4>Custom</h4>
        <div v-if="data.adjustments?.custom.length" class="adjustment-list">
            <div v-for="adj of data.adjustments.custom" :key="adj.id" class="adjustment">
                <input
                    type="checkbox"
                    :checked="isAdjustmentOn(adj.id)"
                    @change="toggleAdjustment(adj.id, adj.name, ($event.target as HTMLInputElement).checked)"
                />
                <span class="adj-name">{{ adj.name }}</span>
                <span class="adj-effects">{{ describeEffects(adj.effects) }}</span>
                <button type="button" @click="removeCustomAdjustment(adj.id, adj.name)">Remove</button>
            </div>
        </div>
        <div class="custom-adjustment-form">
            <input v-model="newAdjName" type="text" placeholder="Name, e.g. Aid or Weapon Focus" />
            <div v-for="(eff, i) of newAdjEffects" :key="i" class="effect-row">
                <input v-model.number="eff.value" type="number" class="effect-value" />
                <select v-model="eff.type">
                    <option v-for="t of BONUS_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
                <select v-model="eff.target">
                    <option v-for="t of ADJUSTMENT_TARGETS" :key="t" :value="t">{{ TARGET_LABELS[t] }}</option>
                </select>
                <button v-if="newAdjEffects.length > 1" type="button" @click="newAdjEffects.splice(i, 1)">✕</button>
            </div>
            <div class="hp-push-row">
                <button type="button" @click="addNewEffectRow">Add effect</button>
                <button type="button" @click="addCustomAdjustment">Add adjustment</button>
            </div>
        </div>
    </div>
</template>
