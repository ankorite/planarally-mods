import type { PF1Character } from "../data";

/** The Config tab's lists of hidden things (SheetConfig). */
export type ConfigList = "hiddenWeapons" | "hiddenSkills" | "hiddenSections" | "hiddenTabs";

/** Whether the Config tab hides `name` (a weapon, skill, sheet section or tab). */
export function isHiddenIn(c: PF1Character, list: ConfigList, name: string): boolean {
    return (c.sheetConfig?.[list] as string[] | undefined)?.includes(name) ?? false;
}
