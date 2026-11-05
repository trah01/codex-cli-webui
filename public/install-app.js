if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => { /* Registration can retry on the next visit. */ });
}
