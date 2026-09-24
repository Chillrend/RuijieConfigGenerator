<script setup>
import { RouterView, RouterLink, useRoute, useRouter } from 'vue-router'
import { computed } from 'vue'
import { authState, logout } from './lib/auth'

const route = useRoute()
const router = useRouter()

const navLinks = [
  { name: 'Provision Switch', path: '/' },
  { name: 'Deployments History', path: '/history' }
]

const handleLogout = async () => {
  await logout()
  router.push('/login')
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground pb-10 print:bg-white print:text-black">
    <!-- Header / Nav -->
    <header v-if="authState.isAuthenticated" class="border-b px-5 py-4 mb-6 print:hidden">
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

        <div class="flex items-center gap-4">
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

          <div v-if="authState.user" class="flex items-center gap-3 ml-4 pl-4 border-l">
            <img v-if="authState.user.avatar" :src="authState.user.avatar" alt="Avatar" class="w-7 h-7 rounded-full border shadow-sm" />
            <span class="text-sm font-medium hidden sm:block">{{ authState.user.name }}</span>
            <button @click="handleLogout" class="text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 rounded transition-colors ml-2">
              Logout
            </button>
          </div>
        </div>
      </div>
    </header>

    <!-- Main Content Area -->
    <RouterView />
  </div>
</template>
