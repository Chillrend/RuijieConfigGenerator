import { createRouter, createWebHistory } from 'vue-router'
import ProvisionerView from '../views/ProvisionerView.vue'
import HistoryView from '../views/HistoryView.vue'
import LoginView from '../views/LoginView.vue'
import { authState, checkAuth } from '../lib/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { requiresGuest: true }
    },
    {
      path: '/',
      name: 'home',
      component: ProvisionerView,
      meta: { requiresAuth: true }
    },
    {
      path: '/history',
      name: 'history',
      component: HistoryView,
      meta: { requiresAuth: true }
    }
  ]
})

router.beforeEach(async (to, from, next) => {
  if (to.meta.requiresAuth || to.meta.requiresGuest) {
    if (!authState.initialized) {
      await checkAuth();
    }
  }

  if (to.meta.requiresAuth && !authState.isAuthenticated) {
    next({ name: 'login' });
  } else if (to.meta.requiresGuest && authState.isAuthenticated) {
    next({ name: 'home' });
  } else {
    next();
  }
});

export default router
