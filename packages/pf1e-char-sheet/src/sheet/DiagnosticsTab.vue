<script setup lang="ts">
// The Diagnostics tab (DM only): read-only reports on the sheet and PlanarAlly's mod API (see
// diagnostics.ts). Each report replaces the previous one; Copy puts it on the clipboard for a bug report.
import { ref } from "vue";

import { buildApiDump, buildHealthCheck } from "../diagnostics";
import { api } from "../main";

import { useSheet } from "./context";

const { data, currentLocalId } = useSheet();

const diagOutput = ref("");
const diagBusy = ref(false);
const diagTextarea = ref<HTMLTextAreaElement>();
const diagCopyStatus = ref("");

async function runDiag(fn: () => Promise<string>): Promise<void> {
    if (diagBusy.value) return;
    diagBusy.value = true;
    diagOutput.value = "";
    try {
        diagOutput.value = await fn();
    } catch (e) {
        diagOutput.value = `Report failed: ${String(e)}`;
    } finally {
        diagBusy.value = false;
    }
}

async function copyDiag(): Promise<void> {
    const text = diagOutput.value;
    try {
        // The async clipboard API only exists on secure contexts (https / localhost); a dev
        // server reached by plain http://ip:port won't have it, so fall back to selecting the
        // textarea and using the legacy copy command.
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            diagTextarea.value?.focus();
            diagTextarea.value?.select();
            document.execCommand("copy");
        }
        diagCopyStatus.value = "Copied.";
    } catch {
        diagCopyStatus.value = "Copy failed - click in the box, Ctrl+A, Ctrl+C.";
    }
    setTimeout(() => (diagCopyStatus.value = ""), 4000);
}
</script>

<template>
    <div class="pf1e-panel">
        <div class="readonly-note">Both reports are read-only. Copy the output into a bug report.</div>

        <div class="diag-buttons">
            <button
                type="button"
                :disabled="diagBusy"
                title="Checks the API functions the sheet uses, this token's HP tracker, Custom Data, roll formulas and auras"
                @click="runDiag(() => buildHealthCheck(api, currentLocalId, data))"
            >
                Health check
            </button>
            <button
                type="button"
                :disabled="diagBusy"
                title="Everything PlanarAlly's mod API exposes, plus a scan of PlanarAlly's code. Large; for when an update breaks something"
                @click="runDiag(() => buildApiDump(api, currentLocalId))"
            >
                Full API dump
            </button>
        </div>

        <div class="diag-buttons">
            <button type="button" :disabled="!diagOutput" @click="copyDiag">Copy</button>
            <button type="button" @click="diagOutput = ''">Clear</button>
            <span v-if="diagBusy" class="hp-push-status">working...</span>
            <span v-if="diagCopyStatus" class="hp-push-status">{{ diagCopyStatus }}</span>
        </div>
        <textarea ref="diagTextarea" class="diag-output" readonly :value="diagOutput"></textarea>
    </div>
</template>
