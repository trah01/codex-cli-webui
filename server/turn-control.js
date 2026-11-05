import { bridgeErrorCode, THREAD_NOT_FOUND } from '../public/bridge-errors.js';

export async function interruptThread(request, params) {
  if (typeof params.threadId !== 'string' || !params.threadId || typeof params.turnId !== 'string' || !params.turnId) throw new Error('Invalid active turn');
  try { return await request('turn/interrupt', params); }
  catch (error) {
    if (bridgeErrorCode(error) !== THREAD_NOT_FOUND) throw error;
    // A thread opened from history may not be loaded in this app-server yet.
    await request('thread/resume', { threadId: params.threadId });
    return request('turn/interrupt', params);
  }
}
