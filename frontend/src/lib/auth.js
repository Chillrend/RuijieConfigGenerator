import { reactive } from 'vue';

// We use relative paths for the API. In development, Vite will proxy `/api` to `http://localhost:3001`.
// In production (Docker), the API is served from the same origin, so relative paths work perfectly.
const API_BASE = '';

export const authState = reactive({
  isAuthenticated: false,
  user: null,
  initialized: false
});

export const checkAuth = async () => {
  // Dev mode bypass
  if (import.meta.env.VITE_DISABLE_AUTH === 'true' && import.meta.env.DEV) {
    authState.isAuthenticated = true;
    authState.user = { id: 'dev', email: 'dev@localhost', name: 'Dev User' };
    authState.initialized = true;
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      credentials: 'include'
    });
    if (res.ok) {
      const data = await res.json();
      authState.isAuthenticated = true;
      authState.user = data.user;
    } else {
      authState.isAuthenticated = false;
      authState.user = null;
    }
  } catch (err) {
    authState.isAuthenticated = false;
    authState.user = null;
  } finally {
    authState.initialized = true;
  }
};

export const logout = async () => {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include'
    });
  } catch (e) {}
  authState.isAuthenticated = false;
  authState.user = null;
  // Let component handle redirect
};

export const getLoginUrl = () => {
  return `${API_BASE}/api/auth/google`;
};
