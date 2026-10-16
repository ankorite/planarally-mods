<script setup lang="ts">
// The rule card itself (see ruleCards.ts). It is teleported to <body>: a dialog's transform would
// otherwise offset its fixed position.
import { rulesReady } from "../rules";

import { useSheet } from "./context";
import { cardParagraphs } from "./ruleCards";

const { card, cardStyle, keepCard, hideCard, closeCard, cardInCompendium, openCardInCompendium } = useSheet().cards;
</script>

<template>
    <Teleport to="body">
        <div
            v-if="card"
            id="pf1e-rule-card"
            :class="{ pinned: card.pinned }"
            :style="cardStyle"
            @mouseenter="keepCard"
            @mouseleave="hideCard"
        >
            <div class="rc-head">
                <strong>{{ card.title }}</strong>
                <button v-if="card.pinned" type="button" title="Close" @click="closeCard">✕</button>
            </div>
            <div v-for="(m, i) of card.meta" :key="i" class="rc-meta">{{ m }}</div>
            <div class="rc-body">
                <p v-for="(p, i) of cardParagraphs(card.body)" :key="i">
                    <strong v-if="p.label">{{ p.label }}:</strong> {{ p.text }}
                </p>
                <p v-if="!card.body" class="rc-empty">No rules text in this import.</p>
            </div>
            <div class="rc-foot">
                <span v-if="card.note" class="rc-note">{{ card.note }}</span>
                <button
                    v-if="card.pinned && card.rule && rulesReady"
                    type="button"
                    :title="
                        cardInCompendium
                            ? 'Open this rule\'s page in the compendium'
                            : 'Not found in the compendium yet'
                    "
                    @click="openCardInCompendium"
                >
                    Open in compendium
                </button>
                <span v-if="!card.pinned">Click to pin</span>
            </div>
        </div>
    </Teleport>
</template>
