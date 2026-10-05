import { resolve } from "path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue()],
    define: {
        "process.env": {},
    },
    build: {
        minify: false,
        lib: {
            entry: resolve(__dirname, "src/main.ts"),
            name: "Pf1eCharSheet",
            fileName: "index",
            formats: ["es"],
        },
        rollupOptions: {
            // Avoid bundling vue with the mod itself; PA exposes Vue globally.
            external: ["vue"],
            output: {
                globals: { vue: "Vue" },
                assetFileNames: "[name].[ext]",
            },
        },
    },
});
