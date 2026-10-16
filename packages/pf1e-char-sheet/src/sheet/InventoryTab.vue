<script setup lang="ts">
// The Inventory tab: Hero Lab's gear and magic items.
import { useSheet } from "./context";

const { data } = useSheet();
</script>

<template>
    <div class="pf1e-panel">
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Qty</th>
                        <th>Weight</th>
                        <th>Notes</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(item, i) of data.inventory" :key="i">
                        <td>{{ item.name }}</td>
                        <td>{{ item.quantity }}</td>
                        <td>{{ item.weight }}</td>
                        <td>{{ item.notes }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>
