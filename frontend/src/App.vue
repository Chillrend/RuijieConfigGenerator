<script setup>
import { RouterView, RouterLink, useRoute, useRouter } from 'vue-router'
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { authState, logout } from './lib/auth'

const route = useRoute()
const router = useRouter()

const navLinks = [
  { name: 'Provision', fullName: 'Provision Switch', path: '/', icon: 'carbon:settings-check' },
  { name: 'Fleet', fullName: 'Fleet Management', path: '/fleet', icon: 'carbon:network-4' },
  { name: 'Scanner', fullName: 'Scan Code', path: '/scanner', icon: 'carbon:qr-code' },
  { name: 'History', fullName: 'Deployments History', path: '/history', icon: 'carbon:time' }
]

const isLinkActive = (path) => {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}

const handleLogout = async () => {
  await logout()
  router.push('/login')
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground pb-20 md:pb-10 print:bg-white print:text-black">
    <!-- Header / Nav -->
    <header v-if="authState.isAuthenticated" class="border-b px-4 sm:px-6 py-3 mb-4 sm:mb-6 bg-card/60 backdrop-blur print:hidden sticky top-0 z-40">
      <div class="max-w-[1240px] mx-auto flex items-center justify-between gap-3">
        <!-- Logo & Title -->
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold text-xs shadow-xs shrink-0">
            SW
          </div>
          <div class="leading-tight truncate">
            <h1 class="text-sm sm:text-base font-semibold truncate">Visual Switch Provisioner</h1>
            <p class="text-[11px] text-muted-foreground hidden sm:block">Ruijie CLI & Fleet Management</p>
          </div>
        </div>

        <!-- Desktop Navigation Tabs (>= md) -->
        <div class="hidden md:flex items-center gap-4">
          <nav class="flex gap-1 bg-muted/80 p-1 rounded-lg">
            <RouterLink
              v-for="link in navLinks"
              :key="link.path"
              :to="link.path"
              class="px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-all flex items-center gap-1.5"
              :class="isLinkActive(link.path) ? 'bg-background shadow-xs text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'"
            >
              <Icon :icon="link.icon" class="w-4 h-4 shrink-0" />
              <span>{{ link.fullName }}</span>
            </RouterLink>
          </nav>
        </div>

        <!-- User profile & Logout -->
        <div v-if="authState.user" class="flex items-center gap-2 sm:gap-3 shrink-0">
          <img v-if="authState.user.avatar" :src="authState.user.avatar" alt="Avatar" class="w-7 h-7 rounded-full border shadow-xs" />
          <span class="text-xs sm:text-sm font-medium hidden lg:inline-block max-w-[120px] truncate">{{ authState.user.name }}</span>
          <button
            @click="handleLogout"
            class="text-xs font-medium text-rose-500 hover:text-rose-700 bg-rose-500/10 hover:bg-rose-500/20 px-2.5 py-1.5 rounded-md transition-colors flex items-center gap-1"
            title="Log out"
          >
            <Icon icon="carbon:logout" class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Mobile Bottom Navigation Bar (< md) -->
    <nav
      v-if="authState.isAuthenticated"
      class="md:hidden fixed bottom-0 inset-x-0 z-50 bg-card/95 backdrop-blur-md border-t border-border/80 px-2 py-1.5 flex items-center justify-around shadow-lg"
    >
      <RouterLink
        v-for="link in navLinks"
        :key="link.path"
        :to="link.path"
        class="flex flex-col items-center justify-center flex-1 py-1 px-1 rounded-lg transition-colors text-center"
        :class="isLinkActive(link.path) ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground'"
      >
        <div
          class="p-1 rounded-md transition-colors"
          :class="isLinkActive(link.path) ? 'bg-primary/10' : ''"
        >
          <Icon :icon="link.icon" class="w-5 h-5 shrink-0" />
        </div>
        <span class="text-[10px] tracking-tight mt-0.5 leading-none">{{ link.name }}</span>
      </RouterLink>
    </nav>

    <!-- Main Content Area -->
    <RouterView />
  </div>
</template>
