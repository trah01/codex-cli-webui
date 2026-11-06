// Limit the browser projection, never the authoritative journal or Codex log.
export const COMMAND_OUTPUT_LIMIT = 256 * 1024;

export function limitCommandOutput(item) {
  if (item?.type !== 'commandExecution') return item;
  let truncated = Boolean(item.outputTruncated);
  const trim = value => {
    const text = Array.isArray(value) ? value.join('\n') : value;
    if (typeof text !== 'string' || text.length <= COMMAND_OUTPUT_LIMIT) return value;
    truncated = true;
    return text.slice(-COMMAND_OUTPUT_LIMIT);
  };
  const aggregatedOutput = trim(item.aggregatedOutput);
  let output = item.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const text = trim(output.aggregatedOutput);
    if (text !== output.aggregatedOutput) output = { ...output, aggregatedOutput: text };
  } else output = trim(output);
  if (aggregatedOutput === item.aggregatedOutput && output === item.output && truncated === Boolean(item.outputTruncated)) return item;
  return { ...item, aggregatedOutput, output, outputTruncated: truncated };
}

function projectTurn(turn) {
  if (!turn?.items) return turn;
  const items = turn.items.map(limitCommandOutput);
  return items.every((item, index) => item === turn.items[index]) ? turn : { ...turn, items };
}

function projectThread(thread) {
  if (!thread?.turns) return thread;
  const turns = thread.turns.map(projectTurn);
  return turns.every((turn, index) => turn === thread.turns[index]) ? thread : { ...thread, turns };
}

export function projectSessionPatch(patch) {
  const next = { ...patch };
  if (patch.thread) next.thread = projectThread(patch.thread);
  if (patch.turn) next.turn = projectTurn(patch.turn);
  if (patch.delta?.type === 'commandExecution' && patch.delta.field === 'aggregatedOutput' && patch.delta.text.length > COMMAND_OUTPUT_LIMIT) {
    next.delta = { ...patch.delta, text: patch.delta.text.slice(-COMMAND_OUTPUT_LIMIT), outputTruncated: true };
  }
  return next;
}

export function projectSessionReply(reply) {
  if (reply.mode === 'snapshot') return { ...reply, snapshot: { ...reply.snapshot, thread: projectThread(reply.snapshot.thread) } };
  if (reply.mode === 'replay') return { ...reply, events: reply.events.map(event => ({ ...event, patch: projectSessionPatch(event.patch) })) };
  return reply;
}
