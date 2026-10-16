import type { GameApi } from "@planarally/mod-api";
import { computed, onBeforeUnmount, ref } from "vue";

import type { FeatEntry } from "../data";
import { openRule, ruleRegistered, ruleText, type RuleKind } from "../rules";

// Rule cards: the styled hover / click popover for skills, feats, spells and specials.
//
// A card of the sheet's own (rather than the browser's plain title tooltip): the name, a details line
// or two, and the rules text in paragraphs with "Benefit:"-style labels in bold. It follows the mouse
// on hover; a click pins it, so long text can be scrolled, and offers PlanarAlly's compendium page
// when the rule is registered there. RuleCardPopup.vue shows it.

export interface RuleCard {
    title: string;
    meta: string[];
    body: string;
    rule?: { kind: RuleKind; name: string };
}

export function featCard(feat: FeatEntry): RuleCard {
    return {
        title: feat.name,
        meta: feat.category ? [feat.category] : [],
        body: feat.fullText || ruleText("feat", feat.name) || feat.description,
        rule: { kind: "feat", name: feat.name },
    };
}

/** The card's paragraphs: split on blank lines (and before "Benefit:"-style lines), labels pulled out. */
export function cardParagraphs(text: string): { label: string; text: string }[] {
    return text
        .split(/\n\s*\n|\n(?=[A-Z][\w ()'/,-]{1,40}:\s)/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
            const m = /^([A-Z][\w ()'/,-]{1,40}):\s+/.exec(p);
            return m ? { label: m[1]!, text: p.slice(m[0].length) } : { label: "", text: p };
        });
}

// How long the mouse has to rest on a name before its card appears on hover (a click shows it at once).
// Set on the Config tab; it is a preference of whoever is looking, so it is kept per browser like the
// sheet width, not with the character.
const CARD_DELAY_KEY = "pf1e-sheet-card-delay";
const CARD_DELAY_DEFAULT_S = 2;
export const CARD_DELAY_MAX_S = 10;

function loadCardDelay(): number {
    try {
        const saved = Number(localStorage.getItem(CARD_DELAY_KEY));
        if (localStorage.getItem(CARD_DELAY_KEY) !== null && Number.isFinite(saved)) {
            return Math.min(CARD_DELAY_MAX_S, Math.max(0, saved));
        }
    } catch {
        /* storage unavailable: the default */
    }
    return CARD_DELAY_DEFAULT_S;
}

/** The rule card's state and actions, for one sheet; call from the sheet's setup. */
export function createRuleCards(api: GameApi) {
    const card = ref<(RuleCard & { x: number; y: number; pinned: boolean; note?: string }) | null>(null);
    let cardHideTimer: ReturnType<typeof setTimeout> | undefined;
    let cardShowTimer: ReturnType<typeof setTimeout> | undefined;

    /** Seconds before a hover card appears. */
    const cardDelay = ref(loadCardDelay());

    function setCardDelay(event: Event): void {
        const input = event.target as HTMLInputElement;
        const value = input.valueAsNumber;
        cardDelay.value = Number.isFinite(value)
            ? Math.min(CARD_DELAY_MAX_S, Math.max(0, value))
            : CARD_DELAY_DEFAULT_S;
        input.value = String(cardDelay.value);
        try {
            localStorage.setItem(CARD_DELAY_KEY, String(cardDelay.value));
        } catch {
            /* not remembered; applies for now anyway */
        }
    }

    function showCard(c: RuleCard, event: MouseEvent): void {
        if (card.value?.pinned) return;
        clearTimeout(cardHideTimer);
        clearTimeout(cardShowTimer);
        const { clientX: x, clientY: y } = event;
        // Moving from one name to the next while a card is already showing swaps it straight away.
        if (card.value) {
            card.value = { ...c, x, y, pinned: false };
            return;
        }
        cardShowTimer = setTimeout(() => {
            if (!card.value?.pinned) card.value = { ...c, x, y, pinned: false };
        }, cardDelay.value * 1000);
    }

    function hideCard(): void {
        clearTimeout(cardShowTimer);
        if (!card.value || card.value.pinned) return;
        clearTimeout(cardHideTimer);
        // A short delay, so the mouse can move onto the card itself (to scroll it) without it vanishing.
        cardHideTimer = setTimeout(() => {
            if (card.value && !card.value.pinned) card.value = null;
        }, 150);
    }

    function keepCard(): void {
        clearTimeout(cardHideTimer);
    }

    /** A click pins the card - unless it was on a control (a Track checkbox, a button) inside the row. */
    function pinCard(c: RuleCard, event: MouseEvent): void {
        if ((event.target as HTMLElement | null)?.closest("input, label, button")) return;
        clearTimeout(cardHideTimer);
        clearTimeout(cardShowTimer);
        card.value = { ...c, x: event.clientX, y: event.clientY, pinned: true };
    }

    function closeCard(): void {
        clearTimeout(cardShowTimer);
        card.value = null;
    }

    onBeforeUnmount(() => {
        clearTimeout(cardShowTimer);
        clearTimeout(cardHideTimer);
    });

    const cardStyle = computed(() => {
        const c = card.value;
        if (!c) return {};
        const width = Math.min(380, window.innerWidth - 16);
        return {
            width: `${width}px`,
            left: `${Math.max(8, Math.min(c.x + 14, window.innerWidth - width - 8))}px`,
            top: `${Math.max(8, Math.min(c.y + 14, window.innerHeight - 340))}px`,
        };
    });

    const cardInCompendium = computed(() => {
        const r = card.value?.rule;
        return r !== undefined && ruleRegistered(r.kind, r.name);
    });

    async function openCardInCompendium(event: MouseEvent): Promise<void> {
        const r = card.value?.rule;
        if (!r) return;
        const result = await openRule(api, r.kind, r.name, event);
        if (result.ok) card.value = null;
        else if (card.value) card.value.note = `Couldn't open it: ${result.reason}.`;
    }

    return {
        card,
        cardDelay,
        setCardDelay,
        showCard,
        hideCard,
        keepCard,
        pinCard,
        closeCard,
        cardStyle,
        cardInCompendium,
        openCardInCompendium,
    };
}

export type RuleCards = ReturnType<typeof createRuleCards>;
