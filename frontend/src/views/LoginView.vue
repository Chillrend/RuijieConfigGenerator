<script setup>
import { useRoute } from 'vue-router'
import { getLoginUrl } from '../lib/auth'

const route = useRoute()
const error = route.query.error

const loginWithGoogle = () => {
  window.location.href = getLoginUrl()
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50">
    <div class="max-w-md w-full space-y-8 p-10 bg-white shadow rounded-xl">
      <div class="text-center">
        <h2 class="mt-6 text-3xl font-extrabold text-gray-900">
          Sign in to access
        </h2>
        <p class="mt-2 text-sm text-gray-600">
          Visual Switch Provisioner
        </p>
      </div>
      
      <div v-if="error === 'unauthorized'" class="bg-red-50 border-l-4 border-red-400 p-4 mb-4">
        <div class="flex">
          <div class="ml-3">
            <p class="text-sm text-red-700">
              Access denied. Your email is not authorized to use this application.
            </p>
          </div>
        </div>
      </div>

      <div class="mt-8 space-y-6">
        <button
          @click="loginWithGoogle"
          class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
        >
          <span class="absolute left-0 inset-y-0 flex items-center pl-3">
            <svg class="h-5 w-5 text-blue-500 group-hover:text-blue-400" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z"/>
            </svg>
          </span>
          Sign in with Google
        </button>
      </div>
    </div>
  </div>
</template>
