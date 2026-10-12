import { modOptions } from "@planarally/mod-api/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type UserConfig } from "vite";

export default defineConfig(
    ({ command }) =>
        modOptions(command, { name: "Pf1eCharSheet", port: 5278, root: import.meta.dirname, vue }) as UserConfig,
);
