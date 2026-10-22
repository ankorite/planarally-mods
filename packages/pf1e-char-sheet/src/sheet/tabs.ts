// The sheet's tabs. "Sheet" is the paper-style front page (abilities, combat, saves, weapons, skills);
// "Token" has what acts on the token itself (auras, Custom Data, the HP push).

export const BASE_TABS = [
    "Sheet",
    "Spells",
    "Resources",
    "Adjustments",
    "Feats",
    "Specials",
    "Inventory",
    "Token",
    "Config",
] as const;

/** A monster's or NPC's (DM-only) sheet: no Feats or Inventory tab. */
export const LIMITED_TABS = ["Sheet", "Spells", "Resources", "Adjustments", "Specials", "Token", "Config"] as const;

/** Tabs the Config tab can hide (the Sheet, Config and Diagnostics tabs always show). */
export const HIDEABLE_TABS: readonly string[] = [
    "Spells",
    "Resources",
    "Adjustments",
    "Feats",
    "Specials",
    "Inventory",
    "Token",
];

export type TabName = (typeof BASE_TABS)[number] | "Diagnostics";
