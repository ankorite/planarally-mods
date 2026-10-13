import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// Unit tests (src/__tests__). Separate from vite.config.ts, whose shared mod setup also runs a dev server.
export default defineConfig({
    plugins: [vue()],
    test: {
        environment: "happy-dom",
        include: ["src/**/__tests__/*.test.ts"],
    },
});
