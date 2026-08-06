'use strict';

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[2]) : null;
}

function safeNextPath() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next') || '/';
  // Only allows relative paths within the site itself (avoids open redirect).
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

const form = document.getElementById('login-form');
const errorMsg = document.getElementById('error-msg');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorMsg.textContent = '';
  const password = document.getElementById('password').value;
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCookie('fp_csrf') || '',
      },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.href = safeNextPath();
      return;
    }
    if (res.status === 429) {
      errorMsg.textContent = 'Too many attempts. Try again shortly.';
    } else {
      errorMsg.textContent = 'Incorrect password.';
    }
  } catch (e) {
    errorMsg.textContent = 'Connection error. Try again.';
  } finally {
    submitBtn.disabled = false;
  }
});
