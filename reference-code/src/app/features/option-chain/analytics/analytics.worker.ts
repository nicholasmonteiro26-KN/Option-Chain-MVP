/// <reference lib="webworker" />
import { analyzeChain } from '@option-analytics/analyze';
import type { FromWorker, ToWorker } from './protocol';

addEventListener('message', ({ data }: MessageEvent<ToWorker>) => {
  let reply: FromWorker;
  try {
    reply = { v: 1, kind: 'result', id: data.id, chain: data.chain, result: analyzeChain(data.input) };
  } catch (e) {
    reply = { v: 1, kind: 'error', id: data.id, chain: data.chain, message: e instanceof Error ? e.message : String(e) };
  }
  postMessage(reply);
});
