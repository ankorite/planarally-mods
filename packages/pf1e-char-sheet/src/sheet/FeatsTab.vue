<script setup lang="ts">
// The Feats tab: each feat with its excerpt; its rule card on hover or click.
import { useSheet } from "./context";
import { featCard } from "./ruleCards";

const { data, cards } = useSheet();
const { showCard, hideCard, pinCard } = cards;
</script>

<template>
    <div class="pf1e-panel">
        <ul class="feat-list">
            <li
                v-for="(feat, i) of data.feats"
                :key="i"
                class="hover-info"
                @mouseenter="showCard(featCard(feat), $event)"
                @mouseleave="hideCard"
                @click="pinCard(featCard(feat), $event)"
            >
                <strong>{{ feat.name }}</strong>
                <span v-if="feat.category" class="special-source">{{ feat.category }}</span>
                <div class="hint">{{ feat.description }}</div>
            </li>
        </ul>
    </div>
</template>
