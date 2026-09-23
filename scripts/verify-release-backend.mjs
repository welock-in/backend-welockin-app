// Read-only production contract check using the existing Vercel build credentials.
// No provider secrets, account lists, email addresses or tokens are logged.
import { readFileSync } from 'node:fs';
const API = 'https://app.connect.welock.in';
if (process.env.WINDOWS_RELEASE_VERSION === '0.3.48') {
  try {
    const expected = JSON.parse(readFileSync(new URL('./releases/windows-0.3.48.json', import.meta.url), 'utf8'));
    const get = async (path, options = {}) => {
      const response = await fetch(`${API}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return response.json();
    };
    if (process.env.VERCEL_ENV !== 'production' || !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) throw new Error('CONFIGURATION_UNAVAILABLE');
    const login = await get('/api/admin/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD}) });
    if (typeof login.token !== 'string' || !login.token) throw new Error('AUTHENTICATION_FAILED');
    const headers = {Authorization:`Bearer ${login.token}`};
    const [health, db, config, offers] = await Promise.all([
      get('/api/health'), get('/api/health/db'), get('/api/health/config',{headers}), get('/api/admin/signup-lifetime',{headers}),
    ]);
    if (health.ok !== true || db.db !== 'ok') throw new Error('HEALTH_FAILED');
    if (!expected.backendSourceSha || config.commit !== expected.backendSourceSha.slice(0,7)) throw new Error('BACKEND_COMMIT_MISMATCH');
    if (offers.settings?.iosSignupLifetimeEnabled !== false || offers.settings?.desktopSignupLifetimeEnabled !== false) throw new Error('SIGNUP_OFFERS_NOT_OFF');
    console.log(JSON.stringify({check:'production-backend',success:true,commit:config.commit,iosSignupLifetimeEnabled:false,desktopSignupLifetimeEnabled:false,receiptsEnabled:config.entitlement?.receiptsEnabled,enforcementEnabled:config.entitlement?.enforced}));
  } catch (error) {
    const safe = /^(HTTP_\d+|CONFIGURATION_UNAVAILABLE|AUTHENTICATION_FAILED|HEALTH_FAILED|BACKEND_COMMIT_MISMATCH|SIGNUP_OFFERS_NOT_OFF)$/.test(error?.message ?? '') ? error.message : 'PRODUCTION_CHECK_FAILED';
    console.error(safe);
    process.exitCode = 1;
  }
}
