<script setup>
import { RouterView, RouterLink, useRoute } from 'vue-router'
import { computed } from 'vue'

const route = useRoute()

const navLinks = [
  { name: 'Provision Switch', path: '/' },
  { name: 'Deployments History', path: '/history' }
]
</script>

<template>
  <div class="min-h-screen bg-background text-foreground pb-10 print:bg-white print:text-black">
    <!-- Header / Nav -->
    <header class="border-b px-5 py-4 mb-6 print:hidden">
      <div class="max-w-[1200px] mx-auto flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold text-xs shadow-md">
            SW
          </div>
          <div class="leading-tight">
            <h1 class="text-base font-semibold">Visual Switch Provisioner</h1>
            <p class="text-xs text-muted-foreground">Ruijie CLI Configuration</p>
          </div>
        </div>

        <nav class="flex gap-1 bg-muted p-1 rounded-md">
          <RouterLink
            v-for="link in navLinks"
            :key="link.path"
            :to="link.path"
            class="px-3 py-1.5 text-sm font-medium rounded-sm transition-colors"
            :class="route.path === link.path ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'"
          >
            {{ link.name }}
          </RouterLink>
        </nav>
      </div>
    </header>

    <!-- Main Content Area -->
    <RouterView />
  </div>
</template>
